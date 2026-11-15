// Real child-process T4 cases. Each driver is a separate Bun process using
// the real approval add-on, a kernel-issued ExclusiveScope from the
// disposable coordination fixture, and readiness barriers. Grant, ledger,
// lock and effect state are read independently after the named barrier or
// after the process terminated.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  readFile,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  approval,
  authorityLocation,
} from "../../../starters/contract3/src/addons/approval/index.ts";
import { contractFor } from "../../../starters/contract3/src/kernel/index.ts";
import {
  Driver,
  applyConfig,
  createWorld,
  expectedFor,
  grant,
  markerName,
  materialize,
  observation,
  removeAll,
  run,
  snapshot,
  writeGrant,
} from "./harness.ts";
import type { DriverConfig, World } from "./harness.ts";

let tree: Awaited<ReturnType<typeof materialize>>;
let world: World;
beforeAll(async () => {
  tree = await materialize();
});
afterAll(async () => {
  await removeAll(tree.root);
});
beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await removeAll(world.root);
});

const approvalMarker = markerName(["approval", grant.preview]);
const boundary = contractFor({ cli: "boundary", commands: [] }).boundary;
const clean = { exit: 0, signal: null, stderr: "" };

function phases(events: readonly unknown[]): string[] {
  return events.map((event) => JSON.stringify(event));
}
function applyOutcome(events: readonly unknown[]): string {
  const seen = phases(events);
  if (seen.includes('{"phase":"lock-refused"}')) return "lock-refused";
  if (seen.some((item) => item.startsWith('{"phase":"consume","error"')))
    return "coordination-error";
  if (seen.includes('{"phase":"effect"}') && seen.includes('{"phase":"done"}'))
    return "admitted";
  return "denied";
}
function authorityOutcome(events: readonly unknown[]): string {
  const seen = phases(events);
  if (seen.some((item) => item.startsWith('{"phase":"consume","error"')))
    return "coordination-error";
  if (seen.includes('{"phase":"consume","status":"verified"}'))
    return "verified";
  return "refused";
}
function apply(runId: string, overrides: DriverConfig = {}) {
  return run(tree.driver, applyConfig(world, runId, overrides));
}
function startApply(runId: string, overrides: DriverConfig = {}) {
  return new Driver(tree.driver, applyConfig(world, runId, overrides));
}
async function holder() {
  const held = new Driver(tree.driver, { mode: "hold", world });
  expect(await held.next()).toEqual({ barrier: "holding" });
  return held;
}
async function lockHeld(): Promise<boolean> {
  try {
    return (await stat(world.lock)).isDirectory();
  } catch {
    return false;
  }
}
function inspect() {
  const { capability } = approval({
    operation: grant.operation,
    runId: "inspection",
    store: { grants: world.grants, ledger: world.ledger },
    now: () => 1000,
  });
  return capability.check({
    authority: boundary.authority(grant.authority),
    resource: boundary.resource(grant.resource),
    resourceRevision: "r0",
    effects: grant.effects,
    preview: grant.preview,
  });
}

test("the materialized fixture tree compiles against the stamped sources", async () => {
  const child = Bun.spawn(
    [
      join(tree.root, "node_modules/.bin/tsc"),
      "--noEmit",
      "-p",
      "tsconfig.json",
    ],
    { cwd: tree.root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exit] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect({ exit, stdout }).toEqual({ exit: 0, stdout: "" });
});

test("A01.b-apply-consumes-once", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const result = await apply("run-1");
  const after = await snapshot(world);
  expect(result).toMatchObject(clean);
  expect(after.markers).toEqual([approvalMarker]);
  expect(after.effects).toEqual(["run-1"]);
  expect(observation(applyOutcome(result.events), before, after)).toEqual(
    expectedFor("A01.b-apply-consumes-once"),
  );
});

