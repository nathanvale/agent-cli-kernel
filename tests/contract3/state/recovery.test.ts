import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  at,
  caseTest,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
} from "./harness.ts";
import type { World } from "./harness.ts";
import { coordinationExpected } from "./holder.ts";

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

function only(world: World, command = "sx.apply"): string {
  const found = world
    .operations()
    .filter((entry) => entry.intent.commandIdentity === command);
  const [first, ...rest] = found;
  if (!first || rest.length > 0) throw new Error("Expected one operation.");
  return first.id;
}
function closurePath(world: World, id: string): string {
  return join(world.root, "operations", id, "closure");
}
function closeArgs(
  id: string,
  revision: string,
  disposition = "completed",
  closureId = "c1",
  ...extra: string[]
): string[] {
  return [
    "close",
    id,
    "--disposition",
    disposition,
    "--closure-id",
    closureId,
    "--revision",
    revision,
    "--reason",
    "independent evidence reviewed",
    ...extra,
    "--json",
  ];
}
async function close(
  world: World,
  id: string,
  disposition = "completed",
  closureId = "c1",
  ...extra: string[]
) {
  return world.run(
    closeArgs(id, await world.revision(id), disposition, closureId, ...extra),
  );
}

caseTest(
  "K01.a-recovery-is-changing",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const discovery = await world.run([
      "--discover-command",
      "sx.close",
      "--json",
    ]);
    expect(at(discovery.result.raw, "data", "command", "effectClass")).toBe(
      "repository-local",
    );
    expect(at(discovery.result.raw, "data", "ifNoResult")).toEqual({
      kind: "command",
      command: "sx.pending",
      args: [],
    });
    const closed = await close(world, id);
    expectCompleted(closed);
    expect(at(closed.result.raw, "effectClass")).toBe("repository-local");
    expect(at(closed.result.raw, "commandIdentity")).toBe("sx.close");
    expect(at(closed.result.raw, "effects", "completed")).toEqual([
      "state.closure",
    ]);
    const recovery = only(world, "sx.close");
    const recorded = world.operations().find((entry) => entry.id === recovery);
    expect(recorded?.intent.closes).toBe(id);
    expect(recorded?.events.records.map((record) => record.kind)).toEqual([
      "effect-started",
      "effect-confirmed",
      "completion",
    ]);
    const original = world.operations().find((entry) => entry.id === id);
    expect(original?.events.records.map((record) => record.kind)).toEqual([
      "effect-started",
    ]);
  }),
);

caseTest(
  "K02.a-kill-after-effect-two-later-changes",
  fixture(async (world) => {
    await world.killAt(apply("u"), "intent");
    const unrelated = only(world);
    await world.killAt(apply("a"), "effect");
    const id = world
      .operations()
      .map((entry) => entry.id)
      .find((entry) => entry !== unrelated);
    if (!id) throw new Error("No operation.");
    expect(world.noteLedger("a")).toBe(1);
    expectCompleted(await close(world, id));
    expect(world.noteLedger("a")).toBe(1);
    expect(await world.pendingIds()).toEqual([unrelated]);
    expectCompleted(await world.run(apply("a", "v2")));
    expect(world.noteLedger("a")).toBe(2);
    expectCompleted(await world.run(apply("a", "v3")));
    expect(world.noteLedger("a")).toBe(3);
    expect(readFileSync(world.note("a"), "utf8")).toBe("v3");
    expect(await world.pendingIds()).toEqual([unrelated]);
  }),
);

caseTest(
  "K03.a-absence-is-not-not-applied",
  fixture(async (world) => {
    await world.killAt(["send", "m1", "--json"], "effect");
    const id = only(world, "sx.send");
    rmSync(join(world.world, "outbox", "m1"));
    const refused = await close(world, id, "not-applied");
    expectRefusedUnchanged(refused, "DOMAIN_SX_CLOSE_EVIDENCE");
    expect(existsSync(closurePath(world, id))).toBe(false);
    expect(await world.pendingIds()).toEqual([id]);
    expect(world.count("message.send")).toBe(1);
  }),
);

caseTest(
  "K03.b-exclusion-permits-not-applied",
  fixture(async (world) => {
    await world.killAt(["send", "m2", "--json"], "intent");
    const id = only(world, "sx.send");
    expect(world.count("message.send")).toBe(0);
    expectCompleted(await close(world, id, "not-applied"));
    const history = await world.history(id);
    expect(at(history.result.raw, "data", "closure", "disposition")).toBe(
      "not-applied",
    );
    expect(await world.pendingIds()).toEqual([]);
    expect(world.count("message.send")).toBe(0);
  }),
);

