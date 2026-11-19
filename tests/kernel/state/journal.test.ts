import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  at,
  caseTest,
  closeArgs,
  eventsPath,
  expectCompleted,
  expectRefusedUnchanged,
  formatRecord,
  framed,
  journals,
  makeWorld,
  str,
  supportingTest,
  versionOneReader,
  versionTwoStore,
  writeSyntheticOperation,
} from "./harness.ts";
import type { Json, Started, World } from "./harness.ts";
import { holdLock } from "./holder.ts";
import { layout } from "../../../kernel/src/addons/state/store.ts";

const apply = (name: string, content = "v1") => [
  "apply",
  name,
  "--content",
  content,
  "--json",
];

async function within(
  options: { readonly qualification?: "fixture" },
  body: (world: World) => Promise<void>,
): Promise<void> {
  const world = makeWorld(options);
  try {
    await body(world);
  } finally {
    world.dispose();
  }
}
const plain = (body: (world: World) => Promise<void>) => () => within({}, body);
const fixture = (body: (world: World) => Promise<void>) => () =>
  within({ qualification: "fixture" }, body);

function eventKinds(world: World, id: string): readonly string[] {
  const operation = world.operations().find((entry) => entry.id === id);
  return operation ? operation.events.records.map((record) => record.kind) : [];
}
function flipLastPayloadByte(path: string): void {
  const bytes = readFileSync(path);
  const index = bytes.length - 3;
  bytes[index] = (bytes[index] ?? 0) ^ 1;
  writeFileSync(path, bytes);
}

caseTest(
  "J01.a-intent-durable-before-effect",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const [operation, ...rest] = world.operations();
    expect(rest).toEqual([]);
    if (!operation) throw new Error("No operation.");
    const intent = operation.intent;
    expect(intent.operationId).toBe(operation.id);
    expect(operation.id).toMatch(/^op-[0-9a-f]{32}$/);
    expect(intent.commandIdentity).toBe("sx.apply");
    expect(typeof intent.runId).toBe("string");
    expect(intent.effects).toEqual(["note.write"]);
    expect(at(intent, "scope", "unknown")).toBe(false);
    const keys = at(intent, "scope", "keys");
    expect(
      Array.isArray(keys) &&
        keys.some((key) => typeof key === "string" && key.startsWith("name:")),
    ).toBe(true);
    expect(intent.revisions).toEqual({ "note:a": "observed" });
    expect(intent.approval).toBeNull();
    expect(JSON.stringify(intent)).not.toMatch(/secret|token|password|grant/i);
    expect(operation.events.records.map((record) => record.kind)).toEqual([
      "effect-started",
    ]);
    expect(world.noteLedger("a")).toBe(0);
    expect(await world.pendingIds()).toEqual([operation.id]);
  }),
);

caseTest(
  "J01.b-fault-after-intent-never-completed",
  plain(async (world) => {
    const run = await world.run(apply("a"), { SX_FAULT: "write-fails" });
    expect(run.result.causeCode).toBe("DOMAIN_SX_CHANGE_UNKNOWN");
    expect(run.result.transactionState).toBe("unknown");
    expect(at(run.result.raw, "effects", "uncertain")).toEqual(["note.write"]);
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(eventKinds(world, operation.id)).not.toContain("completion");
    expect(await world.pendingIds()).toEqual([operation.id]);
  }),
);

caseTest(
  "J01.c-crash-before-publication",
  plain(async (world) => {
    await world.killAt(apply("a"), "staged");
    expect(world.operations()).toEqual([]);
    expect(world.noteLedger("a")).toBe(0);
    expect(await world.pendingIds()).toEqual([]);
    expectCompleted(await world.run(apply("a")));
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "J02.a-readback-false-no-completion",
  plain(async (world) => {
    const run = await world.run(apply("a"), { SX_FAULT: "wrong-content" });
    expect(run.result.causeCode).not.toBe("SUCCESS_COMPLETED");
    expect(run.result.transactionState).toBe("unknown");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(eventKinds(world, operation.id)).toEqual([
      "effect-started",
      "effect-unconfirmed",
      "outcome",
    ]);
    expect(at(operation.events.records[1]?.payload, "reason")).toBe(
      "read-back-false",
    );
  }),
);

caseTest(
  "J02.b-valid-twin-completes",
  plain(async (world) => {
    const run = await world.run(apply("a"));
    expectCompleted(run);
    expect(at(run.result.raw, "effects")).toEqual({
      completed: ["note.write"],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    });
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(eventKinds(world, operation.id)).toEqual([
      "effect-started",
      "effect-confirmed",
      "completion",
    ]);
    expect(readFileSync(world.note("a"), "utf8")).toBe("v1");
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "J03.a-silent-no-op",
  plain(async (world) => {
    const run = await world.run(apply("a"), { SX_FAULT: "silent" });
    expect(run.result.outcome).not.toBe("success");
    expect(at(run.result.raw, "effects", "completed")).toEqual([]);
    expect(at(run.result.raw, "effects", "uncertain")).toEqual(["note.write"]);
    expect(world.ledger()).toEqual([]);
  }),
);

caseTest(
  "J04.a-torn-completion",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 7));
    expect(world.operations()[0]?.events.torn).toBe(true);
    expect(await world.pendingIds()).toEqual([operation.id]);
    const history = await world.history(operation.id);
    expect(at(history.result.raw, "data", "status")).toBe("unresolved");
    expect(at(history.result.raw, "data", "journal", "tornTail")).toBe(true);
  }),
);

