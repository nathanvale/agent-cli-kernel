import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  appendSettlingEvent,
  appendStartedEvent,
  commitClosure,
  layout,
  moveSettledCase,
  readClosure,
  stageClosure,
  unflaggedWriteGate,
} from "../../../kernel/src/addons/state/store.ts";
import type { Closure } from "../../../kernel/src/addons/state/store.ts";
import { spawnBounded } from "../../support/process.ts";
import {
  closeArgs,
  expectCompleted,
  makeWorld,
  only,
  supportingTest,
} from "./harness.ts";
import type { World } from "./harness.ts";

const specimen = join(import.meta.dir, "fixtures", "specimen.ts");
const apply = (name: string) => ["apply", name, "--content", "v1", "--json"];
const fifoBoundMilliseconds = 5_000;
const fifoLeaves = ["format", "intent", "events", "closure"] as const;
type FifoLeaf = (typeof fifoLeaves)[number];

async function within(body: (world: World) => Promise<void>): Promise<void> {
  const world = makeWorld({ qualification: "fixture" });
  try {
    await body(world);
  } finally {
    world.dispose();
  }
}

async function unresolvedCase(world: World): Promise<string> {
  await world.killAt(apply("a"), "effect");
  return only(world);
}

async function closedCase(world: World): Promise<string> {
  const id = await unresolvedCase(world);
  expectCompleted(await world.run(closeArgs(id, await world.revision(id))));
  return id;
}

function linkCaseFolderOutside(
  world: World,
  folderPath: string,
  id: string,
): string {
  const outsideParent = join(world.base, "outside");
  mkdirSync(outsideParent, { recursive: true });
  const outside = join(outsideParent, id);
  renameSync(folderPath, outside);
  symlinkSync(outside, folderPath);
  return outside;
}

function sampleClosure(id: string): Closure {
  return {
    operationId: id,
    closureId: "closure-1",
    disposition: "not-applied",
    reason: "test closure",
    evidence: [],
    authority: null,
    journalRevision: "r-test",
    qualification: "fixture:specimen",
    recoveryRunId: "run-test",
  };
}

function specimenEnvironment(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("SX_")) out[key] = value;
  return {
    ...out,
    SX_ROOT: world.root,
    SX_WORLD: world.world,
    SX_QUALIFICATION: "fixture",
  };
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function readString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string")
    throw new Error(`Expected string field ${key}.`);
  return value;
}

async function runBoundedSpecimen(
  world: World,
  argv: readonly string[],
): Promise<{
  readonly exit: number;
  readonly outcome: string;
  readonly causeCode: string;
  readonly message: string;
}> {
  const run = await spawnBounded([process.execPath, specimen, ...argv], {
    env: specimenEnvironment(world),
    boundMilliseconds: fifoBoundMilliseconds,
    processGroup: true,
  });
  const envelope = readObject(JSON.parse(run.stdout));
  const result = readObject(envelope.result);
  return {
    exit: run.exit,
    outcome: readString(result, "outcome"),
    causeCode: readString(result, "causeCode"),
    message: readString(envelope, "message"),
  };
}

function leafPath(world: World, id: string, leaf: FifoLeaf): string {
  return leaf === "format"
    ? join(world.root, "format")
    : join(world.root, "operations", id, leaf);
}

async function makeFifo(path: string): Promise<void> {
  const made = await spawnBounded(["mkfifo", path], {
    boundMilliseconds: fifoBoundMilliseconds,
  });
  expect(made.exit).toBe(0);
}

supportingTest(
  "journal ownership: a linked case folder is refused on store read, single-case read, and close, and writes no closure outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const revision = await world.revision(id);
      const outside = linkCaseFolderOutside(
        world,
        join(world.root, "operations", id),
        id,
      );

      const pending = await world.run(["pending", "--json"]);
      const history = await world.history(id);
      const admission = await world.run(apply("b"));
      const close = await world.run(closeArgs(id, revision));

      expect(pending.result.outcome).toBe("refused");
      expect(history.result.outcome).toBe("refused");
      expect(admission.result.outcome).toBe("refused");
      expect(close.result.outcome).toBe("refused");
      expect(world.noteLedger("b")).toBe(0);
      expect(existsSync(join(outside, "closure"))).toBe(false);
    }),
);

supportingTest(
  "journal ownership: a linked case folder under settled/ is refused on single-case and closure reads",
  () =>
    within(async (world) => {
      const id = await closedCase(world);
      const paths = layout(world.root);
      mkdirSync(paths.settled, { recursive: true, mode: 0o700 });
      const settledFolder = paths.settledCase(id);
      renameSync(paths.operation(id), settledFolder);
      linkCaseFolderOutside(world, settledFolder, id);

      const history = await world.history(id);
      expect(history.result.outcome).toBe("refused");
      expect(readClosure(paths, id)).toBe("unreadable");
    }),
);

supportingTest(
  "journal ownership: writing a closing record refuses a linked case folder and writes nothing outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      const outside = linkCaseFolderOutside(world, paths.operation(id), id);
      const staged = stageClosure(gate, paths, sampleClosure(id));

      expect(() => commitClosure(gate, paths, id, staged)).toThrow(
        /not a private directory/,
      );
      expect(existsSync(join(outside, "closure"))).toBe(false);
    }),
);

