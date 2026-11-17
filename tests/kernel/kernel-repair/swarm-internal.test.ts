import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../kernel/src/kernel/index.ts";
import { runtimeOf } from "../../../kernel/src/kernel/runtime.ts";
import { envelopeShape } from "../../../kernel/src/kernel/validation/result.ts";
import { envelope } from "./envelope-fixture.ts";
import { neverRuns } from "./handlers.ts";
import { contractUnchecked } from "./harness.ts";
import { patternShow } from "./swarm-commands.ts";
import { emptyInput, unchanged } from "./shapes.ts";

test("K2-6: envelopeShape, typed `value is Envelope`, checks diagnostics", () => {
  const available = {
    status: "available",
    file: null,
    sinkFailure: null,
    droppedRecords: 0,
    unflushedRecords: 0,
    truncatedRecords: 0,
    countsComplete: true,
    closed: true,
  };
  expect(envelopeShape(envelope(null))).toBe(true);
  expect(envelopeShape({ ...envelope(null), diagnostics: available })).toBe(
    true,
  );
  for (const diagnostics of [
    "not a diagnostics object",
    { ...available, status: "invented" },
    { ...available, droppedRecords: -1 },
  ])
    expect(envelopeShape({ ...envelope(null), diagnostics })).toBe(false);
});

test("K2-12: a fault inside validation after the snapshot propagates instead of blaming the external value", async () => {
  const defect = new TypeError("Deliberate defect inside a validation step.");
  let armed = false;
  const target = {
    commandIdentity: "specimen.target",
    route: ["target"],
    summary: "Target.",
    effectClass: "inspect",
    stations: [],
    capabilities: {},
    get input() {
      if (armed) throw defect;
      return emptyInput;
    },
    execute: neverRuns,
  };
  const step = {
    kind: "command",
    command: "specimen.target",
    args: [],
  } as const;
  const read = station(commonCauses, {
    commandIdentity: "specimen.read",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read.",
    guidance: { next: step },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "swarm-internal",
  });
  const source = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    stations: [read],
    run: (_input, context) =>
      context.result(read, {
        message: "Read.",
        data: null,
        effects: unchanged,
      }),
  });
  const contract = contractUnchecked(contractFor, {
    cli: "specimen",
    commands: [source, target],
  });
  const runtime =
    typeof contract === "object" && contract !== null
      ? runtimeOf(contract)
      : undefined;
  if (!runtime) throw new Error("No validate.");
  const value = {
    ...envelope(null),
    availablePaths: ["specimen.read"],
    result: { ...envelope(null).result, next: step },
  };
  expect(await runtime.validate(value)).toMatchObject({
    ok: true,
  });
  armed = true;
  let rejection: unknown = "resolved";
  try {
    await runtime.validate(value);
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBe(defect);
  armed = false;
  const hostile = {
    ...value,
    get message() {
      throw new Error("Hostile getter.");
    },
  };
  expect(await runtime.validate(hostile)).toEqual({
    ok: false,
    path: "$",
    reason: "not plain bounded JSON",
  });
});

test("F2.one-shot-entry: the handler entry a check phase returns runs once", async () => {
  const contract = contractFor({ cli: "x", commands: [patternShow("a|b")] });
  const runtime = runtimeOf(contract);
  if (!runtime) throw new Error("No runtime.");
  const prepared = await runtime.prepare("x.show", ["a"], "run-once", {});
  if (!prepared.ok) throw new Error("Expected a handler entry.");
  const attached = prepared.value();
  if (!attached.ok) throw new Error("Expected the attach to succeed.");
  expect(await attached.value()).toMatchObject({ ok: true });
  expect(prepared.value()).toEqual({
    ok: false,
    path: "entry",
    reason: "handler entry already used",
  });
});
