import { expect } from "bun:test";
import {
  linkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  at,
  caseTest,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
  writeSyntheticOperation,
} from "./harness.ts";
import type { Run, World } from "./harness.ts";
import { holdLock, lockFree } from "./holder.ts";

const apply = (name: string, content = "v1", ...extra: string[]) => [
  "apply",
  name,
  "--content",
  content,
  ...extra,
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

function only(world: World): string {
  const [first, ...rest] = world.operations();
  if (!first || rest.length > 0) throw new Error("Expected one operation.");
  return first.id;
}
function expectUnresolvedBy(run: Run, id: string): void {
  expectRefusedUnchanged(run, "DOMAIN_SX_UNRESOLVED");
  expect(at(run.result.raw, "handoff", "inspect")).toEqual([
    { kind: "command", command: "sx.history", args: [id] },
  ]);
}

caseTest(
  "P01.a-symlink-alias",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const link = join(world.world, "alias-a");
    symlinkSync(world.note("a"), link);
    expectUnresolvedBy(await world.run(apply("x", "v2", "--path", link)), id);
    const dangling = join(world.world, "alias-new");
    symlinkSync(world.note("new"), dangling);
    await world.killAt(apply("new"), "intent");
    const second = world.operations().find((entry) => entry.id !== id)?.id;
    expectUnresolvedBy(
      await world.run(apply("y", "v2", "--path", dangling)),
      str(second ?? null),
    );
  }),
);

caseTest(
  "P01.b-hardlink-alias",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const hard = join(world.world, "hard-a");
    linkSync(world.note("a"), hard);
    expectUnresolvedBy(await world.run(apply("x", "v2", "--path", hard)), id);
  }),
);

caseTest(
  "P01.c-case-alias",
  plain(async (world) => {
    await world.killAt(apply("Note"), "intent");
    const id = only(world);
    expectUnresolvedBy(await world.run(apply("NOTE", "v2")), id);
    expectUnresolvedBy(await world.run(apply("note", "v2")), id);
  }),
);

caseTest(
  "P01.d-different-command-same-resource",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const id = only(world);
    expectUnresolvedBy(
      await world.run(["apply2", "a", "--content", "v2", "--json"]),
      id,
    );
  }),
);

caseTest(
  "P01.e-renamed-resource",
  plain(async (world) => {
    expectCompleted(await world.run(apply("a")));
    await world.killAt(apply("a", "v2"), "effect");
    const id = world
      .operations()
      .find((entry) => entry.events.records.length === 1)?.id;
    renameSync(world.note("a"), world.note("renamed"));
    expectUnresolvedBy(
      await world.run(apply("renamed", "v3")),
      str(id ?? null),
    );
  }),
);

caseTest(
  "P01.f-host-key-alias",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const id = only(world);
    writeFileSync(
      join(world.world, "ids.json"),
      JSON.stringify({ "opaque-7": "a" }),
    );
    expectUnresolvedBy(
      await world.run(apply("whatever", "v2", "--id", "opaque-7")),
      id,
    );
  }),
);