caseTest(
  "K04.a-unknown-closure-unavailable",
  fixture(async (world) => {
    await world.killAt(["audit", "e1", "--json"], "effect");
    const id = only(world, "sx.audit");
    const refused = await close(world, id, "outcome-unknown");
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain(
      "human-closure-unqualified",
    );
    expect(at(refused.result.raw, "handoff")).toBeDefined();
    expect(existsSync(closurePath(world, id))).toBe(false);
    expect(await world.pendingIds()).toEqual([id]);
    expect(world.count("audit.emit")).toBe(1);
  }),
);

caseTest(
  "K05.a-forged-closure-authority",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const grant = join(world.world, "forged-grant.json");
    const forged = JSON.stringify({ grantedBy: "human", operation: id });
    writeFileSync(grant, forged);
    const refused = await close(
      world,
      id,
      "outcome-unknown",
      "c1",
      "--human-approved",
      "--grant",
      grant,
    );
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(existsSync(closurePath(world, id))).toBe(false);
    expect(readFileSync(grant, "utf8")).toBe(forged);
    expect(await world.pendingIds()).toEqual([id]);
    expectRefusedUnchanged(
      await world.run(apply("a", "v2")),
      "DOMAIN_SX_UNRESOLVED",
    );
  }),
);

caseTest(
  "K06.a-closure-retry-same-identity",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    expectCompleted(await world.run(closeArgs(id, revision)));
    const bytes = readFileSync(closurePath(world, id));
    const count = world.operations().length;
    const again = await world.run(closeArgs(id, revision));
    expect(again.exit).toBe(0);
    expect(again.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(at(again.result.raw, "data", "disposition")).toBe("completed");
    expect(readFileSync(closurePath(world, id))).toEqual(bytes);
    expect(world.operations().length).toBe(count);
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "K06.b-conflicting-closure-refused",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    expectCompleted(await world.run(closeArgs(id, revision)));
    const bytes = readFileSync(closurePath(world, id));
    expectRefusedUnchanged(
      await world.run(closeArgs(id, revision, "completed", "c2")),
      "DOMAIN_SX_CLOSE_CONFLICT",
    );
    expect(readFileSync(closurePath(world, id))).toEqual(bytes);
  }),
);

caseTest(
  "K06.c-stale-revision-refused",
  fixture(async (world) => {
    const child = world.start(["apply2", "a", "--content", "v1", "--json"], {
      SX_BARRIER: "first-confirmed,second-started",
    });
    await child.reached("first-confirmed");
    const id = only(world, "sx.apply2");
    const stale = await world.revision(id);
    child.release("first-confirmed");
    await child.reached("second-started");
    child.kill("SIGKILL");
    await child.done;
    expect(await world.revision(id)).not.toBe(stale);
    expectRefusedUnchanged(
      await world.run(closeArgs(id, stale, "outcome-unknown")),
      "DOMAIN_SX_CLOSE_STALE",
    );
    expect(existsSync(closurePath(world, id))).toBe(false);
  }),
);

caseTest(
  "K06.d-closure-record-fields",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    expectCompleted(await world.run(closeArgs(id, revision)));
    const closure = world
      .operations()
      .find((entry) => entry.id === id)?.closure;
    expect(closure?.torn).toBe(false);
    const payload = closure?.records[0]?.payload;
    expect(at(payload, "operationId")).toBe(id);
    expect(at(payload, "closureId")).toBe("c1");
    expect(at(payload, "disposition")).toBe("completed");
    expect(at(payload, "reason")).toBe("independent evidence reviewed");
    expect(at(payload, "journalRevision")).toBe(revision);
    expect(at(payload, "qualification")).toBe("fixture:specimen");
    expect(at(payload, "evidence")).toEqual([
      { effect: "note.write", observation: "present" },
    ]);
    const directory = join(world.root, "operations", id);
    const expected = `r-${createHash("sha256")
      .update(readFileSync(join(directory, "intent")))
      .update("\n")
      .update(readFileSync(join(directory, "events")))
      .digest("hex")}`;
    expect(revision).toBe(expected);
  }),
);

caseTest(
  "K06.e-kill-before-closure-publication",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    await world.killAt(closeArgs(id, revision), "closure-staged");
    expect(existsSync(closurePath(world, id))).toBe(false);
    const listed = await world.pendingIds();
    expect(listed).toContain(id);
    const deadRecovery = only(world, "sx.close");
    expect(listed).toContain(deadRecovery);
    expectCompleted(
      await world.run(closeArgs(id, revision, "completed", "c2")),
    );
    const history = await world.history(deadRecovery);
    expect(at(history.result.raw, "data", "observed")).toEqual({
      "state.closure": "remaining",
    });
    expectCompleted(await close(world, deadRecovery, "not-applied", "c3"));
    expect(await world.pendingIds()).toEqual([]);
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "K07.a-closed-stays-closed",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    expectCompleted(await close(world, id));
    const bytes = readFileSync(closurePath(world, id));
    expectCompleted(await world.run(apply("a", "diverged")));
    expect(await world.pendingIds()).toEqual([]);
    expect(readFileSync(closurePath(world, id))).toEqual(bytes);
    const history = await world.history(id);
    expect(at(history.result.raw, "data", "status")).toBe("closed");
    expectCompleted(await world.run(apply("a", "again")));
    expect(world.noteLedger("a")).toBe(3);
  }),
);

