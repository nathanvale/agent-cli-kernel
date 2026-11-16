// LABELLED PROBE (test-only): candidate coordination locks for the state
// add-on on Linux and macOS. It changes no production code and asserts no
// winner. It PRINTS one line per observation, prefixed `PROBE `, from real
// separate processes (the worker in fixtures/), for each candidate, in the
// directory named by PROBE_DIR or a fresh temporary one. It needs no
// installed dependency: only bun:test, Bun built-ins and Node built-ins, so
// `bun test <this file>` runs in a bare copy of the repository.
// An observation it could not make prints `UNOBSERVED <reason>`. Tests fail
// only when the probe harness itself breaks (a worker never reports).
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

const worker = join(
  import.meta.dir,
  "fixtures",
  "linux-coordination-probe-worker.ts",
);
const candidates = [
  "flock",
  "ofd",
  "fcntl-posix",
  "sqlite",
  "o-exlock",
  "mkdir",
] as const;
type Candidate = (typeof candidates)[number];
const reacquireBoundMilliseconds = 5_000;

const processes = new Set<number>();
const directories: string[] = [];
afterAll(() => {
  for (const pid of processes)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

function line(text: string): void {
  process.stdout.write(`PROBE ${text}\n`);
}

type Report = Readonly<Record<string, unknown>>;
function field(report: Report | undefined, key: string): string {
  const value = report?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "none";
}

async function waitReport(
  path: string,
  child: { readonly exited: Promise<number> },
): Promise<Report | undefined> {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const report: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) report[key] = value;
      return report;
    }
    if (exited && !existsSync(path)) return undefined;
    await Bun.sleep(5);
  }
  return undefined;
}