caseTest(
  "J04.b-checksum-completion",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const text = readFileSync(path, "utf8");
    const last = text.lastIndexOf('"note.write"');
    expect(last).toBeGreaterThan(text.lastIndexOf("C3S1 completion"));
    writeFileSync(
      path,
      `${text.slice(0, last)}"note.writf"${text.slice(last + 12)}`,
    );
    expect(world.operations()[0]?.events.torn).toBe(true);
    expect(await world.pendingIds()).toEqual([operation.id]);
  }),
);

caseTest(
  "J04.c-corrupt-intent-refuses",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    flipLastPayloadByte(join(world.root, "operations", operation.id, "intent"));
    const report = await world.run(["pending", "--json"]);
    expectRefusedUnchanged(report, "SCHEMA_SX_STATE_UNREADABLE", 4);
    expect(at(report.result.raw, "data")).toBeNull();
  }),
);

caseTest(
  "J04.d-torn-closure",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const revision = await world.revision(operation.id);
    const close = (closureId: string) =>
      world.run([
        "close",
        operation.id,
        "--disposition",
        "completed",
        "--closure-id",
        closureId,
        "--revision",
        revision,
        "--reason",
        "read back present",
        "--json",
      ]);
    expectCompleted(await close("c1"));
    const path = join(world.root, "operations", operation.id, "closure");
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 5));
    expect(await world.pendingIds()).toEqual([operation.id]);
    expect(
      at(
        (await world.history(operation.id)).result.raw,
        "data",
        "closureDamaged",
      ),
    ).toBe(true);
    expectRefusedUnchanged(await close("c2"), "DOMAIN_SX_CLOSE_CONFLICT");
    expect(readFileSync(path)).toEqual(bytes.subarray(0, bytes.length - 5));
  }),
);

caseTest(
  "J04.e-corrupt-middle-record-refuses",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const bytes = readFileSync(path);
    const firstEnd = bytes.indexOf(10, bytes.indexOf(10) + 1);
    bytes[firstEnd - 2] = (bytes[firstEnd - 2] ?? 0) ^ 1;
    writeFileSync(path, bytes);
    expect(world.operations()[0]?.events.corrupt).toBe(true);
    expectRefusedUnchanged(
      await world.run(["pending", "--json"]),
      "SCHEMA_SX_STATE_UNREADABLE",
      4,
    );
  }),
);

caseTest(
  "J04.f-torn-effect-started",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 4));
    expect(await world.pendingIds()).toEqual([operation.id]);
    const history = await world.history(operation.id);
    expect(at(history.result.raw, "data", "journal", "events")).toEqual([]);
    expect(at(history.result.raw, "data", "observed")).toEqual({
      "note.write": "uncertain",
    });
  }),
);

caseTest(
  "J05.a-readback-failure-unknown",
  plain(async (world) => {
    const run = await world.run(apply("a"), { SX_FAULT: "readback-throws" });
    expect(run.exit).toBe(3);
    expect(run.exit).not.toBe(75);
    expect(run.result.outcome).toBe("failed");
    expect(run.result.transactionState).toBe("unknown");
    expect(run.result.retryable).toBe(false);
    expect(at(run.result.raw, "effects", "uncertain")).toEqual(["note.write"]);
    expect(at(run.result.raw, "handoff")).toBeDefined();
    expect(at(run.result.raw, "next")).toBeUndefined();
    const [operation] = world.operations();
    expect(at(operation?.events.records[1]?.payload, "reason")).toBe(
      "read-back-failed",
    );
  }),
);

caseTest(
  "J06.a-partial-versus-unknown",
  plain(async (world) => {
    await world.killAt(
      ["apply2", "a", "--content", "v1", "--json"],
      "first-confirmed",
    );
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(world.count("note.write")).toBe(1);
    expect(world.count("note.stamp")).toBe(0);
    const history = await world.history(operation.id);
    expect(at(history.result.raw, "data", "observed")).toEqual({
      "note.stamp": "remaining",
      "note.write": "completed",
    });
  }),
);