supportingTest(
  "journal ownership: moving a settled case refuses a linked case folder",
  () =>
    within(async (world) => {
      const id = await closedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      mkdirSync(paths.settled, { recursive: true, mode: 0o700 });
      linkCaseFolderOutside(world, paths.operation(id), id);

      expect(() => moveSettledCase(gate, paths, id)).toThrow(
        /not a private directory/,
      );
      expect(existsSync(paths.settledCase(id))).toBe(false);
    }),
);

supportingTest(
  "journal ownership: writing an event record refuses a linked case folder and writes nothing outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      const outside = linkCaseFolderOutside(world, paths.operation(id), id);
      const eventsPath = join(paths.operation(id), "events");
      const before = readFileSync(join(outside, "events"));

      expect(() =>
        appendStartedEvent(gate, eventsPath, "effect-started", {
          effect: "note.write",
        }),
      ).toThrow(/not a private directory/);
      expect(() => appendSettlingEvent(eventsPath, "not-applied", {})).toThrow(
        /not a private directory/,
      );
      expect(readFileSync(join(outside, "events")).equals(before)).toBe(true);
    }),
);

supportingTest(
  "journal ownership: writing an event record refuses a FIFO events file without blocking",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const eventsPath = join(world.root, "operations", id, "events");
      rmSync(eventsPath);
      await makeFifo(eventsPath);

      const storeModule = join(
        import.meta.dir,
        "../../../kernel/src/addons/state/store.ts",
      );
      const run = await spawnBounded(
        [
          process.execPath,
          "-e",
          `import { appendSettlingEvent } from ${JSON.stringify(storeModule)};
try {
  appendSettlingEvent(${JSON.stringify(eventsPath)}, "not-applied", {});
  console.log("APPENDED");
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}`,
        ],
        {
          boundMilliseconds: fifoBoundMilliseconds,
          processGroup: true,
        },
      );
      expect(run.exit).toBe(0);
      expect(run.stdout.trim()).toMatch(/not a regular file/);
    }),
);

for (const leaf of fifoLeaves) {
  supportingTest(
    `journal ownership: a FIFO at ${leaf} is refused without blocking under the bounded runner`,
    () =>
      within(async (world) => {
        const id = await closedCase(world);
        const target = leafPath(world, id, leaf);
        rmSync(target);
        await makeFifo(target);

        const pending = await runBoundedSpecimen(world, ["pending", "--json"]);
        const history = await runBoundedSpecimen(world, [
          "history",
          id,
          "--json",
        ]);
        const admission = await runBoundedSpecimen(world, apply("b"));

        expect(pending.outcome).toBe("refused");
        expect(history.outcome).toBe("refused");
        expect(admission.outcome).toBe("refused");
        expect(world.noteLedger("b")).toBe(0);
      }),
  );
}

supportingTest(
  "journal ownership: a stray non-directory entry in operations/ or settled/ is skipped and the journal stays usable",
  () =>
    within(async (world) => {
      expectCompleted(await world.run(apply("a")));
      writeFileSync(join(world.root, "operations", ".DS_Store"), "");
      mkdirSync(join(world.root, "settled"), { recursive: true, mode: 0o700 });
      writeFileSync(join(world.root, "settled", ".DS_Store"), "");

      const pending = await world.run(["pending", "--json"]);
      const admission = await world.run(apply("b"));

      expect(pending.result.outcome).toBe("success");
      expect(admission.result.outcome).toBe("success");
      expectCompleted(admission);
      expect(world.noteLedger("b")).toBe(1);
    }),
);

supportingTest(
  "journal ownership: a misnamed folder in operations/ is refused and the refusal names it",
  () =>
    within(async (world) => {
      expectCompleted(await world.run(apply("a")));
      mkdirSync(join(world.root, "operations", "stray-folder"), {
        mode: 0o700,
      });

      const pending = await world.run(["pending", "--json"]);
      const admission = await world.run(apply("b"));

      expect(pending.result.outcome).toBe("refused");
      expect(pending.result.causeCode).toBe("SCHEMA_SX_STATE_UNREADABLE");
      expect(pending.envelope.message).toContain("stray-folder");
      expect(admission.result.outcome).toBe("refused");
      expect(admission.result.causeCode).toBe("DOMAIN_SX_UNAVAILABLE");
      expect(admission.envelope.message).toContain("stray-folder");
      expect(world.noteLedger("b")).toBe(0);
    }),
);

supportingTest(
  "journal ownership: an unresolved case is never skipped alongside a stray entry",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      writeFileSync(join(world.root, "operations", ".DS_Store"), "");

      const pending = await world.run(["pending", "--json"]);
      const admission = await world.run(apply("a"));

      expect(pending.result.outcome).toBe("success");
      const data = readObject(readObject(pending.result.raw).data);
      const unfinished = Array.isArray(data.unfinished) ? data.unfinished : [];
      const ids = unfinished.map((entry) =>
        readString(readObject(entry), "operationId"),
      );
      expect(ids).toContain(id);
      expect(admission.result.outcome).toBe("refused");
      expect(admission.result.causeCode).toBe("DOMAIN_SX_UNRESOLVED");
    }),
);
