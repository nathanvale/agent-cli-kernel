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
  storeProblem,
  unflaggedWriteGate,
} from "../../../kernel/src/addons/state/store.ts";
import type { Closure } from "../../../kernel/src/addons/state/store.ts";
import { readRootedFile } from "../../../kernel/src/shared/rooted-file.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  at,
  closeArgs,
  expectCompleted,
  formatRecord,
  journals,
  makeWorld,
  only,
  supportingTest,
} from "./harness.ts";
import type { Run, World } from "./harness.ts";

const specimen = join(import.meta.dir, "fixtures", "specimen.ts");
const swapPreload = join(import.meta.dir, "fixtures", "swap-folder-preload.ts");
const storeModule = join(
  import.meta.dir,
  "../../../kernel/src/addons/state/store.ts",
);
const apply = (name: string) => ["apply", name, "--content", "v1", "--json"];
const worldBoundMilliseconds = 60_000;
const fifoBoundMilliseconds = 30_000;
const fifoLeaves = ["format", "intent", "events", "closure"] as const;
type FifoLeaf = (typeof fifoLeaves)[number];
const production = { SX_ENTRY: "production" } as const;

function sequentialTimeout(worldRuns: number, boundedRuns = 0): number {
  return (
    worldRuns * worldBoundMilliseconds +
    boundedRuns * fifoBoundMilliseconds +
    10_000
  );
}

async function within(
  body: (world: World) => Promise<void>,
  options: { readonly qualification?: "fixture" } = {
    qualification: "fixture",
  },
): Promise<void> {
  const world = makeWorld(options);
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

function linkFolderOutside(
  world: World,
  folderPath: string,
  name: string,
): string {
  const outsideParent = join(world.base, "outside");
  mkdirSync(outsideParent, { recursive: true });
  const outside = join(outsideParent, name);
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

function specimenEnvironment(
  world: World,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("SX_")) out[key] = value;
  return {
    ...out,
    SX_ROOT: world.root,
    SX_WORLD: world.world,
    ...(extra.SX_ENTRY === "production" ? {} : { SX_QUALIFICATION: "fixture" }),
    ...extra,
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
  const value = Object.hasOwn(object, key) ? object[key] : undefined;
  if (typeof value !== "string")
    throw new Error(`Expected string field ${key}.`);
  return value;
}

function expectExactRefusal(
  run: Run,
  causeCode: string,
  message: string,
): void {
  expect(run.result.outcome).toBe("refused");
  expect(run.result.causeCode).toBe(causeCode);
  expect(run.envelope.message).toBe(message);
}

function expectExactError(action: () => unknown, expected: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof Error ? caught.message : "").toBe(expected);
}

async function runBoundedSpecimen(
  world: World,
  argv: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<{
  readonly exit: number;
  readonly outcome: string;
  readonly causeCode: string;
  readonly message: string;
}> {
  const run = await spawnBounded([process.execPath, specimen, ...argv], {
    env: specimenEnvironment(world, extra),
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

async function runAppendSettlingChild(
  eventsPath: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
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
      env: { ...process.env, ...extraEnv },
      boundMilliseconds: fifoBoundMilliseconds,
      processGroup: true,
    },
  );
  expect(run.exit).toBe(0);
  return run.stdout.trim();
}

supportingTest(
  "journal ownership: a linked case folder is refused on store read, single-case read, and close, and writes no closure outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const revision = await world.revision(id);
      const outside = linkFolderOutside(
        world,
        join(world.root, "operations", id),
        id,
      );

      const pending = await world.run(["pending", "--json"]);
      const history = await world.history(id);
      const admission = await world.run(apply("b"));
      const close = await world.run(closeArgs(id, revision));

      expectExactRefusal(
        pending,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
      expectExactRefusal(
        history,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
      expectExactRefusal(
        admission,
        "DOMAIN_SX_UNAVAILABLE",
        "State unavailable: store-corrupt.",
      );
      expectExactRefusal(
        close,
        "DOMAIN_SX_UNAVAILABLE",
        "State unavailable: store-corrupt.",
      );
      expect(world.noteLedger("b")).toBe(0);
      expect(existsSync(join(outside, "closure"))).toBe(false);
    }),
  sequentialTimeout(6),
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
      const outside = linkFolderOutside(world, settledFolder, id);

      const history = await world.history(id);
      expectExactRefusal(
        history,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
      expect(readClosure(paths, id)).toBe("unreadable");
      rmSync(join(outside, "closure"));
      expect(readClosure(paths, id)).toBe("unreadable");
    }),
  sequentialTimeout(4),
);

supportingTest(
  "journal ownership: writing a closing record refuses a linked case folder and writes nothing outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      const outside = linkFolderOutside(world, paths.operation(id), id);
      const staged = stageClosure(gate, paths, sampleClosure(id));

      expectExactError(
        () => commitClosure(gate, paths, id, staged),
        `Case folder ${id} is not a private directory.`,
      );
      expect(existsSync(join(outside, "closure"))).toBe(false);
    }),
  sequentialTimeout(1),
);

