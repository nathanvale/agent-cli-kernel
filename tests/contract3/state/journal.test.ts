// J and L families: journal truth and lost-response routes, through real
// specimen processes. Expected values come from tests/contract3/state/cases.ts
// and the frozen clauses, never from add-on output.
import { expect } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  at,
  caseTest,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
  supportingTest,
} from "./harness.ts";
import type { World } from "./harness.ts";

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
function eventsPath(world: World, id: string): string {
  return join(world.root, "operations", id, "events");
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
    // Change one letter inside a JSON string of the final record: the JSON
    // and length stay valid, so only the checksum can reject it.
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

// ---- L ---------------------------------------------------------------------

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

// Supporting V-23 process control owed by T3 (kernel F-proof rule, T1 repair):
// a handler that refuses after a completed transaction never yields a
// refused, unchanged envelope. Not a frozen case; reported separately.
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

caseTest(
  "J04.g-mid-file-length-damage-refuses",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    const [operation] = world.operations();
    if (!operation) throw new Error("No operation.");
    const path = eventsPath(world, operation.id);
    const text = readFileSync(path, "utf8");
    // Inflate the first record's length so it runs past the end of the
    // file while valid records follow: mid-file damage, never a torn tail.
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