caseTest(
  "J06.b-started-second-uncertain",
  plain(async (world) => {
    await world.killAt(
      ["apply2", "a", "--content", "v1", "--json"],
      "second-started",
    );
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(world.count("note.stamp")).toBe(0);
    const history = await world.history(operation.id);
    expect(at(history.result.raw, "data", "observed")).toEqual({
      "note.stamp": "uncertain",
      "note.write": "completed",
    });
  }),
);

async function listedOnce(world: World): Promise<void> {
  const [operation] = world.operations();
  if (!operation) throw new Error("No operation.");
  const entries = await world.pending();
  expect(entries).toEqual([
    {
      operationId: operation.id,
      commandIdentity: "sx.apply",
      runId: str(operation.intent.runId),
      effects: ["note.write"],
    },
  ]);
}

caseTest(
  "L01.a-kill-at-intent-listed",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    await listedOnce(world);
  }),
);
caseTest(
  "L01.b-kill-at-effect-listed",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    await listedOnce(world);
  }),
);
caseTest(
  "L01.c-kill-at-complete-absent",
  plain(async (world) => {
    await world.killAt(apply("a"), "complete");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    expect(await world.pendingIds()).toEqual([]);
    const history = await world.history(operation.id);
    expect(at(history.result.raw, "data", "status")).toBe("completed");
    expect(eventKinds(world, operation.id)).toContain("completion");
  }),
);
caseTest(
  "L01.d-unknown-result-listed",
  plain(async (world) => {
    await world.run(apply("a"), { SX_FAULT: "readback-throws" });
    await listedOnce(world);
  }),
);
caseTest(
  "L01.e-completed-run-absent",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    expect(await world.pendingIds()).toEqual([]);
  }),
);

caseTest(
  "L02.a-live-listed-without-blocking",
  plain(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    await listedOnce(world);
    live.release("intent");
    expectCompleted(await live.done);
    expect(await world.pendingIds()).toEqual([]);
  }),
);

caseTest(
  "L03.a-report-read-only",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const before = world.snapshot();
    const report = await world.run(["pending", "--json"]);
    const history = await world.history(operation.id);
    expect(world.snapshot()).toBe(before);
    for (const run of [report, history]) {
      expect(run.exit).toBe(0);
      expect(run.stderr).toBe("");
      expect(at(run.result.raw, "effectClass")).toBe("inspect");
      expect(run.result.transactionState).toBe("unchanged");
      expect(at(run.result.raw, "effects")).toEqual({
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      });
      expect(at(run.result.raw, "next", "kind")).toBe("instruction");
    }
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "L04.a-corrupt-journal-refuses",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const format = join(world.root, "format");
    const original = readFileSync(format);
    flipLastPayloadByte(format);
    expectRefusedUnchanged(
      await world.run(["pending", "--json"]),
      "SCHEMA_SX_STATE_UNREADABLE",
      4,
    );
    writeFileSync(format, original);
    const operations = join(world.root, "operations");
    chmodSync(operations, 0o000);
    try {
      expectRefusedUnchanged(
        await world.run(["pending", "--json"]),
        "SCHEMA_SX_STATE_UNREADABLE",
        4,
      );
    } finally {
      chmodSync(operations, 0o700);
    }
  }),
);

caseTest(
  "L04.b-missing-store-refuses",
  plain(async (world) => {
    const report = await world.run(["pending", "--json"]);
    expectRefusedUnchanged(report, "SCHEMA_SX_STATE_UNREADABLE", 4);
    expect(str(report.envelope.message)).toContain("missing");
    expect(world.operations()).toEqual([]);
  }),
);

caseTest(
  "L04.c-empty-report-guidance",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const report = await world.run(["pending", "--json"]);
    expect(at(report.result.raw, "data", "unfinished")).toEqual([]);
    expect(at(report.result.raw, "next", "kind")).toBe("instruction");
    expect(str(at(report.result.raw, "next", "text"))).toContain(
      "does not prove the lost run never happened",
    );
    expect(report.result.retryable).toBe(false);
  }),
);

caseTest(
  "L05.a-history-before-and-after-closure",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const before = world.snapshot();
    const first = await world.history(operation.id);
    expect(world.snapshot()).toBe(before);
    expect(at(first.result.raw, "data", "closure")).toBeNull();
    expect(at(first.result.raw, "data", "commandIdentity")).toBe("sx.apply");
    expect(at(first.result.raw, "data", "scope", "unknown")).toBe(false);
    expect(JSON.stringify(first.result.raw)).not.toMatch(
      /secret|password|token/i,
    );
    const revision = str(at(first.result.raw, "data", "journal", "revision"));
    expectCompleted(
      await world.run([
        "close",
        operation.id,
        "--disposition",
        "completed",
        "--closure-id",
        "c1",
        "--revision",
        revision,
        "--reason",
        "read back present",
        "--json",
      ]),
    );
    const after = await world.history(operation.id);
    expect(at(after.result.raw, "data", "closure", "disposition")).toBe(
      "completed",
    );
    expect(at(after.result.raw, "data", "closure", "journalRevision")).toBe(
      revision,
    );
    expect(at(after.result.raw, "data", "status")).toBe("closed");
  }),
);

