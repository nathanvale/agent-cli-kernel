// Test-owned harness for T4 approval cases. It owns the test identities
// (grant, human-authority records and items, the adversarial source), the
// independent restatement of the frozen file layouts, and the child-process
// driver. It materializes a copy of the stamped kernel and the approval
// add-on under test beside the disposable coordination fixture, and reads
// grant, ledger and effect state independently of the add-on.
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthoritySource,
  ClosureItem,
  StopItem,
} from "../../../starters/contract3/src/addons/approval/index.ts";
import { approvalCases } from "./cases.ts";

const repository = new URL("../../../", import.meta.url).pathname;

export type World = {
  readonly root: string;
  readonly grants: string;
  readonly ledger: string;
  readonly effects: string;
  readonly revision: string;
  readonly clock: string;
  readonly lock: string;
  readonly contacts: string;
  readonly authority: string;
};

export type Observation = {
  readonly outcome: string;
  readonly consumeDelta: number;
  readonly effectDelta: number;
  readonly grantUnchanged: boolean;
};

// Independent restatement of the published layouts: one record or marker
// per item, named by sha256 of the JSON item parts.
function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function markerName(parts: readonly string[]): string {
  return `${digest(parts)}.consumed`;
}
function recordName(parts: readonly string[]): string {
  return `${digest(parts)}.json`;
}

const tests = "tests/contract3/approval";

export async function materialize(): Promise<{
  readonly root: string;
  readonly driver: string;
}> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contract3-approval-tree-"),
  );
  const source = join(root, "starters/contract3/src");
  await mkdir(join(source, "addons/state"), { recursive: true });
  await mkdir(join(root, tests), { recursive: true });
  for (const part of ["kernel", "addons/approval"])
    await cp(
      join(repository, "starters/contract3/src", part),
      join(source, part),
      { recursive: true },
    );
  const fixtures = new URL("fixtures/", import.meta.url);
  await writeFile(
    join(source, "addons/state/coordination.ts"),
    await readFile(new URL("coordination.ts.txt", fixtures)),
  );
  // The driver imports the harness for the one adversarial source owner.
  for (const name of ["harness.ts", "cases.ts"])
    await cp(join(repository, tests, name), join(root, tests, name));
  const driver = join(root, tests, "driver.ts");
  await writeFile(driver, await readFile(new URL("driver.ts.txt", fixtures)));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include: ["starters/contract3/src/**/*.ts", `${tests}/**/*.ts`],
    }),
  );
  // The contract3 lint configuration, rooted at this tree's tsconfig.
  await writeFile(
    join(root, "eslint.config.mjs"),
    [
      `import contract3 from ${JSON.stringify(join(repository, "config/contract3-eslint.mjs"))};`,
      "export default [",
      "  ...contract3,",
      `  { files: ["**/*.ts"], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: ${JSON.stringify(root)} } } },`,
      "];",
      "",
    ].join("\n"),
  );
  return { root, driver };
}

export async function createWorld(): Promise<World> {
  // Resolved, so fileSeparation judges real directories, not /var's symlink.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contract3-approval-world-"),
  );
  const world = {
    root,
    grants: join(root, "grants"),
    ledger: join(root, "ledger"),
    effects: join(root, "effects.log"),
    revision: join(root, "revision"),
    clock: join(root, "clock"),
    lock: join(root, "scope.lock"),
    contacts: join(root, "contacts.log"),
    authority: join(root, "authority"),
  };
  for (const directory of [world.grants, world.ledger, world.authority])
    await mkdir(directory);
  await writeFile(world.revision, "r0");
  await writeFile(world.clock, "1000");
  await writeFile(world.effects, "");
  await writeFile(world.contacts, "");
  return world;
}