caseTest(
  "K08.a-live-writer-blocks-closure",
  fixture(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    const id = only(world);
    const refused = await close(world, id);
    expectRefusedUnchanged(refused, "DOMAIN_SX_CLOSE_OWNER_LIVE");
    expect(at(refused.result.raw, "handoff", "inspect")).toEqual([
      { kind: "command", command: "sx.history", args: [id] },
    ]);
    expect(existsSync(closurePath(world, id))).toBe(false);
    expectCompleted(await world.run(apply("b")));
    live.release("intent");
    expectCompleted(await live.done);
  }),
);

caseTest(
  "K08.b-recorded-delegate-blocks-closure",
  fixture(async (world) => {
    await world.killAt(apply("a"), "intent", { SX_FAULT: "admit-delegate" });
    const id = only(world);
    expect(
      world.operations()[0]?.events.records.map((record) => record.kind),
    ).toEqual(["effect-started", "delegate-admitted"]);
    const refused = await close(world, id, "not-applied");
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain("delegate-recorded");
    expect(existsSync(closurePath(world, id))).toBe(false);
  }),
);

caseTest(
  "K09.a-no-proxy-completion",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const events = join(world.root, "operations", id, "events");
    const before = readFileSync(events);
    expectRefusedUnchanged(
      await world.run(apply("a", "v2")),
      "DOMAIN_SX_UNRESOLVED",
    );
    expectRefusedUnchanged(
      await world.run(["apply2", "a", "--content", "v2", "--json"]),
      "DOMAIN_SX_UNRESOLVED",
    );
    expect(readFileSync(events)).toEqual(before);
    expect(await world.pendingIds()).toEqual([id]);
  }),
);

caseTest(
  "O04.a-age-is-not-proof",
  fixture(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    const id = only(world);
    const directory = join(world.root, "operations", id);
    const old = new Date("2000-01-01T00:00:00Z");
    for (const name of ["intent", "events", "owner.lease"])
      utimesSync(join(directory, name), old, old);
    expectRefusedUnchanged(
      await close(world, id),
      "DOMAIN_SX_CLOSE_OWNER_LIVE",
    );
    expect(existsSync(closurePath(world, id))).toBe(false);
    live.release("intent");
    expectCompleted(await live.done);
  }),
);

caseTest(
  "O04.b-stopped-process-still-owner",
  fixture(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    const id = only(world);
    live.kill("SIGSTOP");
    live.kill("SIGTERM");
    expectRefusedUnchanged(
      await close(world, id),
      "DOMAIN_SX_CLOSE_OWNER_LIVE",
    );
    live.kill("SIGCONT");
    const result = await live.done;
    expect(result.exit).toBe(143);
    expect(existsSync(closurePath(world, id))).toBe(false);
  }),
);

caseTest(
  "O05.a-pid-not-consulted",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const path = join(world.root, "operations", id, "intent");
    const original = readFileSync(path, "utf8");
    const body = original.slice(original.indexOf("\n") + 1, -1);
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null) throw new Error("bad");
    const owner: unknown = Reflect.get(payload, "owner");
    if (typeof owner !== "object" || owner === null) throw new Error("bad");
    Reflect.set(owner, "pid", process.pid);
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const digest = createHash("sha256")
      .update("intent\n")
      .update(bytes)
      .digest("hex");
    writeFileSync(
      path,
      `C3S1 intent ${String(bytes.length).padStart(10, "0")} ${digest}\n${new TextDecoder().decode(bytes)}\n`,
    );
    expect(at(world.operations()[0]?.intent, "owner", "pid")).toBe(process.pid);
    const before = world.snapshot();
    const refused = await close(world, id);
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain(
      "stopped-owner-proof-unqualified",
    );
    expect(existsSync(closurePath(world, id))).toBe(false);
    expect(world.operations().map((entry) => entry.id)).toEqual([id]);
    void before;
  }),
);

caseTest(
  "O07.a-two-closers",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    const first = world.start(closeArgs(id, revision, "completed", "c1"), {
      SX_BARRIER: "closure-staged",
    });
    await first.reached("closure-staged");
    const second = await world.run(closeArgs(id, revision, "completed", "c2"));
    expectRefusedUnchanged(second, "DOMAIN_SX_LOCK_HELD");
    first.release("closure-staged");
    expectCompleted(await first.done);
    expectRefusedUnchanged(
      await world.run(closeArgs(id, revision, "completed", "c2")),
      "DOMAIN_SX_CLOSE_CONFLICT",
    );
    const closures = world
      .operations()
      .filter((entry) => entry.closure !== undefined);
    expect(closures.length).toBe(1);
    expect(at(closures[0]?.closure?.records[0]?.payload, "closureId")).toBe(
      "c1",
    );
  }),
);