supportingTest(
  "journal ownership: moving a settled case refuses a linked case folder",
  () =>
    within(async (world) => {
      const id = await closedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      mkdirSync(paths.settled, { recursive: true, mode: 0o700 });
      linkFolderOutside(world, paths.operation(id), id);

      expectExactError(
        () => moveSettledCase(gate, paths, id),
        `Case folder ${id} is not a private directory.`,
      );
      expect(existsSync(paths.settledCase(id))).toBe(false);
    }),
  sequentialTimeout(3),
);

supportingTest(
  "journal ownership: writing an event record refuses a linked case folder and writes nothing outside the journal root",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      const outside = linkFolderOutside(world, paths.operation(id), id);
      const eventsPath = join(paths.operation(id), "events");
      const before = readFileSync(join(outside, "events"));

      expectExactError(
        () =>
          appendStartedEvent(gate, eventsPath, "effect-started", {
            effect: "note.write",
          }),
        "Case folder is not a private directory.",
      );
      expectExactError(
        () => appendSettlingEvent(eventsPath, "not-applied", {}),
        "Case folder is not a private directory.",
      );
      expect(readFileSync(join(outside, "events")).equals(before)).toBe(true);
    }),
  sequentialTimeout(1),
);

supportingTest(
  "journal ownership: writing an event record refuses a FIFO events file without blocking",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const eventsPath = join(world.root, "operations", id, "events");
      rmSync(eventsPath);
      await makeFifo(eventsPath);

      const output = await runAppendSettlingChild(eventsPath);
      expect(output).toBe("The journal events file is not a regular file.");
    }),
  sequentialTimeout(1, 2),
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

        expect(pending).toMatchObject({
          outcome: "refused",
          causeCode: "SCHEMA_SX_STATE_UNREADABLE",
          message: "The journal is unreadable.",
        });
        expect(history).toMatchObject({
          outcome: "refused",
          causeCode: "SCHEMA_SX_STATE_UNREADABLE",
          message: "The journal is unreadable.",
        });
        expect(admission).toMatchObject({
          outcome: "refused",
          causeCode: "DOMAIN_SX_UNAVAILABLE",
          message:
            leaf === "format"
              ? "State unavailable: store."
              : "State unavailable: store-unreadable.",
        });
        expect(world.noteLedger("b")).toBe(0);
      }),
    sequentialTimeout(3, 4),
  );
}

supportingTest(
  "journal ownership: a stray non-directory entry in operations/ or settled/ is skipped and the journal stays usable",
  () =>
    within(async (world) => {
      expectCompleted(await world.run(apply("a")));
      const id = only(world);
      writeFileSync(join(world.root, "operations", ".DS_Store"), "");
      mkdirSync(join(world.root, "settled"), { recursive: true, mode: 0o700 });
      writeFileSync(join(world.root, "settled", ".DS_Store"), "");

      const pending = await world.run(["pending", "--json"]);
      const admission = await world.run(apply("b"));
      const settledHistory = await world.history(id);

      expect(pending.result.outcome).toBe("success");
      expect(at(pending.result.raw, "data", "unfinished")).toEqual([]);
      expect(admission.result.outcome).toBe("success");
      expectCompleted(admission);
      expect(world.noteLedger("b")).toBe(1);
      expect(settledHistory.exit).toBe(0);
      expect(at(settledHistory.result.raw, "data", "operationId")).toBe(id);
      expect(at(settledHistory.result.raw, "data", "status")).toBe("completed");
    }),
  sequentialTimeout(4),
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

      expectExactRefusal(
        pending,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt (unexpected folder in journal: stray-folder).",
      );
      expectExactRefusal(
        admission,
        "DOMAIN_SX_UNAVAILABLE",
        "State unavailable: store-corrupt (unexpected folder in journal: stray-folder).",
      );
      expect(world.noteLedger("b")).toBe(0);
    }),
  sequentialTimeout(3),
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
      expectExactRefusal(
        admission,
        "DOMAIN_SX_UNRESOLVED",
        "An unfinished operation conflicts with this change.",
      );
    }),
  sequentialTimeout(3),
);