caseTest(
  "P01.g-distinct-resource-proceeds",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    expectCompleted(await world.run(apply("b")));
    expect(world.noteLedger("b")).toBe(1);
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest(
  "P02.a-proven-disjoint-proceeds",
  plain(async (world) => {
    await world.killAt(apply("x"), "intent");
    const unresolved = only(world);
    const live = world.start(apply("y"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    expectCompleted(await world.run(apply("z")));
    expect(world.noteLedger("z")).toBe(1);
    expect(lockFree(join(world.root, "coordination", "admission.lock"))).toBe(
      true,
    );
    live.release("intent");
    expectCompleted(await live.done);
    expect(await world.pendingIds()).toEqual([unresolved]);
  }),
);

caseTest(
  "P03.a-unknown-scope-conflicts",
  plain(async (world) => {
    await world.killAt(apply("a"), "intent");
    const id = only(world);
    expectUnresolvedBy(
      await world.run(apply("c", "v1", "--unknown-scope")),
      id,
    );
    const other = makeWorld();
    try {
      await other.killAt(apply("q", "v1", "--unknown-scope"), "intent");
      const unknown = only(other);
      expectUnresolvedBy(await other.run(apply("d")), unknown);
    } finally {
      other.dispose();
    }
  }),
);

caseTest(
  "P03.b-shared-invariant-conflicts",
  plain(async (world) => {
    await world.killAt(apply("a", "v1", "--invariant", "index"), "intent");
    const id = only(world);
    expectUnresolvedBy(
      await world.run(apply("b", "v1", "--invariant", "index")),
      id,
    );
    expectCompleted(await world.run(apply("c")));
  }),
);

caseTest(
  "P04.a-scope-before-coordination",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    try {
      const before = world.snapshot();
      const invalid = await world.run(["apply", "a", "--json"], {
        SX_ADMISSION_WAIT: "10000",
      });
      expect(invalid.exit).toBe(2);
      expect(invalid.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
      expect(world.snapshot()).toBe(before);
    } finally {
      release();
    }
  }),
  30_000,
);

caseTest(
  "P05.a-unresolved-case-station",
  plain(async (world) => {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const refused = await world.run(apply("a", "v2"));
    expectUnresolvedBy(refused, id);
    expect(refused.result.retryable).toBe(false);
    expect(at(refused.result.raw, "next")).toBeUndefined();
    expect(refused.result.causeCode).not.toBe("DOMAIN_SX_LOCK_HELD");
    expect(at(refused.result.raw, "repairAction")).toContain(
      "Never replay the interrupted operation",
    );
  }),
);

caseTest(
  "P06.a-two-overlapping-contenders",
  plain(async (world) => {
    const bars = [join(world.base, "b1"), join(world.base, "b2")];
    for (const directory of bars) mkdirSync(directory);
    const contenders = bars.map((directory, index) =>
      world.start(apply("a", `v${index}`), {
        SX_BARRIER: "pre-admission,intent",
        SX_BARRIER_DIR: directory,
      }),
    );
    await Promise.all(
      contenders.map((child) => child.reached("pre-admission")),
    );
    for (const child of contenders) child.release("pre-admission");
    const settled = await Promise.race(
      contenders.map((child, index) => child.done.then(() => index)),
    );
    const loser = contenders[settled];
    const winner = contenders[1 - settled];
    if (!loser || !winner) throw new Error("No contenders.");
    expectRefusedUnchanged(await loser.done, "DOMAIN_SX_LOCK_HELD");
    await winner.reached("intent");
    expect(world.operations().length).toBe(1);
    winner.release("intent");
    expectCompleted(await winner.done);
    expect(world.noteLedger("a")).toBe(1);
  }),
);

caseTest("P06.b-contender-versus-closure", async () => {
  const world = makeWorld({ qualification: "fixture" });
  try {
    await world.killAt(apply("a"), "effect");
    const id = only(world);
    const revision = await world.revision(id);
    const closer = world.start(
      [
        "close",
        id,
        "--disposition",
        "completed",
        "--closure-id",
        "c1",
        "--revision",
        revision,
        "--reason",
        "read back",
        "--json",
      ],
      { SX_BARRIER: "closure-staged" },
    );
    await closer.reached("closure-staged");
    const during = await world.run(apply("a", "v2"));
    expectRefusedUnchanged(during, "DOMAIN_SX_LOCK_HELD");
    closer.release("closure-staged");
    expectCompleted(await closer.done);
    expectCompleted(await world.run(apply("a", "v3")));
    expect(world.noteLedger("a")).toBe(2);
  } finally {
    world.dispose();
  }
});

caseTest(
  "O01.a-held-lock-refusal",
  plain(async (world) => {
    const live = world.start(apply("a"), { SX_BARRIER: "intent" });
    await live.reached("intent");
    const id = only(world);
    const refused = await world.run(apply("a", "v2"));
    expectRefusedUnchanged(refused, "DOMAIN_SX_LOCK_HELD");
    expect(refused.exit).not.toBe(75);
    expect(refused.result.retryable).toBe(false);
    expect(at(refused.result.raw, "handoff", "inspect")).toEqual([
      { kind: "command", command: "sx.history", args: [id] },
    ]);
    expect(str(at(refused.result.raw, "repairAction"))).toContain(
      "never delete coordination files",
    );
    live.release("intent");
    expectCompleted(await live.done);
  }),
);

caseTest(
  "O02.a-lock-ordering",
  plain(async (world) => {
    const bars = [join(world.base, "o1"), join(world.base, "o2")];
    for (const directory of bars) mkdirSync(directory);
    const orders = [
      apply("a", "v1", "--also", "b"),
      ["apply", "b", "--content", "v1", "--also", "a", "--json"],
    ];
    const contenders = orders.map((argv, index) =>
      world.start(argv, {
        SX_BARRIER: "pre-admission,intent",
        SX_BARRIER_DIR: bars[index] ?? "",
      }),
    );
    await Promise.all(
      contenders.map((child) => child.reached("pre-admission")),
    );
    for (const child of contenders) child.release("pre-admission");
    const settled = await Promise.race(
      contenders.map((child, index) => child.done.then(() => index)),
    );
    const loser = contenders[settled];
    const winner = contenders[1 - settled];
    if (!loser || !winner) throw new Error("No contenders.");
    expectRefusedUnchanged(await loser.done, "DOMAIN_SX_LOCK_HELD");
    await winner.reached("intent");
    winner.release("intent");
    expectCompleted(await winner.done);
    expectCompleted(await world.run(orders[settled] ?? []));
    const recorded = world
      .operations()
      .map((entry) => at(entry.intent, "coordination"));
    expect(recorded.length).toBe(2);
    for (const order of recorded) {
      if (!Array.isArray(order)) throw new Error("No order.");
      const names = order.map((entry) => str(entry));
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect([...names].sort()).toEqual(names);
    }
  }),
);

caseTest(
  "O03.a-bounded-admission-wait",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    try {
      const before = readdirSync(join(world.root, "operations"));
      const refused = await world.run(apply("a"), { SX_ADMISSION_WAIT: "200" });
      expect(refused.exit).toBe(75);
      expect(refused.result.causeCode).toBe("TRANSIENT_NOT_STARTED");
      expect(readdirSync(join(world.root, "operations"))).toEqual(before);
    } finally {
      release();
    }
  }),
);