caseTest(
  "L05.b-unresolved-handoff-binds-history",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const refused = await world.run(apply("a", "v2"));
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNRESOLVED");
    expect(at(refused.result.raw, "handoff", "inspect")).toEqual([
      { kind: "command", command: "sx.history", args: [operation.id] },
    ]);
  }),
);

caseTest(
  "L05.c-history-refuses-invalid-identity",
  plain(async (world) => {
    const run = await world.run(["history", "op-not-valid", "--json"]);
    expect(run.exit).toBe(2);
    expect(run.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(world.operations()).toEqual([]);
  }),
);

caseTest(
  "L06.a-every-changing-command-names-inspect",
  plain(async (world) => {
    const discovery = await world.run(["--discover", "--json"]);
    expect(discovery.exit).toBe(0);
    const commands = at(discovery.result.raw, "data", "commands");
    if (!Array.isArray(commands)) throw new Error("No commands.");
    const changing = commands.filter(
      (entry) => at(entry, "effectClass") !== "inspect",
    );
    expect(
      changing.map((entry) => at(entry, "commandIdentity")).sort(),
    ).toEqual([
      "sx.apply",
      "sx.apply2",
      "sx.approved",
      "sx.audit",
      "sx.close",
      "sx.send",
    ]);
    for (const entry of changing) {
      const identity = str(at(entry, "commandIdentity"));
      const one = await world.run(["--discover-command", identity, "--json"]);
      expect(at(one.result.raw, "data", "ifNoResult")).toEqual({
        kind: "command",
        command: "sx.pending",
        args: [],
      });
    }
    const report = commands.find(
      (entry) => at(entry, "commandIdentity") === "sx.pending",
    );
    expect(at(report, "effectClass")).toBe("inspect");
  }),
);

caseTest(
  "L06.b-abort-then-report",
  plain(async (world) => {
    const child = world.start(apply("a"), {
      SX_BARRIER: "intent",
      SX_FAULT: "abort-at-intent",
    });
    const result = await child.done;
    expect(result.signal).toBe("SIGABRT");
    expect(result.stdout).toBe("");
    await listedOnce(world);
  }),
);

// Accepted decision "Contract question 4 of 8": the issued proof is the
// trusted summary, so the fallback reports the completed change it proved.
supportingTest(
  "V-23 supporting: refusal after a completed transaction is never unchanged",
  () =>
    within({}, async (world) => {
      const run = await world.run(apply("a"), {
        SX_FAULT: "refuse-after-complete",
      });
      expect(run.exit).toBe(1);
      expect(run.stderr).toBe("");
      expect(run.result.outcome).toBe("failed");
      expect(run.result.transactionState).toBe("completed");
      expect(run.result.causeCode).toBe("INTERNAL_RESULT_COMPLETED");
      expect(at(run.result.raw, "effects")).toEqual({
        completed: ["note.write"],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      });
      expect(at(run.result.raw, "handoff")).toBeDefined();
      expect(at(run.result.raw, "next")).toBeUndefined();
      expect(world.noteLedger("a")).toBe(1);
      expect(await world.pendingIds()).toEqual([]);
    }),
);

supportingTest(
  "CMD-11 supporting: a run killed before its outside write leaves a label carrying the published operation identity",
  () =>
    within({}, async (world) => {
      await world.killAt(["send", "m1", "--json"], "intent", {
        SX_ENTRY: "production",
      });
      expect(world.count("entry production")).toBe(1);
      const [operation, ...rest] = world.operations();
      expect(rest).toEqual([]);
      if (!operation) throw new Error("No operation.");
      expect(world.count("message.send")).toBe(0);
      expect(existsSync(join(world.world, "outbox", "m1"))).toBe(false);
      expect(existsSync(join(world.world, "provider.log"))).toBe(false);
      expect(world.labels()).toEqual([`${operation.id} m1`]);
    }),
);

caseTest(
  "J04.g-mid-file-length-damage-refuses",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const text = readFileSync(path, "utf8");
    const damaged = text.replace(
      /^(C3S1 [a-z-]+ )\d{10}/,
      (_match, head: string) => `${head}0000009999`,
    );
    expect(damaged).not.toBe(text);
    writeFileSync(path, damaged);
    expect(world.operations()[0]?.events.corrupt).toBe(true);
    expectRefusedUnchanged(
      await world.run(["pending", "--json"]),
      "SCHEMA_SX_STATE_UNREADABLE",
      4,
    );
  }),
);

caseTest(
  "J04.h-final-lf-missing-not-state",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 1));
    expect(world.operations()[0]?.events.torn).toBe(true);
    expect(await world.pendingIds()).toEqual([operation.id]);
  }),
);

