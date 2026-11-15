// Test-owned harness for T4 approval process cases. It materializes a copy
// of the stamped kernel and the approval add-on under test beside the
// disposable coordination fixture, starts real child processes, and reads
// grant, ledger and effect state independently of the add-on.
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantLocation } from "../../../starters/contract3/src/addons/approval/index.ts";
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

// Independent restatement of the frozen ledger layout: one marker per
// authority item, named by sha256 of the JSON item parts.
export function markerName(parts: readonly string[]): string {
  return `${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}.consumed`;
}

export async function materialize(): Promise<{
  readonly root: string;
  readonly driver: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "contract3-approval-tree-"));
  const source = join(root, "starters/contract3/src");
  await mkdir(join(source, "addons/state"), { recursive: true });
  await mkdir(join(source, "commands"), { recursive: true });
  for (const part of ["kernel", "addons/approval"])
    await cp(
      join(repository, "starters/contract3/src", part),
      join(source, part),
      {
        recursive: true,
      },
    );
  const fixtures = new URL("fixtures/", import.meta.url);
  await writeFile(
    join(source, "addons/state/coordination.ts"),
    await readFile(new URL("coordination.ts.txt", fixtures)),
  );
  const driver = join(source, "commands/driver.ts");
  await writeFile(driver, await readFile(new URL("driver.ts.txt", fixtures)));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include: ["starters/contract3/src/**/*.ts"],
    }),
  );
  return { root, driver };
}

export async function createWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "contract3-approval-world-"));
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

export function grantPath(world: World, preview: string): string {
  return grantLocation({ grants: world.grants, ledger: world.ledger }, preview);
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
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), deadline - Date.now()),
        ),
      ]);
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
export function expectedFor(id: string): Observation {
  const found = approvalCases.find((item) => item.id === id);
  if (found?.status !== "executable")
    throw new Error(`Unknown or non-executable case ${id}.`);
  return found.expected;
}
