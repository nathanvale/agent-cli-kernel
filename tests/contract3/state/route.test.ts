import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { testFolder } from "../../support/test-folder.ts";
import {
  at,
  caseTest,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
} from "./harness.ts";
import { signalIfPresent } from "../../support/signal.ts";

const worker = join(import.meta.dir, "fixtures", "coordination-worker.ts");
const folders: string[] = [];
const processes: number[] = [];

afterEach(() => {
  for (const pid of processes.splice(0)) {
    if (signalIfPresent(pid, "SIGCONT")) signalIfPresent(pid, "SIGKILL");
  }
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = testFolder("c3-route-");
  folders.push(path);
  return path;
}

type Report = {
  readonly pid: number;
  readonly result: string;
  readonly code: string;
  readonly elapsedMs?: number;
  readonly child?: number | null;
  readonly first?: string;
};

type Worker = {
  readonly pid: number;
  readonly report: () => Promise<Report>;
  readonly exited: Promise<number>;
  readonly kill: (signal: NodeJS.Signals) => void;
};

let sequence = 0;
function start(route: string, mode: string, file: string, option = ""): Worker {
  sequence += 1;
  const report = join(
    file.slice(0, file.lastIndexOf("/")),
    `report-${sequence}.json`,
  );
  const child = Bun.spawn(
    [process.execPath, worker, route, mode, file, report, option],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  processes.push(child.pid);
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  return {
    pid: child.pid,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
    async report() {
      const until = Date.now() + 30_000;
      while (!existsSync(report)) {
        if (exited) {
          const stderr = await new Response(child.stderr).text();
          throw new Error(`Worker exited without a report: ${stderr}`);
        }
        if (Date.now() > until) throw new Error("Worker never reported.");
        await Bun.sleep(5);
      }
      const value: unknown = JSON.parse(readFileSync(report, "utf8"));
      if (typeof value !== "object" || value === null)
        throw new Error("Unreadable report.");
      return {
        pid: Number(Reflect.get(value, "pid")),
        result: String(Reflect.get(value, "result")),
        code: String(Reflect.get(value, "code")),
        elapsedMs: Number(Reflect.get(value, "elapsedMs")),
        child: Number(Reflect.get(value, "child")),
        first: String(Reflect.get(value, "first")),
      };
    },
  };
}

async function attempt(route: string, file: string): Promise<Report> {
  return start(route, "try", file).report();
}

async function holder(
  route: string,
  file: string,
  option = "",
): Promise<{ readonly worker: Worker; readonly report: Report }> {
  const worker = start(route, "hold", file, option);
  const report = await worker.report();
  expect({ result: report.result, code: report.code }).toEqual({
    result: "acquired",
    code: "none",
  });
  return { worker, report };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killed(worker: Worker): Promise<void> {
  worker.kill("SIGKILL");
  await worker.exited;
  expect(alive(worker.pid)).toBe(false);
}

function listing(path: string): string {
  return readdirSync(path)
    .filter((name) => !name.startsWith("report-"))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(path, name));
      return `${name}:${statSync(join(path, name)).size}:${createHash("sha256").update(bytes).digest("hex")}`;
    })
    .join(" ");
}

async function otherDescriptorObservation(route: string): Promise<string> {
  const file = join(folder(), "f.lock");
  const { worker } = await holder(route, file, "other-descriptor");
  const contender = await attempt(route, file);
  await killed(worker);
  return contender.result;
}

async function childObservation(
  route: string,
  option = "child",
): Promise<{ readonly result: string; readonly childAlive: boolean }> {
  const file = join(folder(), "f.lock");
  const { worker, report } = await holder(route, file, option);
  const child = Number(report.child);
  expect(child).toBeGreaterThan(0);
  processes.push(child);
  await killed(worker);
  const contender = await attempt("addon", file);
  const childAlive = alive(child);
  process.kill(child, "SIGKILL");
  return { result: contender.result, childAlive };
}

async function sameProcessObservation(route: string): Promise<Report> {
  const file = join(folder(), "f.lock");
  const worker = start(route, "same-process", file);
  const report = await worker.report();
  await killed(worker);
  return report;
}

caseTest("C01.a-coordination-exclusive-across-processes", async () => {
  const path = folder();
  const file = join(path, "f.lock");
  const other = join(path, "g.lock");
  const { worker } = await holder("addon", file);
  const contender = await attempt("addon", file);
  expect(contender.result).toBe("refused");
  expect(contender.code).toBe("busy");
  expect((await attempt("addon", other)).result).toBe("acquired");
  expect((await attempt("addon", file)).result).toBe("refused");
  await killed(worker);
  expect((await attempt("addon", file)).result).toBe("acquired");
});

caseTest("C01.b-coordination-nonblocking", async () => {
  const file = join(folder(), "f.lock");
  const { worker } = await holder("addon", file);
  const heldSince = performance.now();
  const contender = await attempt("addon", file);
  const waited = performance.now() - heldSince;
  expect(contender.result).toBe("refused");
  expect(Number(contender.elapsedMs)).toBeLessThan(100);
  expect(alive(worker.pid)).toBe(true);
  expect(waited).toBeLessThan(2_000);
  await killed(worker);
});