// Valid twin is the last invocation of each A02 run: it reaches the handler.
const inputCases: readonly (readonly [string, readonly string[]])[] = [
  ["A02.a-malformed-syntax", ["--bogus", "p-1"]],
  ["A02.b-invalid-decoded-input", [""]],
  ["A02.c-invalid-future-binding", ["p-123456789"]],
];
for (const [id, argv] of inputCases)
  test(id, async () => {
    await writeGrant(world, grant);
    const before = await snapshot(world);
    const result = await run(tree.driver, {
      mode: "kernel",
      world,
      invocations: [argv, ["p-1"]],
    });
    const after = await snapshot(world);
    expect(result).toMatchObject(clean);
    const [refusal, twin] = result.events.filter((event) =>
      JSON.stringify(event).startsWith('{"phase":"kernel"'),
    );
    expect(refusal).toMatchObject({ result: { ok: false } });
    expect(refusal).not.toMatchObject({ result: { path: "approval" } });
    expect(twin).toEqual({ phase: "kernel", index: 1, result: { ok: true } });
    expect(phases(result.events)).toContain('{"phase":"handler"}');
    // Externally observable authority contact: only the valid twin.
    expect(await readFile(world.contacts, "utf8")).toBe("kernel-1\n");
    const outcome = JSON.stringify(refusal).includes('"path":"approval"')
      ? "denied"
      : "input-refused";
    expect(observation(outcome, before, after)).toEqual(expectedFor(id));
  });

test("A03.f-identical-kernel-refusal", async () => {
  await writeGrant(
    world,
    { ...grant, preview: "p-exp", expiresAt: 1000 },
    "p-exp",
  );
  await writeGrant(
    world,
    { ...grant, preview: "p-rev", resourceRevision: "r9" },
    "p-rev",
  );
  await writeGrant(world, { ...grant, preview: "p-used" }, "p-used");
  await writeFile(join(world.ledger, markerName(["approval", "p-used"])), "");
  await writeGrant(
    world,
    { ...grant, preview: "p-op", operation: "x.y" },
    "p-op",
  );
  const before = await snapshot(world);
  const result = await run(tree.driver, {
    mode: "kernel",
    world,
    invocations: [["p-miss"], ["p-exp"], ["p-rev"], ["p-used"], ["p-op"]],
  });
  const after = await snapshot(world);
  expect(result).toMatchObject(clean);
  const refusals = result.events.flatMap((event) =>
    typeof event === "object" && event !== null && "result" in event
      ? [JSON.stringify(event.result)]
      : [],
  );
  expect(refusals).toEqual(
    Array.from({ length: 5 }, () =>
      JSON.stringify({
        ok: false,
        path: "approval",
        reason: "approval required",
      }),
    ),
  );
  expect(phases(result.events)).not.toContain('{"phase":"handler"}');
  expect(observation("denied", before, after)).toEqual(
    expectedFor("A03.f-identical-kernel-refusal"),
  );
});

test("A03.g-identical-consume-refusal", async () => {
  const mutations: readonly (() => Promise<void>)[] = [
    () => removeAll(join(world.grants)).then(() => mkdir(world.grants)),
    () => writeFile(world.clock, "9000"),
    () => writeFile(join(world.ledger, approvalMarker), ""),
    () => writeGrant(world, { ...grant, operation: "fixture.other" }),
  ];
  const consumeEvents: string[] = [];
  for (const [index, mutate] of mutations.entries()) {
    await removeAll(world.ledger);
    await mkdir(world.ledger);
    await writeFile(world.clock, "1000");
    await writeGrant(world, grant);
    const driver = startApply(`run-${index}`, {
      barriers: ["after-preflight"],
    });
    expect(await driver.next()).toEqual({ phase: "preflight", admitted: true });
    expect(await driver.next()).toEqual({ barrier: "after-preflight" });
    await mutate();
    const before = await snapshot(world);
    await driver.go();
    expect(await driver.finish()).toMatchObject(clean);
    const after = await snapshot(world);
    consumeEvents.push(
      ...phases(driver.events).filter((item) => item.includes('"consume"')),
    );
    expect(observation(applyOutcome(driver.events), before, after)).toEqual(
      expectedFor("A03.g-identical-consume-refusal"),
    );
  }
  expect(consumeEvents).toEqual(
    Array.from({ length: 4 }, () => '{"phase":"consume","admitted":false}'),
  );
});

const waits: readonly (readonly [string, () => Promise<void>])[] = [
  ["A06.a-expire", () => writeFile(world.clock, "5000")],
  ["A06.b-revision", () => writeFile(world.revision, "r1")],
  [
    "A06.c-effects",
    () => writeGrant(world, { ...grant, effects: ["note.index"] }),
  ],
  [
    "A06.d-authority",
    () => writeGrant(world, { ...grant, authority: "owner-b" }),
  ],
  ["A06.e-operation", () => writeGrant(world, { ...grant, operation: "x.y" })],
];
for (const [id, change] of waits)
  test(id, async () => {
    await writeGrant(world, grant);
    const held = await holder();
    const driver = startApply("waiter", {
      lock: "wait",
      barriers: ["after-preflight"],
    });
    expect(await driver.next()).toEqual({ phase: "preflight", admitted: true });
    expect(await driver.next()).toEqual({ barrier: "after-preflight" });
    await driver.go();
    // The driver cannot acquire while the holder owns the scope.
    await change();
    const before = await snapshot(world);
    await held.go();
    expect(await held.finish()).toMatchObject(clean);
    expect(await driver.finish()).toMatchObject(clean);
    expect(phases(driver.events)).toContain(
      '{"phase":"consume","admitted":false}',
    );
    expect(
      observation(applyOutcome(driver.events), before, await snapshot(world)),
    ).toEqual(expectedFor(id));
  });