caseTest(
  "O03.b-signal-during-wait",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    try {
      const child = world.start(apply("a"), {
        SX_BARRIER: "pre-admission",
        SX_ADMISSION_WAIT: "10000",
      });
      await child.reached("pre-admission");
      child.release("pre-admission");
      child.kill("SIGTERM");
      const result = await child.done;
      expect(result.exit).toBe(143);
      expect(result.stdout).toBe("");
      expect(world.operations().length).toBe(1);
    } finally {
      release();
    }
  }),
);

caseTest(
  "O03.c-deadline-during-wait",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    try {
      const run = await world.run(
        ["apply", "a", "--content", "v1", "--deadline-ms", "300", "--json"],
        { SX_ADMISSION_WAIT: "10000" },
      );
      expect(str(run.result.causeCode)).toMatch(/^DOMAIN_DEADLINE_/);
      expect(run.exit).toBe(3);
      expect(world.operations().length).toBe(1);
    } finally {
      release();
    }
  }),
);

caseTest(
  "P03.c-incomplete-scope-conflicts",
  plain(async (world) => {
    await world.killAt(apply("c"), "intent");
    const id = only(world);
    expectUnresolvedBy(
      await world.run(apply("x", "v1", "--path", "relative/x", "--also", "b")),
      id,
    );
    expect(world.noteLedger("b")).toBe(0);
  }),
);

caseTest(
  "P06.c-admission-held-until-intent-published",
  plain(async (world) => {
    const writer = world.start(apply("w", "v1", "--unknown-scope"), {
      SX_BARRIER: "staged",
    });
    await writer.reached("staged");
    const contender = await world.run(apply("y"), {
      SX_ADMISSION_WAIT: "300",
    });
    expect(contender.exit).toBe(75);
    expect(contender.result.causeCode).toBe("TRANSIENT_NOT_STARTED");
    expect(world.noteLedger("y")).toBe(0);
    expect(world.operations()).toEqual([]);
    writer.release("staged");
    expectCompleted(await writer.done);
  }),
);

caseTest(
  "P06.d-unresolved-scan-under-admission",
  plain(async (world) => {
    expectCompleted(await world.run(apply("seed")));
    const release = holdLock(
      join(world.root, "coordination", "admission.lock"),
    );
    let released = false;
    try {
      const contender = world.start(apply("a"), {
        SX_BARRIER: "admission-wait",
        SX_ADMISSION_WAIT: "20000",
      });
      await contender.reached("admission-wait");
      contender.release("admission-wait");
      const synthetic = writeSyntheticOperation(world.root, world.note("a"));
      release();
      released = true;
      expectUnresolvedBy(await contender.done, synthetic);
      expect(world.noteLedger("a")).toBe(0);
    } finally {
      if (!released) release();
    }
  }),
  60_000,
);