export async function removeAll(...paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

// Test-owned grant identities. G binds P="p-1", R0="r0", E={note.write}.
export const grant = {
  format: "contract3.approval-grant",
  version: 1,
  operation: "fixture.approve",
  preview: "p-1",
  authority: "owner-a",
  resource: "resource-1",
  resourceRevision: "r0",
  effects: ["note.write"],
  expiresAt: 5000,
} as const;

// Independent restatement of the published grant layout.
export function grantPath(world: World, preview: string): string {
  return join(world.grants, recordName(["approval", preview]));
}

// Human-authority identities, the single owner for every approval test.
export const closureRecord = {
  format: "contract3.closure-authority",
  version: 1,
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
  expiresAt: 5000,
} as const;
export const closureItem: ClosureItem = {
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
};
export const stopRecord = {
  format: "contract3.stop-attestation",
  version: 1,
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  expiresAt: 5000,
} as const;
export const stopItem: StopItem = {
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  liveConflict: false,
};
// Named variant: the writer set binds as a set, not a sequence.
export const unorderedStopItem: StopItem = {
  ...stopItem,
  writers: ["w-2", "w-1"],
};

// Adversarial test authority: claims separation so verifier logic can be
// exercised. It never qualifies production authority (REC-5, C03.c).
export function adversarialSource(directory: string): AuthoritySource {
  return { directory, separated: () => Promise.resolve(true) };
}

// Independent restatement of the published authority record layout.
export function authorityRecordPath(
  world: World,
  kind: "closure" | "stop",
  parts: readonly string[],
): string {
  return join(world.authority, recordName([kind, ...parts]));
}

export async function writeGrant(
  world: World,
  value: unknown,
  preview: string = grant.preview,
): Promise<void> {
  await writeFile(grantPath(world, preview), JSON.stringify(value));
}

export async function snapshot(world: World) {
  const hash = createHash("sha256");
  for (const directory of [world.grants, world.authority])
    for (const name of (await readdir(directory)).sort()) {
      hash.update(name);
      const path = join(directory, name);
      const status = await lstat(path);
      if (!status.isFile()) hash.update(`<${status.mode}>`);
      else
        try {
          hash.update(await readFile(path));
        } catch {
          hash.update("<unreadable>");
        }
    }
  const effects = (await readFile(world.effects, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return {
    markers: (await readdir(world.ledger)).sort(),
    effects,
    authority: hash.digest("hex"),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

export function observation(
  outcome: string,
  before: Snapshot,
  after: Snapshot,
): Observation {
  return {
    outcome,
    consumeDelta: after.markers.length - before.markers.length,
    effectDelta: after.effects.length - before.effects.length,
    grantUnchanged: before.authority === after.authority,
  };
}

export type DriverConfig = Readonly<Record<string, unknown>>;

export function applyConfig(
  world: World,
  runId: string,
  overrides: DriverConfig = {},
): DriverConfig {
  return {
    mode: "apply",
    world,
    runId,
    operation: grant.operation,
    preview: grant.preview,
    authority: grant.authority,
    resource: grant.resource,
    effects: grant.effects,
    lock: "refuse",
    barriers: [],
    ...overrides,
  };
}

const boundMilliseconds = 15_000;
const live = new Set<Driver>();

// Kills any driver a failed assertion left at a barrier.
export async function stopLiveDrivers(): Promise<void> {
  for (const driver of [...live]) {
    driver.kill();
    await driver.finish().catch(() => undefined);
  }
}

export class Driver {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  readonly events: unknown[] = [];

  constructor(path: string, config: DriverConfig) {
    this.#child = Bun.spawn([process.execPath, path, JSON.stringify(config)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#reader = this.#child.stdout.getReader();
    live.add(this);
  }

  // Next stdout event, bounded. Failure to reach a phase is unproved.
  async next(): Promise<unknown> {
    const deadline = Date.now() + boundMilliseconds;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end >= 0) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        const event: unknown = JSON.parse(line);
        this.events.push(event);
        return event;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), deadline - Date.now());
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk === "timeout") throw new Error("Driver phase not reached.");
      if (chunk.done) return undefined;
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async go(): Promise<void> {
    await this.#child.stdin.write("go\n");
    await this.#child.stdin.flush();
  }

  kill(): void {
    this.#child.kill("SIGKILL");
  }

  // Drains remaining events and returns the real exit or signal.
  async finish() {
    for (;;) if ((await this.next()) === undefined) break;
    await this.#child.stdin.end();
    const exit = await this.#child.exited;
    live.delete(this);
    return {
      exit,
      signal: this.#child.signalCode,
      stderr: await new Response(this.#child.stderr).text(),
    };
  }
}

export async function run(path: string, config: DriverConfig) {
  const driver = new Driver(path, config);
  const finished = await driver.finish();
  return { ...finished, events: driver.events };
}

// Oracle lookup: the frozen case table, never implementation output.
function expectedFor(id: string): Observation {
  const found = approvalCases.find((item) => item.id === id);
  if (found?.status !== "executable")
    throw new Error(`Unknown or non-executable case ${id}.`);
  return found.expected;
}

// Compares one observation with its frozen expectation. When the coverage
// meta-test sets T4_ORACLE_LOG, records the ID only after the comparison
// passed, so the meta-test proves each executable case reached it.
export function expectCase(id: string, observed: Observation): void {
  expect(observed).toEqual(expectedFor(id));
  const log = process.env.T4_ORACLE_LOG;
  if (log) appendFileSync(log, `${id}\n`);
}