let sequence = 0;
function spawnWorker(
  candidate: Candidate,
  mode: string,
  lock: string,
  extra = "",
) {
  sequence += 1;
  const report = `${lock}.report-${sequence}`;
  const child = Bun.spawn(
    [process.execPath, worker, candidate, mode, lock, report, extra],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  processes.add(child.pid);
  return {
    child,
    report: waitReport(report, child),
  };
}

async function attempt(candidate: Candidate, lock: string) {
  const { child, report } = spawnWorker(candidate, "try", lock);
  const result = await report;
  await child.exited;
  return result;
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Longest mount point containing `directory`, from /proc/mounts on Linux or
// `mount` output on macOS, plus the statfs type number.
function filesystem(directory: string): string {
  const real = realpathSync.native(directory);
  const type = (() => {
    try {
      return String(statfsSync(real).type);
    } catch {
      return "unknown";
    }
  })();
  const mounts: { point: string; fs: string }[] = [];
  if (process.platform === "linux" && existsSync("/proc/mounts"))
    for (const entry of readFileSync("/proc/mounts", "utf8").split("\n")) {
      const parts = entry.split(" ");
      if (parts[1] && parts[2]) mounts.push({ point: parts[1], fs: parts[2] });
    }
  else {
    const output = Bun.spawnSync(["/sbin/mount"]).stdout.toString();
    for (const entry of output.split("\n")) {
      const match = / on (\S+) \(([^,)]+)/.exec(entry);
      if (match?.[1] && match[2])
        mounts.push({ point: match[1], fs: match[2] });
    }
  }
  const best = mounts
    .filter(
      (mount) =>
        real === mount.point ||
        real.startsWith(
          mount.point.endsWith("/") ? mount.point : `${mount.point}/`,
        ),
    )
    .sort((a, b) => b.point.length - a.point.length)[0];
  return `fs=${best?.fs ?? "unknown"} mount=${best?.point ?? "unknown"} statfsType=${type}`;
}

// The directory under test: PROBE_DIR when set (a fresh subdirectory is made
// inside it, so an overlay root and a volume can each be probed), otherwise a
// fresh temporary directory.
function probeDirectories(): readonly { label: string; path: string }[] {
  const base = process.env.PROBE_DIR;
  if (base) {
    mkdirSync(base, { recursive: true });
    const path = mkdtempSync(join(base, "c3-lock-probe-"));
    directories.push(path);
    return [{ label: "PROBE_DIR", path }];
  }
  const path = mkdtempSync(join(tmpdir(), "c3-lock-probe-"));
  directories.push(path);
  return [{ label: "tmpdir", path }];
}

test("PROBE environment", () => {
  line(
    `environment platform=${process.platform} arch=${process.arch} kernel=${release()} bun=${Bun.version} revision=${typeof Bun.revision === "string" ? Bun.revision.slice(0, 12) : "unknown"}`,
  );
  expect(Bun.version.length).toBeGreaterThan(0);
});

const dirs = probeDirectories();
for (const directory of dirs) {
  test(`PROBE directory ${directory.label}`, () => {
    line(
      `directory ${directory.label} path=${directory.path} ${filesystem(directory.path)}`,
    );
    expect(existsSync(directory.path)).toBe(true);
  });
  for (const candidate of candidates)
    test(
      `PROBE ${candidate} in ${directory.label}`,
      () => observe(candidate, directory.label, directory.path),
      90_000,
    );
}

async function observe(
  candidate: Candidate,
  label: string,
  root: string,
): Promise<void> {
  const tag = `${candidate} ${label}`;
  const lock = (name: string) => join(root, `${candidate}-${name}.lock`);

  // Baseline: one uncontended attempt.
  const baseline = await attempt(candidate, lock("baseline"));
  const supported = field(baseline, "result") === "acquired";
  line(`${tag} uncontended result=${field(baseline, "result")}`);
  if (!supported) {
    for (const property of [
      "exclusive",
      "nonblocking",
      "released-on-sigkill",
      "survives-second-close",
      "child-holds",
      "same-process-second-open",
    ])
      line(
        `${tag} ${property} UNOBSERVED uncontended attempt did not acquire: ${field(baseline, "result")}`,
      );
    expect(baseline).toBeDefined();
    return;
  }

  // Exclusive between two processes, and whether the attempt blocks.
  const holder = spawnWorker(candidate, "hold", lock("main"));
  const held = await holder.report;
  expect(held).toBeDefined();
  line(`${tag} holder result=${field(held, "result")}`);
  const contender = await attempt(candidate, lock("main"));
  line(
    `${tag} exclusive ${field(contender, "result") === "busy" ? "yes" : "no"} contender=${field(contender, "result")}`,
  );
  line(
    `${tag} nonblocking ${contender ? "yes" : "no"} contenderElapsedMs=${field(contender, "elapsedMs")}`,
  );

  // Released when the holder is SIGKILLed, and how soon.
  kill(holder.child.pid);
  const signal = await holder.child.exited.then(() => holder.child.signalCode);
  const killedAt = performance.now();
  let reacquired: Report | undefined;
  let afterMs = -1;
  while (performance.now() - killedAt < reacquireBoundMilliseconds) {
    reacquired = await attempt(candidate, lock("main"));
    if (field(reacquired, "result") === "acquired") {
      afterMs = Math.round(performance.now() - killedAt);
      break;
    }
    await Bun.sleep(10);
  }
  line(
    afterMs >= 0
      ? `${tag} released-on-sigkill yes afterMs=${afterMs} holderSignal=${signal ?? "none"}`
      : `${tag} released-on-sigkill no within=${reacquireBoundMilliseconds}ms last=${field(reacquired, "result")} holderSignal=${signal ?? "none"}`,
  );

  // Anything the dead holder left behind next to its lock file.
  const leftovers = readdirSync(root).filter(
    (name) =>
      name.startsWith(`${candidate}-main.lock`) &&
      name !== `${candidate}-main.lock` &&
      !name.includes(".report-"),
  );
  line(
    `${tag} leftover-after-sigkill ${leftovers.length === 0 ? "none" : leftovers.join(",")}`,
  );

  // Survives the holder closing a second descriptor on the same file.
  const closer = spawnWorker(candidate, "hold", lock("second"), "close-second");
  const closed = await closer.report;
  if (field(closed, "result") !== "acquired")
    line(
      `${tag} survives-second-close UNOBSERVED holder=${field(closed, "result")}`,
    );
  else {
    const after = await attempt(candidate, lock("second"));
    line(
      `${tag} survives-second-close ${field(after, "result") === "busy" ? "yes" : "no"} contender=${field(after, "result")}`,
    );
  }
  kill(closer.child.pid);
  await closer.child.exited;

  // Does a child spawned by the holder keep the lock after the holder dies?
  const parent = spawnWorker(candidate, "hold", lock("child"), "child");
  const parentReport = await parent.report;
  const childPid = Number(field(parentReport, "child"));
  if (!Number.isInteger(childPid) || childPid <= 0)
    line(
      `${tag} child-holds UNOBSERVED holder=${field(parentReport, "result")}`,
    );
  else {
    processes.add(childPid);
    const whileParentLives = await attempt(candidate, lock("child"));
    kill(parent.child.pid);
    await parent.child.exited;
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    const afterParent = await attempt(candidate, lock("child"));
    line(
      `${tag} child-holds ${field(afterParent, "result") === "busy" ? "yes" : "no"} childAlive=${childAlive} whileParentLives=${field(whileParentLives, "result")} afterParentKilled=${field(afterParent, "result")}`,
    );
    kill(childPid);
  }
  kill(parent.child.pid);

  // Can a second open in the same process take it?
  const same = spawnWorker(candidate, "same-process", lock("same"));
  const sameReport = await same.report;
  await same.child.exited;
  line(
    `${tag} same-process-second-open ${field(sameReport, "second") === "busy" ? "refused" : field(sameReport, "second") === "acquired" ? "acquired" : "other"} first=${field(sameReport, "first")} second=${field(sameReport, "second")}`,
  );
  expect(sameReport).toBeDefined();
}