test("A07.a-refusal-preserves and A07.b-later-success-once", async () => {
  await writeGrant(world, grant);
  const held = await holder();
  const before = await snapshot(world);
  const refused = await apply("refused");
  const middle = await snapshot(world);
  expect(refused).toMatchObject(clean);
  expect(observation(applyOutcome(refused.events), before, middle)).toEqual(
    expectedFor("A07.a-refusal-preserves"),
  );
  await held.go();
  expect(await held.finish()).toMatchObject(clean);
  const later = await apply("later");
  const after = await snapshot(world);
  expect(observation(applyOutcome(later.events), middle, after)).toEqual(
    expectedFor("A07.b-later-success-once"),
  );
  expect(applyOutcome((await apply("again")).events)).toBe("denied");
  expect((await snapshot(world)).effects).toEqual(["later"]);
});

test("A08.a-locked-contenders", async () => {
  await writeGrant(world, grant);
  const held = await holder();
  const contenders = ["left", "right"].map((runId) =>
    startApply(runId, { lock: "wait", barriers: ["after-preflight"] }),
  );
  for (const contender of contenders) {
    expect(await contender.next()).toEqual({
      phase: "preflight",
      admitted: true,
    });
    expect(await contender.next()).toEqual({ barrier: "after-preflight" });
  }
  const before = await snapshot(world);
  await Promise.all(contenders.map((contender) => contender.go()));
  await held.go();
  expect(await held.finish()).toMatchObject(clean);
  for (const contender of contenders)
    expect(await contender.finish()).toMatchObject(clean);
  const after = await snapshot(world);
  const consumes = contenders.flatMap((contender) =>
    phases(contender.events).filter((item) => item.includes('"consume"')),
  );
  expect(consumes.sort()).toEqual([
    '{"phase":"consume","admitted":false}',
    '{"phase":"consume","admitted":true}',
  ]);
  expect(after.markers).toEqual([approvalMarker]);
  expect(observation("admitted", before, after)).toEqual(
    expectedFor("A08.a-locked-contenders"),
  );
});

test("A08.b-consumption-atomic-without-lock", async () => {
  await writeGrant(world, grant);
  const contenders = ["left", "right"].map((runId) =>
    startApply(runId, { lock: "private", barriers: ["after-acquire"] }),
  );
  for (const contender of contenders) {
    expect(await contender.next()).toEqual({
      phase: "preflight",
      admitted: true,
    });
    expect(await contender.next()).toEqual({ phase: "acquired" });
    expect(await contender.next()).toEqual({ barrier: "after-acquire" });
  }
  const before = await snapshot(world);
  await Promise.all(contenders.map((contender) => contender.go()));
  for (const contender of contenders)
    expect(await contender.finish()).toMatchObject(clean);
  const after = await snapshot(world);
  const admitted = contenders.filter((contender) =>
    phases(contender.events).includes('{"phase":"consume","admitted":true}'),
  );
  expect(admitted.length).toBe(1);
  expect(observation("admitted", before, after)).toEqual(
    expectedFor("A08.b-consumption-atomic-without-lock"),
  );
});

