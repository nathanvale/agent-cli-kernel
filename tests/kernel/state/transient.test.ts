import { expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { grantLocation } from "../../../kernel/src/addons/approval/index.ts";
import {
  at,
  caseTest,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
} from "./harness.ts";
import type { Run, World } from "./harness.ts";
import { coordinationExpected, holdLock } from "./holder.ts";

const apply = (name: string, content = "v1") => [
  "apply",
  name,
  "--content",
  content,
  "--json",
];

async function within(body: (world: World) => Promise<void>): Promise<void> {
  const world = makeWorld();
  try {
    await body(world);
  } finally {
    world.dispose();
  }
}
const plain = (body: (world: World) => Promise<void>) => () => within(body);

function expectTransient(run: Run, cause: string, outcome: string): void {
  expect(run.exit).toBe(75);
  expect(run.stderr).toBe("");
  expect(run.result.causeCode).toBe(cause);
  expect(run.result.outcome).toBe(outcome);
  expect(run.result.transactionState).toBe("unchanged");
  expect(at(run.result.raw, "failureClass")).toBe("transient");
  expect(run.result.exitCode).toBe(75);
  expect(run.result.retryable).toBe(true);
  const delay = at(run.result.raw, "retryDelayMilliseconds");
  expect(typeof delay === "number" && Number.isInteger(delay)).toBe(true);
  expect(Number(delay)).toBeGreaterThanOrEqual(50);
  expect(Number(delay)).toBeLessThanOrEqual(2_000);
  expect(at(run.result.raw, "next")).toEqual({ kind: "retry" });
  expect(at(run.result.raw, "handoff")).toBeUndefined();
}

caseTest(
  "T01.a-host-transient-exit-75",
  plain(async (world) => {
    writeFileSync(join(world.world, "dependency.down"), "down\n");
    const refused = await world.run(apply("a"));
    expectTransient(refused, "TRANSIENT_NOT_STARTED", "refused");
    expect(world.operations()).toEqual([]);
    expect(world.noteLedger("a")).toBe(0);
    rmSync(join(world.world, "dependency.down"));
    expectCompleted(await world.run(apply("a")));
    expect(world.noteLedger("a")).toBe(1);
    expect(await world.pendingIds()).toEqual([]);
  }),
);

caseTest(
  "T01.b-admission-busy-exit-75",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    let refused: Run;
    try {
      refused = await world.run(apply("a"), { SX_ADMISSION_WAIT: "200" });
    } finally {
      release();
    }
    expectTransient(refused, "TRANSIENT_NOT_STARTED", "refused");
    expect(refused.result.causeCode).not.toBe("DOMAIN_SX_LOCK_HELD");
    expect(world.operations().length).toBe(1);
    expectCompleted(await world.run(apply("a")));
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "T02.a-attempt-unchanged-exit-75",
  plain(async (world) => {
    const failed = await world.run(apply("a"), {
      SX_FAULT: "transient-after-intent",
    });
    expectTransient(failed, "TRANSIENT_ATTEMPT_UNCHANGED", "failed");
    const [operation] = world.operations();
    expect(operation?.events.records.map((record) => record.kind)).toEqual([
      "not-applied",
    ]);
    expect(await world.pendingIds()).toEqual([]);
    expectCompleted(await world.run(apply("a")));
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "T03.a-delay-out-of-bounds",
  plain(async (world) => {
    writeFileSync(join(world.world, "dependency.down"), "down\n");
    for (const fault of ["delay-low", "delay-high"]) {
      const run = await world.run(apply("a"), { SX_FAULT: fault });
      expect(run.exit).toBe(1);
      expect(run.exit).not.toBe(75);
      expect(run.result.retryable).toBe(false);
      expect(at(run.result.raw, "next", "kind")).not.toBe("retry");
    }
    expect(world.operations()).toEqual([]);
  }),
);

caseTest(
  "T04.a-no-75-with-uncertainty",
  plain(async (world) => {
    const run = await world.run(apply("a"), { SX_FAULT: "readback-throws" });
    expect(run.exit).toBe(3);
    expect(run.result.transactionState).toBe("unknown");
    expect(at(run.result.raw, "failureClass")).toBe("domain");
    expect(at(run.result.raw, "handoff")).toBeDefined();
  }),
);

caseTest(
  "T04.b-held-lock-never-75",
  plain(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    const refused = await world.run(apply("a", "v2"));
    expect(refused.exit).toBe(3);
    expect(refused.result.retryable).toBe(false);
    live.release("intent");
    expectCompleted(await live.done);
  }),
);

caseTest(
  "Q01.a-production-defaults-unavailable",
  plain(async (world) => {
    const run = await world.run(["capabilities", "--json"]);
    expect(run.exit).toBe(0);
    const data = at(run.result.raw, "data");
    expect(at(data, "qualification")).toBe("unqualified");
    expect(at(data, "coordination")).toBe(
      coordinationExpected ? "available" : "unavailable",
    );
    expect(at(data, "stoppedOwnerProof")).toBe("unavailable");
    expect(at(data, "automaticReclaim")).toBe("unavailable");
    expect(at(data, "humanAssistedTakeover")).toBe("unavailable");
    expect(at(data, "humanOutcomeUnknownClosure")).toBe("unavailable");
    const reasons = at(data, "reasons");
    expect(Array.isArray(reasons) && reasons.length >= 4).toBe(true);
  }),
);

const store = (world: World) => ({
  grants: join(world.world, "approval", "grants"),
  consumed: join(world.world, "approval", "consumed"),
});
function writeGrant(
  world: World,
  preview: string,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const locations = store(world);
  mkdirSync(locations.grants, { recursive: true, mode: 0o700 });
  mkdirSync(locations.consumed, { recursive: true, mode: 0o700 });
  chmodSync(join(world.world, "approval"), 0o700);
  const path = grantLocation(locations, preview);
  writeFileSync(
    path,
    JSON.stringify({
      format: "contract3.approval-grant",
      version: 1,
      operation: "sx.approved",
      preview,
      authority: "sx-owner",
      resource: "note:a",
      resourceRevision: "observed",
      effects: ["note.write"],
      expiresAt: Date.now() + 3_600_000,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}
function markers(world: World): readonly string[] {
  const directory = store(world).consumed;
  return existsSync(directory) ? readdirSync(directory) : [];
}
const approvedArgs = (preview: string) => [
  "approved",
  "a",
  "--content",
  "v1",
  "--preview",
  preview,
  "--json",
];

caseTest(
  "S01.a-consumed-under-coordination-before-intent",
  plain(async (world) => {
    const grant = writeGrant(world, "p1");
    const bytes = readFileSync(grant, "utf8");
    expectCompleted(await world.run(approvedArgs("p1")));
    expect(markers(world).length).toBe(1);
    const [operation] = world.operations();
    expect(operation?.intent.approval).toEqual({
      kind: "preview",
      reference: "p1",
    });
    expect(JSON.stringify(operation?.intent)).not.toContain("expiresAt");
    expect(JSON.stringify(operation?.intent)).not.toContain(bytes);
    expect(world.noteLedger("a")).toBe(1);
    const again = await world.run(approvedArgs("p1"));
    expect(again.result.causeCode).toBe("DOMAIN_AUTHORITY_REQUIRED");
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "S02.a-denial-under-coordination",
  plain(async (world) => {
    const grant = writeGrant(world, "p2");
    const child = world.start(approvedArgs("p2"), {
      SX_BARRIER: "pre-admission",
    });
    await child.reached("pre-admission");
    writeGrant(world, "p2", { resourceRevision: "changed" });
    child.release("pre-admission");
    const run = await child.done;
    expectRefusedUnchanged(run, "DOMAIN_AUTHORITY_REQUIRED");
    expect(world.operations()).toEqual([]);
    expect(markers(world)).toEqual([]);
    expect(world.noteLedger("a")).toBe(0);
    void grant;
  }),
);

caseTest(
  "S03.a-store-failure-preserves-item",
  plain(async (world) => {
    writeGrant(world, "p3");
    const child = world.start(approvedArgs("p3"), {
      SX_BARRIER: "pre-admission",
    });
    await child.reached("pre-admission");
    chmodSync(store(world).consumed, 0o500);
    child.release("pre-admission");
    let run: Run;
    try {
      run = await child.done;
    } finally {
      chmodSync(store(world).consumed, 0o700);
    }
    expectRefusedUnchanged(run, "DOMAIN_SX_APPROVAL_STORE");
    expect(world.operations()).toEqual([]);
    expect(markers(world)).toEqual([]);
    expectCompleted(await world.run(approvedArgs("p3")));
    expect(markers(world).length).toBe(1);
  }),
);

caseTest(
  "S04.a-held-lock-preserves-grant",
  plain(async (world) => {
    writeGrant(world, "p4");
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    expectRefusedUnchanged(
      await world.run(approvedArgs("p4")),
      "DOMAIN_SX_LOCK_HELD",
    );
    expect(markers(world)).toEqual([]);
    live.release("intent");
    expectCompleted(await live.done);
    expectCompleted(await world.run(approvedArgs("p4")));
    expect(markers(world).length).toBe(1);
  }),
);
