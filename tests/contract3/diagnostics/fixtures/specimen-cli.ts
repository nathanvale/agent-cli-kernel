import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  command,
  contractFor,
  runProcess,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { empty, input, none, plain, readData } from "./declarations.ts";
import type { JsonValue } from "../../../../starters/contract3/src/kernel/index.ts";
import { diagnosticsAddon } from "../../../../starters/contract3/src/addons/diagnostics/index.ts";
import type { StatusAddon } from "../../../../starters/contract3/src/addons/diagnostics/index.ts";
import { programsAddon } from "../../../../starters/contract3/src/addons/programs/index.ts";
import { createDiagnostics } from "../../../../starters/contract3/src/addons/diagnostics/run.ts";
import { faultIo } from "./fault-io.ts";

type Script = {
  readonly records?: number | undefined;
  readonly size?: number | undefined;
  readonly depth?: number | undefined;
  readonly keys?: number | undefined;
  readonly secretFacts?: boolean;
  readonly tasks?: number | undefined;
  readonly hostile?: boolean;
  readonly limitForms?: boolean;
  readonly crash?: boolean;
  readonly pace?: boolean;
  readonly throwAfter?: boolean;
  readonly hold?: {
    readonly after: number;
    readonly ready: string;
    readonly go: string;
  };
};

function script(): Script {
  const raw: unknown = JSON.parse(process.env.DXS_SCRIPT ?? "{}");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("DXS_SCRIPT must be an object.");
  const read = (key: string): unknown => Reflect.get(raw, key);
  const number = (key: string) => {
    const value = read(key);
    return typeof value === "number" ? value : undefined;
  };
  const hold = read("hold");
  const field = (key: string) => {
    const value: unknown =
      typeof hold === "object" && hold !== null
        ? Reflect.get(hold, key)
        : undefined;
    return typeof value === "string" || typeof value === "number"
      ? value
      : undefined;
  };
  const after = field("after");
  const ready = field("ready");
  const go = field("go");
  return {
    records: number("records"),
    size: number("size"),
    depth: number("depth"),
    keys: number("keys"),
    tasks: number("tasks"),
    secretFacts: read("secretFacts") === true,
    hostile: read("hostile") === true,
    limitForms: read("limitForms") === true,
    crash: read("crash") === true,
    pace: read("pace") === true,
    throwAfter: read("throwAfter") === true,
    ...(typeof after === "number" &&
    typeof ready === "string" &&
    typeof go === "string"
      ? { hold: { after, ready, go } }
      : {}),
  };
}

function nested(depth: number): JsonValue {
  let value: JsonValue = "bottom";
  for (let level = 0; level < depth; level += 1)
    value = { level, inner: value };
  return value;
}

function wide(keys: number): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (let index = 0; index < keys; index += 1) result[`k${index}`] = index;
  return result;
}