test("A09.a-phase-observations", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const driver = startApply("ordered", {
    barriers: [
      "after-preflight",
      "after-acquire",
      "after-consume",
      "after-effect",
    ],
  });
  expect(await driver.next()).toEqual({ phase: "preflight", admitted: true });
  expect(await driver.next()).toEqual({ barrier: "after-preflight" });
  expect(await snapshot(world)).toEqual(before);
  expect(await lockHeld()).toBe(false);
  await driver.go();
  expect(await driver.next()).toEqual({ phase: "acquired" });
  expect(await driver.next()).toEqual({ barrier: "after-acquire" });
  expect(await snapshot(world)).toEqual(before);
  const probe = await run(tree.driver, { mode: "hold", world });
  expect(phases(probe.events)).toEqual(['{"phase":"lock-refused"}']);
  await driver.go();
  expect(await driver.next()).toEqual({ phase: "consume", admitted: true });
  expect(await driver.next()).toEqual({ barrier: "after-consume" });
  const consumed = await snapshot(world);
  expect(consumed.markers).toEqual([approvalMarker]);
  expect(consumed.effects).toEqual([]);
  expect(
    JSON.parse(await readFile(join(world.ledger, approvalMarker), "utf8")),
  ).toEqual({ kind: "approval", runId: "ordered", consumedAt: 1000 });
  await driver.go();
  expect(await driver.next()).toEqual({ phase: "effect" });
  expect(await driver.next()).toEqual({ barrier: "after-effect" });
  expect((await snapshot(world)).effects).toEqual(["ordered"]);
  expect(await lockHeld()).toBe(true);
  await driver.go();
  expect(await driver.finish()).toMatchObject(clean);
  expect(await lockHeld()).toBe(false);
  expect(
    observation(applyOutcome(driver.events), before, await snapshot(world)),
  ).toEqual(expectedFor("A09.a-phase-observations"));
});

test("A09.b-inactive-coordination", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const result = await apply("released", { coordination: "released" });
  expect(result).toMatchObject(clean);
  expect(
    observation(applyOutcome(result.events), before, await snapshot(world)),
  ).toEqual(expectedFor("A09.b-inactive-coordination"));
  expect(await inspect()).toBe(true);
});

test("A09.c-foreign-scope", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const outcomes = [];
  for (const coordination of ["foreign-scope", "foreign-run"]) {
    const result = await apply(coordination, { coordination });
    expect(result).toMatchObject(clean);
    outcomes.push(applyOutcome(result.events));
  }
  expect(outcomes).toEqual(["coordination-error", "coordination-error"]);
  expect(observation(outcomes[0] ?? "", before, await snapshot(world))).toEqual(
    expectedFor("A09.c-foreign-scope"),
  );
});

async function killAt(barrier: string, runId = "victim") {
  const driver = startApply(runId, { barriers: [barrier] });
  for (;;) {
    const event = await driver.next();
    if (JSON.stringify(event) === JSON.stringify({ barrier })) break;
    if (event === undefined) throw new Error("Barrier not reached.");
  }
  driver.kill();
  return driver.finish();
}
async function qualifiedFixtureRelease(): Promise<void> {
  // Test-owned recovery: the sole owner's SIGKILL was observed directly.
  // This is not T3 reclaim and never assumes stale-lock deletion is safe.
  if (await lockHeld()) await rmdir(world.lock);
}

test("A10.a-kill-after-preflight", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const killed = await killAt("after-preflight");
  expect(killed.signal).toBe("SIGKILL");
  const after = await snapshot(world);
  expect(observation("killed", before, after)).toEqual(
    expectedFor("A10.a-kill-after-preflight"),
  );
  expect(await inspect()).toBe(true);
  expect((await snapshot(world)).effects).toEqual([]);
});

test("A10.b-kill-after-acquire", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const killed = await killAt("after-acquire");
  expect(killed.signal).toBe("SIGKILL");
  expect(observation("killed", before, await snapshot(world))).toEqual(
    expectedFor("A10.b-kill-after-acquire"),
  );
  expect(await lockHeld()).toBe(true);
  expect(applyOutcome((await apply("blocked")).events)).toBe("lock-refused");
  await qualifiedFixtureRelease();
  expect(applyOutcome((await apply("retry")).events)).toBe("admitted");
  expect((await snapshot(world)).effects).toEqual(["retry"]);
});

test("A11.a-kill-after-consume", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const killed = await killAt("after-consume");
  expect(killed.signal).toBe("SIGKILL");
  expect(observation("killed", before, await snapshot(world))).toEqual(
    expectedFor("A11.a-kill-after-consume"),
  );
  await qualifiedFixtureRelease();
  expect(await inspect()).toBe(false);
  expect(applyOutcome((await apply("repeat")).events)).toBe("denied");
  const after = await snapshot(world);
  expect(after.markers).toEqual([approvalMarker]);
  expect(after.effects).toEqual([]);
});

test("A12.a-kill-after-effect", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  const killed = await killAt("after-effect");
  expect(killed.signal).toBe("SIGKILL");
  expect(observation("killed", before, await snapshot(world))).toEqual(
    expectedFor("A12.a-kill-after-effect"),
  );
  await qualifiedFixtureRelease();
  expect(applyOutcome((await apply("repeat")).events)).toBe("denied");
  expect((await snapshot(world)).effects).toEqual(["victim"]);
});