caseTest("C01.c-sigkill-release-first-attempt-no-residue", async () => {
  const path = folder();
  const file = join(path, "f.lock");
  writeFileSync(file, "");
  const before = listing(path);
  const { worker } = await holder("addon", file);
  await killed(worker);
  const first = await attempt("addon", file);
  expect(first.result).toBe("acquired");
  expect(listing(path)).toBe(before);
});

caseTest("C01.d-other-descriptor-close-keeps-hold", async () => {
  expect(await otherDescriptorObservation("addon")).toBe("refused");
  expect(await otherDescriptorObservation("posix-control")).toBe("acquired");
});

caseTest("C01.e-spawned-child-does-not-hold", async () => {
  const addon = await childObservation("addon");
  expect(addon.childAlive).toBe(true);
  expect(addon.result).toBe("acquired");
  const native = await childObservation("addon", "native-child");
  expect(native.childAlive).toBe(true);
  expect(native.result).toBe("acquired");
  const shared = await childObservation("shared-control");
  expect(shared.childAlive).toBe(true);
  expect(shared.result).toBe("refused");
});

caseTest("C01.f-same-process-second-open-refused", async () => {
  const addon = await sameProcessObservation("addon");
  expect(addon.first).toBe("acquired");
  expect(addon.result).toBe("refused");
  const posix = await sameProcessObservation("posix-control");
  expect(posix.first).toBe("acquired");
  expect(posix.result).toBe("acquired");
});

function state(pid: number): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2);
  }
  return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
    .slice(0, 1);
}

caseTest("C01.g-stopped-holder-still-holds", async () => {
  const file = join(folder(), "f.lock");
  const { worker } = await holder("addon", file);
  process.kill(worker.pid, "SIGSTOP");
  try {
    const until = Date.now() + 5_000;
    while (state(worker.pid) !== "T" && Date.now() < until) await Bun.sleep(5);
    expect(state(worker.pid)).toBe("T");
    expect((await attempt("addon", file)).result).toBe("refused");
    expect(state(worker.pid)).toBe("T");
  } finally {
    process.kill(worker.pid, "SIGCONT");
    await killed(worker);
  }
});

const apply = (name: string, ...extra: string[]) => [
  "apply",
  name,
  "--content",
  "v1",
  ...extra,
  "--json",
];

caseTest("C01.h-no-fallback-when-route-unavailable", async () => {
  const world = makeWorld();
  try {
    const broken = { SX_COORDINATION_LIBRARY: "libc3-no-such-library.so" };
    const changing = [
      apply("a"),
      [
        "close",
        `op-${"0".repeat(32)}`,
        "--disposition",
        "completed",
        "--closure-id",
        "c1",
        "--revision",
        `r-${"0".repeat(64)}`,
        "--reason",
        "independent evidence reviewed",
        "--json",
      ],
    ];
    for (const argv of changing) {
      const run = await world.run(argv, broken);
      expectRefusedUnchanged(run, "DOMAIN_SX_UNAVAILABLE");
      expect(run.result.retryable).toBe(false);
      const message = str(run.envelope.message);
      expect(message).toContain("coordination-self-check-failed");
      expect(message).not.toContain("coordination-unqualified-platform");
      expect(message).toContain(process.platform);
      expect(message).toContain(release());
      expect(message).toContain("qualified on:");
      expect(message).not.toMatch(/unlink|delete|remove/i);
      expect(existsSync(world.root)).toBe(false);
      expect(world.ledger()).toEqual([]);
    }
    const capabilities = await world.run(["capabilities", "--json"], broken);
    expect(capabilities.exit).toBe(0);
    const data = at(capabilities.result.raw, "data");
    expect(at(data, "coordination")).toBe("unavailable");
    expect(at(data, "stoppedOwnerProof")).toBe("unavailable");
    expect(JSON.stringify(at(data, "reasons"))).toContain(
      "coordination-self-check-failed",
    );
    expectCompleted(await world.run(apply("seed")));
    const before = world.snapshot();
    expect((await world.run(["pending", "--json"], broken)).exit).toBe(0);
    expect(world.snapshot()).toBe(before);
  } finally {
    world.dispose();
  }
});

caseTest("C01.i-no-age-pid-or-fallback-path", async () => {
  const sources = await Promise.all(
    ["coordination.ts", "linux-flock.ts"].map((name) =>
      Bun.file(
        new URL(
          `../../../starters/contract3/src/addons/state/${name}`,
          import.meta.url,
        ),
      ).text(),
    ),
  );
  for (const source of sources) {
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(
      /\bstat|mtime|ctime|atime|birthtime|\bpid\b|process\.kill|hostname|Date\.now|O_EXCL|"wx"/,
    );
  }
});