function hostile(facts: JsonValue): JsonValue {
  const value: Record<string, JsonValue> = {};
  Object.defineProperty(value, "boom", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  void facts;
  return value;
}

async function held(path: string) {
  const until = Date.now() + 60_000;
  while (!existsSync(path)) {
    if (Date.now() > until) process.exit(70);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function typedForm(token: string | undefined): JsonValue {
  if (token === "true" || token === "false") return token === "true";
  const number = Number(token);
  return token !== undefined &&
    Number.isFinite(number) &&
    String(number) === token
    ? number
    : null;
}

function contentsOf(path: string | undefined): string | null {
  if (path === undefined) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

type Recorder = { readonly record: (event: string, facts: JsonValue) => void };

async function perform(
  diagnostics: Recorder,
  parsed: { readonly "--token"?: string; readonly "--token-file"?: string },
) {
  const plan = script();
  const records = plan.records ?? 1;
  const pad = "x".repeat(plan.size ?? 16);
  const secrets: Record<string, JsonValue> = plan.secretFacts
    ? {
        note: parsed["--token"] ?? null,
        token: parsed["--token"] ?? null,
        contents: contentsOf(parsed["--token-file"]),
        environment: process.env.DXS_TOKEN ?? null,
        sentence: `the value ${parsed["--token"] ?? ""} appears in prose`,
        typed: typedForm(parsed["--token"]),
        nested: { inner: [typedForm(parsed["--token"])] },
      }
    : {};
  const marker = parsed["--token"] ?? "";
  const limitForms: Record<string, JsonValue> = plan.limitForms
    ? {
        encoded: Buffer.from(marker).toString("base64"),
        split: [marker.slice(0, 6), marker.slice(6)],
      }
    : {};
  const tasks = Math.max(1, plan.tasks ?? 1);
  let issued = 0;
  async function worker(task: number) {
    while (issued < records) {
      const index = issued;
      issued += 1;
      if (plan.hold && index === plan.hold.after) {
        writeFileSync(plan.hold.ready, "ready");
        await held(plan.hold.go);
      }
      const facts: JsonValue = {
        index,
        task,
        pad,
        ...(plan.depth === undefined ? {} : { deep: nested(plan.depth) }),
        ...(plan.keys === undefined ? {} : { wide: wide(plan.keys) }),
        ...secrets,
        ...limitForms,
      };
      diagnostics.record("step", plan.hostile ? hostile(facts) : facts);
      if (plan.pace) await new Promise((resolve) => setTimeout(resolve, 0));
      else if (tasks > 1) await Promise.resolve();
    }
    if (plan.hold && plan.hold.after >= records) {
      writeFileSync(plan.hold.ready, "ready");
      await held(plan.hold.go);
    }
  }
  await Promise.all(Array.from({ length: tasks }, (_, task) => worker(task)));
  if (plan.crash) process.abort();
  if (plan.throwAfter)
    throw new Error("specimen handler fault after recording");
  return records;
}

const read = command({
  identity: "dxs.read",
  route: ["read"],
  summary: "Read specimen data while recording diagnostics.",
  input,
  capabilities: { diagnostics: true },
  run: async (parsed, context) => {
    const records = await perform(context.diagnostics, parsed);
    return context.result(
      { commandIdentity: "dxs.read", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read specimen data.",
        data: readData(records),
        effects: empty,
      },
    );
  },
});

const spawn = command({
  identity: "dxs.spawn",
  route: ["spawn"],
  summary: "Run one child program while recording diagnostics.",
  input: none,
  capabilities: { programs: true, diagnostics: true },
  run: async (_input, context) => {
    const marker = process.env.DXS_CHILD_MARKER ?? "child-marker";
    const result = await context.programs.inspect({
      executable: contract.boundary.path("/bin/sh"),
      args: [
        "-c",
        `printf '%s\\n' "${marker}"; printf '%s\\n' "${marker}" >&2`,
      ],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4096,
      shutdownMilliseconds: 200,
    });
    context.diagnostics.record("program", { exitCode: result.exitCode });
    return context.result(
      { commandIdentity: "dxs.spawn", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Ran the specimen program.",
        data: { exitCode: result.exitCode },
        effects: empty,
      },
    );
  },
});

const contract = contractFor({
  cli: "dxs",
  commands: [read, plain, spawn],
  installedAddons: ["programs", "diagnostics"],
});

const argv = process.argv.slice(2);
const options = {
  cli: "dxs",
  environment: process.env,
  argv,
  secrets: {
    options: ["--token"],
    fileOptions: ["--token-file"],
    environment: ["DXS_TOKEN"],
  },
} as const;
const fault = process.env.DXS_FAULT;
const addon: StatusAddon =
  fault === undefined
    ? diagnosticsAddon(options)
    : createDiagnostics(options, faultIo(fault));

await runProcess(contract, {
  addons: { diagnostics: addon, programs: programsAddon() },
})(argv);