supportingTest(
  "journal ownership: post-open recheck refuses a case folder swapped for a link between check and open on read and event write",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const folder = join(world.root, "operations", id);
      const outsideParent = join(world.base, "outside");
      mkdirSync(outsideParent, { recursive: true });
      const outsideRead = join(outsideParent, `${id}-read`);
      const pending = await world.run(["pending", "--json"], {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "before-open",
        SX_SWAP_TRIGGER: join(folder, "intent"),
        SX_SWAP_FOLDER: folder,
        SX_SWAP_OUTSIDE: outsideRead,
      });
      expectExactRefusal(
        pending,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is unreadable.",
      );

      rmSync(folder);
      renameSync(outsideRead, folder);
      const outsideWrite = join(outsideParent, `${id}-write`);
      const before = readFileSync(join(folder, "events"));
      const output = await runAppendSettlingChild(join(folder, "events"), {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "before-open",
        SX_SWAP_TRIGGER: join(folder, "events"),
        SX_SWAP_FOLDER: folder,
        SX_SWAP_OUTSIDE: outsideWrite,
      });
      expect(output).toBe(
        "Case folder changed to a non-private directory during write.",
      );
      expect(readFileSync(join(outsideWrite, "events")).equals(before)).toBe(
        true,
      );
    }),
  sequentialTimeout(2, 1),
);

supportingTest(
  "journal ownership: post-open recheck refuses a journal file whose inode changes after open on read and event write",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const folder = join(world.root, "operations", id);
      const outsideParent = join(world.base, "outside");
      mkdirSync(outsideParent, { recursive: true });
      const outsideIntent = join(outsideParent, "intent-old");
      const pending = await world.run(["pending", "--json"], {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "after-open",
        SX_SWAP_TRIGGER: join(folder, "intent"),
        SX_SWAP_OUTSIDE: outsideIntent,
      });
      expectExactRefusal(
        pending,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is unreadable.",
      );

      const outsideEvents = join(outsideParent, "events-old");
      const before = readFileSync(join(folder, "events"));
      const output = await runAppendSettlingChild(join(folder, "events"), {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "after-open",
        SX_SWAP_TRIGGER: join(folder, "events"),
        SX_SWAP_OUTSIDE: outsideEvents,
      });
      expect(output).toBe("The journal events file changed during write.");
      expect(readFileSync(outsideEvents).equals(before)).toBe(true);
    }),
  sequentialTimeout(2, 1),
);

supportingTest(
  "journal ownership: post-open recheck refuses the same swap cases as readRootedFile",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const folder = join(world.root, "operations", id);
      const intentPath = join(folder, "intent");
      const outsideParent = join(world.base, "outside");
      mkdirSync(outsideParent, { recursive: true });

      const swappedInode = join(outsideParent, "rooted-inode");
      const rootedInode = readRootedFile(world.root, intentPath, 1_048_576, {
        afterOpen: () => {
          const bytes = readFileSync(intentPath);
          renameSync(intentPath, swappedInode);
          writeFileSync(intentPath, bytes, { mode: 0o600 });
        },
      });
      expect(rootedInode).toMatchObject({
        kind: "refused",
        reason: "outside-root",
      });

      const swappedFolder = join(outsideParent, "rooted-folder");
      const rootedFolder = readRootedFile(world.root, intentPath, 1_048_576, {
        afterOpen: () => {
          renameSync(folder, swappedFolder);
          symlinkSync(swappedFolder, folder);
        },
      });
      expect(rootedFolder).toMatchObject({
        kind: "refused",
        reason: "linked-folder",
      });
      rmSync(folder);
      renameSync(swappedFolder, folder);

      const pendingInode = await world.run(["pending", "--json"], {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "after-open",
        SX_SWAP_TRIGGER: intentPath,
        SX_SWAP_OUTSIDE: join(outsideParent, "store-inode"),
      });
      expectExactRefusal(
        pendingInode,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is unreadable.",
      );

      const pendingFolder = await world.run(["pending", "--json"], {
        BUN_OPTIONS: `--preload ${swapPreload}`,
        SX_SWAP_MODE: "before-open",
        SX_SWAP_TRIGGER: intentPath,
        SX_SWAP_FOLDER: folder,
        SX_SWAP_OUTSIDE: join(outsideParent, "store-folder"),
      });
      expectExactRefusal(
        pendingFolder,
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is unreadable.",
      );
    }),
  sequentialTimeout(3),
);