test("A13.a-torn-marker", async () => {
  const torn: readonly ((path: string) => Promise<void>)[] = [
    (path) => writeFile(path, ""),
    (path) => writeFile(path, '{"kind":"appr'),
    (path) => mkdir(path),
    (path) => symlink(join(world.root, "missing"), path),
  ];
  for (const [index, make] of torn.entries()) {
    await removeAll(world.ledger);
    await mkdir(world.ledger);
    await writeGrant(world, grant);
    const driver = startApply(`torn-${index}`, {
      barriers: ["after-preflight"],
    });
    expect(await driver.next()).toEqual({ phase: "preflight", admitted: true });
    expect(await driver.next()).toEqual({ barrier: "after-preflight" });
    await make(join(world.ledger, approvalMarker));
    const before = await snapshot(world);
    expect(await inspect()).toBe(false);
    await driver.go();
    expect(await driver.finish()).toMatchObject(clean);
    expect(
      observation(applyOutcome(driver.events), before, await snapshot(world)),
    ).toEqual(expectedFor("A13.a-torn-marker"));
  }
});

test("A14.a-reuse-denied and A14.b-reissued-grant-denied", async () => {
  await writeGrant(world, grant);
  expect(applyOutcome((await apply("first")).events)).toBe("admitted");
  const before = await snapshot(world);
  const reuse = await apply("reuse");
  const middle = await snapshot(world);
  expect(observation(applyOutcome(reuse.events), before, middle)).toEqual(
    expectedFor("A14.a-reuse-denied"),
  );
  await writeGrant(world, { ...grant, expiresAt: 9000 });
  const reissued = await apply("reissued");
  expect(
    observation(applyOutcome(reissued.events), middle, await snapshot(world)),
  ).toEqual(expectedFor("A14.b-reissued-grant-denied"));
  expect((await snapshot(world)).effects).toEqual(["first"]);
});

test("A15.a-inspection-under-held-lock", async () => {
  await writeGrant(world, grant);
  const held = await holder();
  const before = await snapshot(world);
  const admitted = await inspect();
  expect(await lockHeld()).toBe(true);
  const after = await snapshot(world);
  await held.go();
  expect(await held.finish()).toMatchObject(clean);
  expect(phases(held.events)).toEqual([
    '{"barrier":"holding"}',
    '{"phase":"done"}',
  ]);
  expect(observation(admitted ? "admitted" : "denied", before, after)).toEqual(
    expectedFor("A15.a-inspection-under-held-lock"),
  );
});

// Human authority records for the adversarial test source in the driver.
const closureRecord = {
  format: "contract3.closure-authority",
  version: 1,
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
  expiresAt: 5000,
};
const closureItem = {
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
};
const stopRecord = {
  format: "contract3.stop-attestation",
  version: 1,
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  expiresAt: 5000,
};
const stopItem = {
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  liveConflict: false,
};
const source = () => ({
  directory: world.authority,
  separated: () => Promise.resolve(true),
});
async function placeAuthority(): Promise<void> {
  await writeFile(
    authorityLocation(source(), "closure", ["op-1"]),
    JSON.stringify(closureRecord),
  );
  await writeFile(
    authorityLocation(source(), "stop", ["op-1", "owner-1"]),
    JSON.stringify(stopRecord),
  );
}
function itemFile(item: unknown): Promise<void> {
  return writeFile(join(world.root, "item.json"), JSON.stringify(item));
}
function authorityConfig(
  kind: "closure" | "stop",
  runId: string,
  overrides: DriverConfig = {},
): DriverConfig {
  return {
    mode: "authority",
    world,
    runId,
    kind,
    source: world.authority,
    item: join(world.root, "item.json"),
    lock: "refuse",
    barriers: [],
    ...overrides,
  };
}

const exactAuthority: readonly (readonly [
  string,
  "closure" | "stop",
  object,
  readonly string[],
])[] = [
  ["C01.a-exact-closure", "closure", closureItem, ["closure", "op-1"]],
  ["S01.a-exact-attestation", "stop", stopItem, ["stop", "op-1", "owner-1"]],
];
for (const [id, kind, item, parts] of exactAuthority)
  test(id, async () => {
    await placeAuthority();
    await itemFile(item);
    const before = await snapshot(world);
    const driver = new Driver(
      tree.driver,
      authorityConfig(kind, "authority-run", { barriers: ["after-preflight"] }),
    );
    expect(await driver.next()).toEqual({
      phase: "preflight",
      status: "verified",
    });
    expect(await driver.next()).toEqual({ barrier: "after-preflight" });
    expect(await snapshot(world)).toEqual(before);
    await driver.go();
    expect(await driver.finish()).toMatchObject(clean);
    const after = await snapshot(world);
    expect(after.markers).toEqual([markerName(parts)]);
    expect(observation(authorityOutcome(driver.events), before, after)).toEqual(
      expectedFor(id),
    );
    const again = await run(tree.driver, authorityConfig(kind, "again"));
    expect(phases(again.events)).toEqual([
      '{"phase":"preflight","status":"refused"}',
    ]);
  });