caseTest(
  "O09.a-reclaim-is-coordination-only",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    expectRefusedUnchanged(
      await world.run(apply("a", "v2")),
      "DOMAIN_SX_UNRESOLVED",
    );
    expect(existsSync(closurePath(world, id))).toBe(false);
    expect(world.noteLedger("a")).toBe(1);
    expect(await world.pendingIds()).toEqual([id]);
  }),
);

caseTest(
  "O10.a-unqualified-closure-unavailable",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const operations = JSON.stringify(world.operations());
    const refused = await close(world, id);
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain(
      "stopped-owner-proof-unqualified",
    );
    expect(at(refused.result.raw, "handoff", "inspect")).toEqual([
      { kind: "command", command: "sx.capabilities", args: [] },
    ]);
    expect(JSON.stringify(world.operations())).toBe(operations);
    expect(await world.pendingIds()).toEqual([id]);
  }),
);

caseTest(
  "O10.b-unqualified-takeover-unavailable",
  plain(async (world) => {
    const attestation = join(world.world, "stop-attestation.json");
    const content = JSON.stringify({
      format: "contract3.stop-attestation",
      version: 1,
    });
    writeFileSync(attestation, content);
    const refused = await world.run(
      closeArgs(
        `op-${"0".repeat(32)}`,
        `r-${"0".repeat(64)}`,
        "completed",
        "c1",
        "--attestation",
        attestation,
      ),
    );
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain(
      coordinationExpected
        ? "human-assisted-takeover-unqualified"
        : process.platform === "linux"
          ? "coordination-self-check-failed"
          : "coordination-unqualified-platform",
    );
    expect(readFileSync(attestation, "utf8")).toBe(content);
    expect(world.operations()).toEqual([]);
  }),
);

caseTest(
  "H02.a-attestation-cannot-bypass-exclusivity",
  fixture(async (world) => {
    if (!coordinationExpected) {
      const refused = await world.run(
        closeArgs(
          `op-${"1".repeat(32)}`,
          `r-${"1".repeat(64)}`,
          "completed",
          "c1",
          "--attestation",
          "/dev/null",
        ),
      );
      expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
      return;
    }
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const attestation = join(world.world, "stop-attestation.json");
    const content = JSON.stringify({
      format: "contract3.stop-attestation",
      version: 1,
      operation: id,
    });
    writeFileSync(attestation, content);
    const before = JSON.stringify(world.operations());
    const refused = await close(
      world,
      id,
      "completed",
      "c1",
      "--attestation",
      attestation,
    );
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain(
      "human-assisted-takeover-unqualified",
    );
    expect(readFileSync(attestation, "utf8")).toBe(content);
    expect(JSON.stringify(world.operations())).toBe(before);
    expect(await world.pendingIds()).toEqual([id]);
    renameSync(attestation, `${attestation}.kept`);
  }),
);

caseTest(
  "K06.f-same-identity-different-content",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    expectCompleted(await world.run(closeArgs(id, revision)));
    const bytes = readFileSync(closurePath(world, id));
    expectRefusedUnchanged(
      await world.run(closeArgs(id, revision, "not-applied", "c1")),
      "DOMAIN_SX_CLOSE_CONFLICT",
    );
    const otherReason = closeArgs(id, revision).map((token) =>
      token === "independent evidence reviewed" ? "another reason" : token,
    );
    expectRefusedUnchanged(
      await world.run(otherReason),
      "DOMAIN_SX_CLOSE_CONFLICT",
    );
    expect(readFileSync(closurePath(world, id))).toEqual(bytes);
  }),
);

caseTest(
  "K06.g-unknown-operation-not-found",
  fixture(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const refused = await world.run(
      closeArgs(`op-${"a".repeat(32)}`, `r-${"0".repeat(64)}`),
    );
    expectRefusedUnchanged(refused, "DOMAIN_SX_CASE_NOT_FOUND");
  }),
);

caseTest(
  "K06.h-unreadable-case-unavailable",
  fixture(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    const directory = join(world.root, "operations", id);
    chmodSync(directory, 0o000);
    let refused;
    try {
      refused = await world.run(closeArgs(id, revision));
    } finally {
      chmodSync(directory, 0o700);
    }
    expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
    expect(str(refused.envelope.message)).toContain("store-unreadable");
    expect(existsSync(closurePath(world, id))).toBe(false);
  }),
);