const versionOneFormat = formatRecord(journals.one);
const versionTwoFormat = formatRecord(journals.two);

function formatText(world: World): string {
  return readFileSync(join(world.root, "format"), "utf8");
}

function asVersionOneStore(world: World): void {
  const settled = join(world.root, "settled");
  for (const id of readdirSync(settled))
    renameSync(join(settled, id), join(world.root, "operations", id));
  rmdirSync(settled);
  writeFileSync(join(world.root, "format"), versionOneFormat);
}

function caseFolders(
  world: World,
  folder: "operations" | "settled",
): readonly string[] {
  const directory = join(world.root, folder);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function fileDigests(directory: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(directory).sort())
    out[name] = createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex");
  return out;
}

async function closeCompleted(world: World, id: string): Promise<void> {
  expectCompleted(await world.run(closeArgs(id, await world.revision(id))));
}

function caseLock(world: World, id: string): string {
  return layout(world.root).keyLock(`case:${id}`);
}

function expectStampWithin(
  stamp: Json | undefined,
  window: { readonly before: number; readonly after: number },
): void {
  if (typeof stamp !== "number") throw new Error("No settledAt.");
  expect(stamp).toBeGreaterThanOrEqual(window.before);
  expect(stamp).toBeLessThanOrEqual(window.after);
}

function moverLines(world: World): readonly string[] {
  return world.ledger().filter((line) => line.startsWith("mover "));
}

caseTest(
  "J08.a-v1-program-refuses-v2-store",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    expect(formatText(world)).toBe(versionTwoFormat);
    expect(versionOneReader(world.root)).toBe("corrupt");
    const format = join(world.root, "format");
    const accepted = ["completed"];
    writeFileSync(format, versionOneFormat);
    expect(versionOneReader(world.root)).toEqual(accepted);
    writeFileSync(
      format,
      framed("format", { journal: journals.one, version: 2 }),
    );
    expect(versionOneReader(world.root)).toEqual(accepted);
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const other = formatRecord("contract3.state.3");
    writeFileSync(format, other);
    expectRefusedUnchanged(
      await world.run(["pending", "--json"]),
      "SCHEMA_SX_STATE_UNREADABLE",
      4,
    );
    expectRefusedUnchanged(
      await world.history(operation.id),
      "SCHEMA_SX_STATE_UNREADABLE",
      4,
    );
    expectRefusedUnchanged(
      await world.run(apply("b")),
      "DOMAIN_SX_UNAVAILABLE",
    );
    expect(formatText(world)).toBe(other);
    expect(world.noteLedger("b")).toBe(0);
  }),
);

caseTest(
  "J08.b-upgrade-crash-points",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    await world.killAt(apply("b"), "effect");
    asVersionOneStore(world);
    const listed = await world.pendingIds();
    expect(listed.length).toBe(1);
    const cases = caseFolders(world, "operations");
    expect(cases.length).toBe(2);
    const unchanged = async () => {
      expect(await world.pendingIds()).toEqual(listed);
      expect(caseFolders(world, "operations")).toEqual(cases);
      for (const id of cases) expect((await world.history(id)).exit).toBe(0);
    };
    await world.killAt(apply("c"), "upgrade-staged");
    expect(formatText(world)).toBe(versionOneFormat);
    expect(caseFolders(world, "settled")).toEqual([]);
    const staging = join(world.root, "staging");
    const staged = readdirSync(staging).map((name) =>
      readFileSync(join(staging, name), "utf8"),
    );
    expect(staged).toEqual([versionTwoFormat]);
    await unchanged();
    await world.killAt(apply("c"), "upgraded");
    expect(formatText(world)).toBe(versionTwoFormat);
    expect(formatText(world)).toBe(staged[0] ?? "");
    expect(caseFolders(world, "settled")).toEqual([]);
    await unchanged();
    expectCompleted(await world.run(apply("c")));
    expect(formatText(world)).toBe(versionTwoFormat);
    expect(await world.pendingIds()).toEqual(listed);
    expect(caseFolders(world, "settled")).toEqual(
      cases.filter((id) => !listed.includes(id)),
    );
  }),
);