supportingTest(
  "journal ownership: storeProblem refuses a linked operations/ folder",
  () =>
    within(async (world) => {
      const id = await unresolvedCase(world);
      const paths = layout(world.root);
      linkFolderOutside(world, paths.operations, "operations");

      expect(storeProblem(paths)).toBe("corrupt");
      expectExactRefusal(
        await world.run(["pending", "--json"]),
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
      expectExactRefusal(
        await world.history(id),
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
    }),
  sequentialTimeout(3),
);

supportingTest(
  "journal ownership: storeProblem refuses a linked settled/ folder in every journal version",
  () =>
    within(async (world) => {
      const id = await closedCase(world);
      const paths = layout(world.root);
      writeFileSync(paths.format, formatRecord(journals.one));
      const outside = join(world.base, "outside-settled");
      mkdirSync(outside, { recursive: true, mode: 0o700 });
      if (existsSync(paths.settled)) rmSync(paths.settled, { recursive: true });
      symlinkSync(outside, paths.settled);

      expect(storeProblem(paths)).toBe("corrupt");
      expectExactRefusal(
        await world.history(id),
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );

      writeFileSync(paths.format, formatRecord(journals.two));
      expect(storeProblem(paths)).toBe("corrupt");
      expectExactRefusal(
        await world.history(id),
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
    }),
  sequentialTimeout(5),
);

supportingTest(
  "journal ownership: moving a settled case refuses a linked settled/ folder",
  () =>
    within(async (world) => {
      const id = await closedCase(world);
      const paths = layout(world.root);
      const gate = unflaggedWriteGate();
      const outside = join(world.base, "outside-settled");
      mkdirSync(outside, { recursive: true, mode: 0o700 });
      if (existsSync(paths.settled)) rmSync(paths.settled, { recursive: true });
      symlinkSync(outside, paths.settled);

      expectExactError(
        () => moveSettledCase(gate, paths, id),
        "Settled folder is not a private directory.",
      );
      expect(existsSync(join(outside, id))).toBe(false);
    }),
  sequentialTimeout(3),
);

supportingTest(
  "journal ownership: through index.ts a linked case folder and a FIFO are refused with exact causes",
  () =>
    within(async (world) => {
      expectCompleted(await world.run(apply("a"), production));
      const id = only(world);
      const folder = join(world.root, "operations", id);
      const outside = linkFolderOutside(world, folder, id);

      expectExactRefusal(
        await world.run(["pending", "--json"], production),
        "SCHEMA_SX_STATE_UNREADABLE",
        "The journal is corrupt.",
      );
      expectExactRefusal(
        await world.run(apply("b"), production),
        "DOMAIN_SX_UNAVAILABLE",
        "State unavailable: store-corrupt.",
      );
      expect(world.noteLedger("b")).toBe(0);

      rmSync(folder);
      renameSync(outside, folder);
      const intentPath = join(folder, "intent");
      rmSync(intentPath);
      await makeFifo(intentPath);

      const fifoPending = await runBoundedSpecimen(
        world,
        ["pending", "--json"],
        production,
      );
      expect(fifoPending).toMatchObject({
        outcome: "refused",
        causeCode: "SCHEMA_SX_STATE_UNREADABLE",
        message: "The journal is unreadable.",
      });
      expect(world.count("entry production")).toBe(4);
    }, {}),
  sequentialTimeout(3, 2),
);