const changedWhileWaiting: readonly (readonly [
  string,
  "closure" | "stop",
  object,
  object,
])[] = [
  [
    "C02.e-change-while-waiting",
    "closure",
    closureItem,
    { ...closureItem, evidence: "ev-2" },
  ],
  ["S04.a-replaced-owner", "stop", stopItem, { ...stopItem, owner: "owner-2" }],
];
for (const [id, kind, item, changed] of changedWhileWaiting)
  test(id, async () => {
    await placeAuthority();
    await itemFile(item);
    const held = await holder();
    const driver = new Driver(
      tree.driver,
      authorityConfig(kind, "waiter", {
        lock: "wait",
        barriers: ["after-preflight"],
      }),
    );
    expect(await driver.next()).toEqual({
      phase: "preflight",
      status: "verified",
    });
    expect(await driver.next()).toEqual({ barrier: "after-preflight" });
    await driver.go();
    await itemFile(changed);
    const before = await snapshot(world);
    await held.go();
    expect(await held.finish()).toMatchObject(clean);
    expect(await driver.finish()).toMatchObject(clean);
    expect(
      observation(
        authorityOutcome(driver.events),
        before,
        await snapshot(world),
      ),
    ).toEqual(expectedFor(id));
  });

test("S03.a-inactive-coordination", async () => {
  await placeAuthority();
  await itemFile(stopItem);
  const before = await snapshot(world);
  const released = await run(
    tree.driver,
    authorityConfig("stop", "released", { coordination: "released" }),
  );
  expect(released).toMatchObject(clean);
  expect(
    observation(
      authorityOutcome(released.events),
      before,
      await snapshot(world),
    ),
  ).toEqual(expectedFor("S03.a-inactive-coordination"));
  // The still-valid attestation remains usable under real coordination.
  const later = await run(tree.driver, authorityConfig("stop", "later"));
  expect(authorityOutcome(later.events)).toBe("verified");
});

test("S05.a-kill-after-attestation-consume", async () => {
  await placeAuthority();
  await writeGrant(world, grant);
  await itemFile(stopItem);
  const before = await snapshot(world);
  const driver = new Driver(
    tree.driver,
    authorityConfig("stop", "victim", { barriers: ["after-consume"] }),
  );
  for (;;) {
    const event = await driver.next();
    if (JSON.stringify(event) === '{"barrier":"after-consume"}') break;
    if (event === undefined) throw new Error("Barrier not reached.");
  }
  driver.kill();
  expect((await driver.finish()).signal).toBe("SIGKILL");
  const after = await snapshot(world);
  expect(after.markers).toEqual([markerName(["stop", "op-1", "owner-1"])]);
  expect(observation("killed", before, after)).toEqual(
    expectedFor("S05.a-kill-after-attestation-consume"),
  );
  // No refund; closure and domain approval stay unconsumed.
  await qualifiedFixtureRelease();
  const repeat = await run(tree.driver, authorityConfig("stop", "repeat"));
  expect(phases(repeat.events)).toEqual([
    '{"phase":"preflight","status":"refused"}',
  ]);
  await itemFile(closureItem);
  const closure = await run(tree.driver, authorityConfig("closure", "closure"));
  expect(phases(closure.events)[0]).toBe(
    '{"phase":"preflight","status":"verified"}',
  );
  expect(await inspect()).toBe(true);
});

test("S06.c-approval-separate", async () => {
  await placeAuthority();
  await writeGrant(world, grant);
  await itemFile(stopItem);
  const takeover = await run(tree.driver, authorityConfig("stop", "takeover"));
  expect(authorityOutcome(takeover.events)).toBe("verified");
  const before = await snapshot(world);
  const applied = await apply("domain");
  expect(
    observation(applyOutcome(applied.events), before, await snapshot(world)),
  ).toEqual(expectedFor("S06.c-approval-separate"));
});