caseTest(
  "J08.c-settled-at-written",
  fixture(async (world) => {
    const before = Date.now();
    expectCompleted(await world.run(apply("a")));
    await world.run(apply("b"), { SX_FAULT: "transient-after-intent" });
    await world.run(apply("c"), { SX_FAULT: "readback-throws" });
    await world.killAt(apply("d"), "effect");
    const listedBeforeClosure = await world.pendingIds();
    expect(listedBeforeClosure.length).toBe(2);
    const killed = world
      .operations()
      .find(
        (entry) =>
          listedBeforeClosure.includes(entry.id) &&
          entry.events.records.length === 1,
      );
    if (!killed) throw new Error("No killed case.");
    await closeCompleted(world, killed.id);
    const window = { before, after: Date.now() };
    const cases = world.cases();
    const stamped: string[] = [];
    for (const entry of cases) {
      expect(entry.events.torn || entry.events.corrupt).toBe(false);
      for (const record of entry.events.records)
        if (record.kind === "completion" || record.kind === "not-applied") {
          expectStampWithin(record.payload.settledAt, window);
          stamped.push(record.kind);
        } else expect(record.payload.settledAt).toBeUndefined();
      if (!entry.closure) continue;
      expect(entry.closure.torn || entry.closure.corrupt).toBe(false);
      expectStampWithin(entry.closure.records[0]?.payload.settledAt, window);
      stamped.push("closure");
    }
    expect(stamped.sort()).toEqual([
      "closure",
      "completion",
      "completion",
      "not-applied",
    ]);
    expect((await world.pendingIds()).length).toBe(1);
    asVersionOneStore(world);
    expect(versionOneReader(world.root)).toEqual([
      "closed",
      "completed",
      "completed",
      "not-applied",
      "unresolved",
    ]);
  }),
);

caseTest(
  "L07.a-settled-moved-not-listed",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [first, ...rest] = caseFolders(world, "operations");
    expect(rest).toEqual([]);
    if (!first) throw new Error("No case.");
    const revision = await world.revision(first);
    const digests = fileDigests(join(world.root, "operations", first));
    expectCompleted(await world.run(apply("b")));
    expect(caseFolders(world, "settled")).toEqual([first]);
    expect(caseFolders(world, "operations")).not.toContain(first);
    expect(fileDigests(join(world.root, "settled", first))).toEqual(digests);
    expect(existsSync(caseLock(world, first))).toBe(false);
    const history = await world.history(first);
    expect(history.exit).toBe(0);
    expect(at(history.result.raw, "data", "status")).toBe("completed");
    expect(await world.revision(first)).toBe(revision);
    expect(await world.pendingIds()).toEqual([]);
  }),
);

caseTest(
  "L07.b-admission-does-not-read-settled",
  plain(async (world) => {
    for (const name of ["a", "b", "c"])
      expectCompleted(await world.run(apply(name)));
    const moved = caseFolders(world, "settled");
    expect(moved.length).toBe(2);
    const settled = join(world.root, "settled");
    chmodSync(settled, 0o000);
    try {
      expectCompleted(await world.run(apply("d")));
      expect(await world.pendingIds()).toEqual([]);
      for (const id of moved)
        expectRefusedUnchanged(
          await world.history(id),
          "SCHEMA_SX_STATE_UNREADABLE",
          4,
        );
      for (const id of caseFolders(world, "operations"))
        expect((await world.history(id)).exit).toBe(0);
    } finally {
      chmodSync(settled, 0o700);
    }
    expect(caseFolders(world, "settled")).toEqual(moved);
    for (const id of moved) expect((await world.history(id)).exit).toBe(0);
  }),
);

caseTest(
  "L07.c-crash-between-final-event-and-move",
  plain(async (world) => {
    await world.killAt(apply("a"), "complete");
    const [first, ...rest] = caseFolders(world, "operations");
    expect(rest).toEqual([]);
    if (!first) throw new Error("No case.");
    expect(eventKinds(world, first).at(-1)).toBe("completion");
    expect(await world.pendingIds()).toEqual([]);
    expectCompleted(await world.run(apply("a", "v2")));
    expect(caseFolders(world, "settled")).toEqual([first]);
    expect(world.noteLedger("a")).toBe(2);
  }),
);

caseTest(
  "L07.d-move-skips-live-or-closing",
  plain(async (world) => {
    await world.killAt(apply("u"), "effect");
    const [unresolved] = await world.pendingIds();
    expectCompleted(await world.run(apply("a")));
    const settledCase = caseFolders(world, "operations").find(
      (id) => id !== unresolved,
    );
    if (!unresolved || !settledCase) throw new Error("No cases.");
    expectRefusedUnchanged(
      await world.run(apply("u", "v2")),
      "DOMAIN_SX_UNRESOLVED",
    );
    expect(caseFolders(world, "settled")).toEqual([]);
    const releaseLease = holdLock(
      join(world.root, "operations", settledCase, "owner.lease"),
    );
    try {
      expectCompleted(await world.run(apply("b")));
    } finally {
      releaseLease();
    }
    expect(caseFolders(world, "settled")).toEqual([]);
    const closerLock = caseLock(world, settledCase);
    expect(existsSync(closerLock)).toBe(false);
    const releaseCase = holdLock(closerLock);
    try {
      expectCompleted(await world.run(apply("c")));
    } finally {
      releaseCase();
    }
    expect(caseFolders(world, "settled").length).toBe(1);
    expect(caseFolders(world, "operations")).toContain(settledCase);
    expectCompleted(await world.run(apply("d")));
    expect(caseFolders(world, "settled")).toContain(settledCase);
    expect(caseFolders(world, "operations")).toContain(unresolved);
  }),
);

caseTest(
  "L07.e-move-bound",
  plain(async (world) => {
    versionTwoStore(world.root);
    const synthetic = Array.from({ length: 65 }, (_, index) =>
      writeSyntheticOperation(world.root, world.note(`s${String(index)}`), {
        completed: true,
      }),
    );
    const movedSynthetic = () =>
      caseFolders(world, "settled").filter((id) => synthetic.includes(id));
    expectCompleted(await world.run(apply("a")));
    expect(movedSynthetic().length).toBe(64);
    expectCompleted(await world.run(apply("b")));
    expect(movedSynthetic().length).toBe(65);
  }),
);

caseTest(
  "L07.f-examination-bound",
  plain(async (world) => {
    versionTwoStore(world.root);
    const ids = Array.from(
      { length: 129 },
      (_, index) => `op-${index.toString(16).padStart(32, "0")}`,
    );
    for (const id of ids)
      writeSyntheticOperation(world.root, world.note(id), {
        id,
        completed: true,
      });
    for (const id of ids.slice(0, 128))
      mkdirSync(join(world.root, "settled", id));
    const eligible = ids[128] ?? "";
    await world.killAt(apply("a"), "intent", {
      SX_MOVER_REPORT: "1",
      SX_MOVER_START: "0",
    });
    expect(moverLines(world)).toEqual(["mover examined 128 moved 0"]);
    expect(caseFolders(world, "operations")).toContain(eligible);
    expect((await world.pendingIds()).length).toBe(1);
    expectCompleted(
      await world.run(apply("b"), {
        SX_MOVER_REPORT: "1",
        SX_MOVER_START: "1",
      }),
    );
    expect(moverLines(world)).toEqual([
      "mover examined 128 moved 0",
      "mover examined 128 moved 1",
    ]);
    expect(caseFolders(world, "operations")).not.toContain(eligible);
    expect(existsSync(join(world.root, "settled", eligible, "intent"))).toBe(
      true,
    );
  }),
);

function pipeEvents(world: World, id: string): Uint8Array {
  const events = join(world.root, "operations", id, "events");
  const bytes = readFileSync(events);
  rmSync(events);
  const made = Bun.spawnSync(["mkfifo", events], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 4_000,
  });
  if (made.exitCode !== 0)
    throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  return bytes;
}

const readerBound = 30_000;

async function feed(
  pipe: string,
  bytes: Uint8Array,
  reader: Started,
  whileBlocked: () => void = () => undefined,
): Promise<void> {
  const opened = open(pipe, "w");
  const ended = reader.done.then(
    () => new Error(`The reader exited before it read ${pipe}.`),
    (error: unknown) =>
      error instanceof Error ? error : new Error(`The reader failed: ${pipe}.`),
  );
  const first = await Promise.race([
    opened.then(() => "opened" as const),
    ended,
  ]);
  if (first !== "opened") {
    const unblock = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      await (await opened).close();
    } finally {
      closeSync(unblock);
    }
    throw first;
  }
  const handle = await opened;
  try {
    whileBlocked();
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

caseTest(
  "L08.a-reader-races-move",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    await world.killAt(apply("c"), "effect");
    const crashed = [...(await world.pendingIds())].sort();
    const [reported, read] = crashed;
    if (!reported || !read || crashed.length !== 2)
      throw new Error("Expected two crashed cases.");
    for (const id of crashed) await closeCompleted(world, id);
    const live = join(world.root, "operations");
    const settled = join(world.root, "settled");
    for (const id of crashed)
      if (existsSync(join(settled, id)))
        renameSync(join(settled, id), join(live, id));
    expect(await world.pendingIds()).toEqual([]);
    const revision = await world.revision(read);
    const reportedBytes = pipeEvents(world, reported);
    const report = world.start(["pending", "--json"], {}, readerBound);
    await feed(join(live, reported, "events"), reportedBytes, report, () => {
      renameSync(join(live, reported), join(settled, reported));
    });
    const listing = await report.done;
    expect(listing.exit).toBe(0);
    expect(at(listing.result.raw, "data", "unfinished")).toEqual([]);
    const readBytes = pipeEvents(world, read);
    const history = world.start(["history", read, "--json"], {}, readerBound);
    await feed(join(live, read, "events"), readBytes, history, () => {
      renameSync(join(live, read), join(settled, read));
    });
    await feed(join(settled, read, "events"), readBytes, history);
    const found = await history.done;
    expect(found.exit).toBe(0);
    expect(at(found.result.raw, "data", "status")).toBe("closed");
    expect(at(found.result.raw, "data", "journal", "revision")).toBe(revision);
    expect(at(found.result.raw, "data", "closure", "disposition")).toBe(
      "completed",
    );
  }),
);

supportingTest(
  "X23 supporting: the upgrade refuses a settled/ that is not private, and a format it does not know",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    asVersionOneStore(world);
    const settled = join(world.root, "settled");
    mkdirSync(settled);
    chmodSync(settled, 0o770);
    const shared = await world.run(apply("b"));
    expectRefusedUnchanged(shared, "DOMAIN_SX_UNAVAILABLE");
    expect(str(shared.envelope.message)).toContain("store-upgrade");
    expect(formatText(world)).toBe(versionOneFormat);
    chmodSync(settled, 0o700);
    expectCompleted(await world.run(apply("b")));
    expect(formatText(world)).toBe(versionTwoFormat);
    const waiting = world.start(apply("c"), { SX_BARRIER: "admission-wait" });
    await waiting.reached("admission-wait");
    const unknown = formatRecord("contract3.state.3");
    writeFileSync(join(world.root, "format"), unknown);
    waiting.release("admission-wait");
    const refused = await waiting.done;
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain("store-upgrade");
    expect(formatText(world)).toBe(unknown);
    expect(world.noteLedger("c")).toBe(0);
  }),
);

supportingTest(
  "X24 supporting: the mover leaves a case with a damaged closure or no lease file",
  plain(async (world) => {
    versionTwoStore(world.root);
    const [damaged, leaseless, eligible] = ["x", "y", "z"].map((name) =>
      writeSyntheticOperation(world.root, world.note(name), {
        completed: true,
      }),
    );
    if (!damaged || !leaseless || !eligible) throw new Error("No cases.");
    const operations = join(world.root, "operations");
    writeFileSync(join(operations, damaged, "closure"), "damaged");
    rmSync(join(operations, leaseless, "owner.lease"));
    expectCompleted(await world.run(apply("a")));
    expect(caseFolders(world, "settled")).toEqual([eligible]);
    const left = caseFolders(world, "operations");
    expect(left).toContain(damaged);
    expect(left).toContain(leaseless);
    expect(existsSync(caseLock(world, damaged))).toBe(false);
  }),
);

supportingTest(
  "X24 supporting: a version 2 store refuses a settled/ that is a symbolic link or not private",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    expectCompleted(await world.run(apply("b")));
    const [moved] = caseFolders(world, "settled");
    if (!moved) throw new Error("No moved case.");
    const settled = join(world.root, "settled");
    const elsewhere = join(world.base, "elsewhere");
    renameSync(settled, elsewhere);
    symlinkSync(elsewhere, settled);
    const refusedAs = async (
      argv: readonly string[],
      cause: string,
      message: string,
    ) => {
      const run = await world.run(argv);
      expectRefusedUnchanged(
        run,
        cause,
        cause === "DOMAIN_SX_UNAVAILABLE" ? 3 : 4,
      );
      expect(str(run.envelope.message)).toBe(message);
    };
    const corrupt = "The journal is corrupt.";
    const store = "State unavailable: store.";
    const unreadable = "SCHEMA_SX_STATE_UNREADABLE";
    await refusedAs(["history", moved, "--json"], unreadable, corrupt);
    await refusedAs(["pending", "--json"], unreadable, corrupt);
    await refusedAs(apply("c"), "DOMAIN_SX_UNAVAILABLE", store);
    expect(readdirSync(elsewhere)).toEqual([moved]);
    rmSync(settled);
    renameSync(elsewhere, settled);
    for (const mode of [0o770, 0o707]) {
      chmodSync(settled, mode);
      await refusedAs(apply("c"), "DOMAIN_SX_UNAVAILABLE", store);
      expect(caseFolders(world, "settled")).toEqual([moved]);
    }
    expect(world.noteLedger("c")).toBe(0);
    chmodSync(settled, 0o700);
    expectCompleted(await world.run(apply("c")));
    expect(caseFolders(world, "settled").length).toBe(2);
  }),
);

supportingTest(
  "Production entry supporting: through index.ts the store upgrades, a settled case moves and history finds it",
  plain(async (world) => {
    const production = { SX_ENTRY: "production" };
    expectCompleted(await world.run(apply("a"), production));
    expect(formatText(world)).toBe(versionTwoFormat);
    expect(versionOneReader(world.root)).toBe("corrupt");
    const [first] = caseFolders(world, "operations");
    if (!first) throw new Error("No case.");
    expectCompleted(await world.run(apply("b"), production));
    expect(caseFolders(world, "settled")).toEqual([first]);
    const history = await world.run(["history", first, "--json"], production);
    expect(history.exit).toBe(0);
    expect(at(history.result.raw, "data", "operationId")).toBe(first);
    expect(at(history.result.raw, "data", "status")).toBe("completed");
    const report = await world.run(["pending", "--json"], production);
    expect(report.exit).toBe(0);
    expect(at(report.result.raw, "data", "unfinished")).toEqual([]);
    expect(world.count("entry production")).toBe(4);
  }),
);
