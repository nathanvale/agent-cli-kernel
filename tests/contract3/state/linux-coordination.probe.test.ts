// OBSERVATION INSTRUMENT, NOT A TEST OF BEHAVIOUR. A passing row here
// proves nothing by itself: the rows pass whatever the candidates do, and
// fail only when the instrument itself breaks. Its value is the PROBE lines
// it prints, which a reviewer judges against t3-linux/expectations.md (the
// hosted Linux qualification keeps them). The state add-on's behaviour is
// proved by the case table (C01 and the rebound cases), not here.
//
// Candidate coordination locks for the state add-on on Linux and macOS. It
// changes no production code and asserts no winner. It PRINTS one line per observation in the grammar of
// t3-linux/expectations.md section 3:
//   PROBE <candidate> <property> <observation> [key=value ...]
//   PROBE <candidate> <property> UNOBSERVED <reason>
// from real separate processes (fixtures/linux-coordination-probe-worker.ts)
// coordinated by barrier files. Folders: PROBE_DIR alone when set (the
// coordinator's container runs: overlay root, then a volume); otherwise the
// checkout workspace, os.tmpdir() and /dev/shm when present. It needs no
// installed dependency (bun:test, Bun and Node built-ins only), so
// `bun test <this file>` runs in a bare copy. Tests fail only when the probe
// harness itself breaks.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const worker = join(
  import.meta.dir,
  "fixtures",
  "linux-coordination-probe-worker.ts",
);
const candidates = [
  "flock-ffi",
  "ofd-ffi",
  "posix-ffi",
  "sqlite",
  "o-exlock",
] as const;
type Candidate = (typeof candidates)[number];
const holdMilliseconds = 2_000;
const reacquireBoundMilliseconds = 5_000;
const linux = process.platform === "linux";

const processes = new Set<number>();
const folders: string[] = [];
const errorCodes = new Map<string, Set<string>>();

function line(text: string): void {
  process.stdout.write(`PROBE ${text}\n`);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function kill(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

afterAll(() => {
  for (const pid of processes) {
    kill(pid, "SIGCONT");
    kill(pid);
  }
  const deadline = Date.now() + 2_000;
  while ([...processes].some(alive) && Date.now() < deadline) Bun.sleepSync(10);
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
  line(
    `teardown processes=${[...processes].filter(alive).length} folders=${folders.filter((folder) => existsSync(folder)).length}`,
  );
});

type Report = Readonly<Record<string, unknown>>;
function field(report: Report | undefined, key: string): string {
  const value = report?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : value === null
      ? "null"
      : "none";
}
// One read, no existence check first: the worker renames each phase's report
// over the last, and on some shared folders the path is briefly missing
// between a check and a read.
function readReport(path: string): Report | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const report: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) report[key] = value;
  return report;
}
// Waits on a barrier (report) file; bounded, never a timing assumption.
async function waitFor(
  path: string,
  accept: (report: Report) => boolean = () => true,
  boundMilliseconds = 15_000,
): Promise<Report | undefined> {
  const until = Date.now() + boundMilliseconds;
  while (Date.now() < until) {
    const report = readReport(path);
    if (report && accept(report)) return report;
    await Bun.sleep(5);
  }
  return undefined;
}

let sequence = 0;
function spawnWorker(
  candidate: Candidate,
  reports: string,
  mode: string,
  lock: string,
  extra = "",
  go = "",
) {
  sequence += 1;
  const report = join(reports, `report-${sequence}.json`);
  const child = Bun.spawn(
    [process.execPath, worker, candidate, mode, lock, report, extra, go],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  processes.add(child.pid);
  return {
    child,
    report,
    wait: (accept?: (report: Report) => boolean) => waitFor(report, accept),
  };
}
function note(candidate: Candidate, report: Report | undefined): void {
  const code = field(report, "code");
  if (code === "none" || code === "null") return;
  const codes = errorCodes.get(candidate) ?? new Set<string>();
  codes.add(code);
  errorCodes.set(candidate, codes);
}
async function attempt(candidate: Candidate, reports: string, lock: string) {
  const started = spawnWorker(candidate, reports, "try", lock);
  const report = await started.wait();
  await started.child.exited;
  note(candidate, report);
  return report;
}

// Names, sizes and SHA-256 of every file in a coordination folder.
function residue(folder: string): string {
  return readdirSync(folder)
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(folder, name));
      const digest = createHash("sha256")
        .update(bytes)
        .digest("hex")
        .slice(0, 12);
      return `${name}:${bytes.length}:${digest}`;
    })
    .join(",");
}

// ---- Environment -----------------------------------------------------------

function osRelease(): string {
  if (!existsSync("/etc/os-release")) return "UNOBSERVED no /etc/os-release";
  const text = readFileSync("/etc/os-release", "utf8");
  const value = (key: string) =>
    new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(text)?.[1] ?? "unknown";
  return `${value("ID")} ${value("VERSION_ID")}`;
}
function libc(): string {
  if (!linux) return "darwin";
  const result = Bun.spawnSync(["getconf", "GNU_LIBC_VERSION"]);
  const text = result.stdout.toString().trim();
  return result.exitCode === 0 && text
    ? text
    : "UNOBSERVED getconf GNU_LIBC_VERSION unavailable (musl or no getconf)";
}
function sqliteVersion(): string {
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    'const { Database } = require("bun:sqlite"); process.stdout.write(new Database(":memory:").query("select sqlite_version() as v").get().v)',
  ]);
  const text = result.stdout.toString().trim();
  return result.exitCode === 0 && text
    ? text
    : "UNOBSERVED bun:sqlite did not load";
}
type Mount = { point: string; fs: string; options: string };
function linuxMounts(): Mount[] {
  const mounts: Mount[] = [];
  for (const entry of readFileSync("/proc/self/mountinfo", "utf8").split(
    "\n",
  )) {
    const [left, right] = entry.split(" - ");
    const fields = left?.split(" ") ?? [];
    const tail = right?.split(" ") ?? [];
    if (fields[4] && tail[0])
      mounts.push({
        point: fields[4],
        fs: tail[0],
        options: `${fields[5] ?? ""};${tail[2] ?? ""}`,
      });
  }
  return mounts;
}
function darwinMounts(): Mount[] {
  const mounts: Mount[] = [];
  const output = Bun.spawnSync(["/sbin/mount"]).stdout.toString();
  for (const entry of output.split("\n")) {
    const match = / on (\S+) \(([^,)]+),?\s*([^)]*)\)/.exec(entry);
    if (match?.[1] && match[2])
      mounts.push({
        point: match[1],
        fs: match[2],
        options: (match[3] ?? "").replaceAll(" ", ""),
      });
  }
  return mounts;
}
// Filesystem of `folder`: longest mount-point prefix of its real path, from
// /proc/self/mountinfo on Linux and `mount` on macOS.
function filesystem(folder: string): string {
  const real = realpathSync.native(folder);
  const mounts =
    linux && existsSync("/proc/self/mountinfo")
      ? linuxMounts()
      : darwinMounts();
  // macOS firmlinks data paths into /System/Volumes/Data, so the mount point
  // comes from df there; Linux uses the longest mount-point prefix.
  const darwinPoint = linux
    ? undefined
    : Bun.spawnSync(["/bin/df", "-P", real])
        .stdout.toString()
        .trim()
        .split("\n")
        .at(-1)
        ?.split(/\s+/)
        .at(-1);
  const best = mounts
    .filter((mount) =>
      darwinPoint
        ? mount.point === darwinPoint
        : real === mount.point ||
          real.startsWith(mount.point === "/" ? "/" : `${mount.point}/`),
    )
    .sort((a, b) => b.point.length - a.point.length)[0];
  return best
    ? `${best.fs} ${best.point} ${best.options || "none"}`
    : "UNOBSERVED no mount entry contains the folder";
}

function probeFolders(): readonly { label: string; path: string }[] {
  const make = (label: string, base: string) => {
    mkdirSync(base, { recursive: true });
    const path = mkdtempSync(join(base, "c3-lock-probe-"));
    folders.push(path);
    return { label, path };
  };
  const chosen = process.env.PROBE_DIR;
  if (chosen) return [make("PROBE_DIR", chosen)];
  const checkout = resolve(import.meta.dir, ".probe-tmp");
  const list = [make("checkout", checkout), make("tmpdir", tmpdir())];
  if (existsSync("/dev/shm")) list.push(make("dev-shm", "/dev/shm"));
  folders.push(checkout);
  return list;
}

const probeFolderList = probeFolders();

const label = "OBSERVATION ONLY, proves nothing by itself:";

test(`${label} PROBE environment`, () => {
  line(`env platform ${process.platform}`);
  line(`env arch ${process.arch}`);
  line(`env kernel ${release()}`);
  line(`env os-release ${linux ? osRelease() : "UNOBSERVED not Linux"}`);
  line(`env libc ${libc()}`);
  line(
    `env bun ${Bun.version} ${typeof Bun.revision === "string" ? Bun.revision : "unknown"}`,
  );
  line(
    `env euid ${typeof process.geteuid === "function" ? process.geteuid() : "unknown"}`,
  );
  line(`env sqlite ${sqliteVersion()}`);
  for (const folder of probeFolderList)
    line(`env fs ${folder.label} ${filesystem(folder.path)}`);
  expect(Bun.version.length).toBeGreaterThan(0);
});

for (const folder of probeFolderList)
  for (const candidate of candidates)
    test(
      `${label} PROBE ${candidate} in ${folder.label}`,
      () => observe(candidate, folder.label, folder.path),
      120_000,
    );

test(`${label} PROBE error codes`, () => {
  for (const candidate of candidates)
    line(
      `${candidate} error-codes ${[...(errorCodes.get(candidate) ?? [])].sort().join(",") || "none"}`,
    );
});

// ---- Properties ------------------------------------------------------------

const properties = [
  "exclusive",
  "nonblocking",
  "sigkill-release",
  "residue",
  "bytes",
  "other-descriptor-close",
  "child-inherit",
  "same-process-second-open",
  "stopped-holder",
  "per-file",
  "opposite-order",
];

type Context = {
  readonly candidate: Candidate;
  readonly reports: string;
  readonly space: (name: string) => string;
  readonly say: (property: string, observation: string) => void;
};

async function observe(
  candidate: Candidate,
  label: string,
  root: string,
): Promise<void> {
  const reports = join(root, `${candidate}-reports`);
  mkdirSync(reports);
  const context: Context = {
    candidate,
    reports,
    space(name) {
      const path = join(root, `${candidate}-${name}`);
      mkdirSync(path);
      return path;
    },
    say: (property, observation) =>
      line(`${candidate} ${property} ${observation} folder=${label}`),
  };
  const baseline = await attempt(
    candidate,
    reports,
    join(context.space("baseline"), "F"),
  );
  if (field(baseline, "result") !== "acquired") {
    const reason = `uncontended attempt gave ${field(baseline, "result")} code=${field(baseline, "code")}`;
    for (const property of properties)
      context.say(property, `UNOBSERVED ${reason}`);
    expect(baseline).toBeDefined();
    return;
  }
  await holderProperties(context);
  await otherDescriptor(context);
  await childInherit(context);
  await sameProcess(context);
  await stoppedHolder(context);
  await pairs(context);
}

// C1 exclusive, C2 non-blocking, C3 SIGKILL release and residue, C7/C8 bytes.
async function holderProperties(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const main = context.space("main");
  const file = join(main, "F");
  writeFileSync(file, "");
  const before = residue(main);
  const holder = spawnWorker(candidate, reports, "hold", file);
  expect(await holder.wait()).toBeDefined();
  const heldAt = performance.now();
  const contender = await attempt(candidate, reports, file);
  say(
    "exclusive",
    `${field(contender, "result")} code=${field(contender, "code")}`,
  );
  // H keeps F for the stated hold time; the timed attempt then follows.
  while (performance.now() - heldAt < holdMilliseconds) await Bun.sleep(20);
  const late = await attempt(candidate, reports, file);
  say(
    "nonblocking",
    `${field(late, "result")} elapsedMs=${field(late, "elapsedMs")} holdMs=${Math.round(performance.now() - heldAt)}`,
  );
  kill(holder.child.pid);
  await holder.child.exited;
  const exitedAt = performance.now();
  let attempts = 0;
  let reacquired: Report | undefined;
  while (performance.now() - exitedAt < reacquireBoundMilliseconds) {
    attempts += 1;
    reacquired = await attempt(candidate, reports, file);
    if (field(reacquired, "result") === "acquired") break;
    await Bun.sleep(10);
  }
  const acquired = field(reacquired, "result") === "acquired";
  say(
    "sigkill-release",
    `${acquired ? "acquired" : "refused"} firstAttempt=${acquired && attempts === 1} msAfterExit=${Math.round(performance.now() - exitedAt)} attempts=${attempts} holderSignal=${holder.child.signalCode ?? "none"}`,
  );
  const after = residue(main);
  say(
    "residue",
    `${after === before ? "same" : "changed"} before=${before} after=${after}`,
  );
  const fileEntry = (listing: string) =>
    listing.split(",").find((entry) => entry.startsWith("F:"));
  say(
    "bytes",
    `${fileEntry(after) === fileEntry(before) ? "same" : "changed"} extra-files=${readdirSync(
      main,
    )
      .filter((name) => name !== "F")
      .join(",")}`,
  );
}

// C4a: the holder opens F again and closes that descriptor.
async function otherDescriptor(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const file = join(context.space("other"), "F");
  const holder = spawnWorker(
    candidate,
    reports,
    "hold",
    file,
    "other-descriptor",
  );
  const held = await holder.wait();
  if (field(held, "result") === "acquired")
    say(
      "other-descriptor-close",
      field(await attempt(candidate, reports, file), "result"),
    );
  else
    say(
      "other-descriptor-close",
      `UNOBSERVED holder gave ${field(held, "result")}`,
    );
  kill(holder.child.pid);
  await holder.child.exited;
}

// C4b: a long-lived child of the holder, after the holder is SIGKILLed.
async function childInherit(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const file = join(context.space("child"), "F");
  const parent = spawnWorker(candidate, reports, "hold", file, "child");
  const report = await parent.wait();
  const childPid = Number(field(report, "child"));
  if (!Number.isInteger(childPid) || childPid <= 0) {
    say("child-inherit", `UNOBSERVED holder gave ${field(report, "result")}`);
    kill(parent.child.pid);
    await parent.child.exited;
    return;
  }
  processes.add(childPid);
  const fd = field(report, "fd");
  const cloexec =
    linux && fd !== "null" ? fdinfoCloexec(parent.child.pid, fd) : "unknown";
  kill(parent.child.pid);
  await parent.child.exited;
  const childHasFd = linux ? childHoldsFile(childPid, file) : "unknown";
  const whileChild = await attempt(candidate, reports, file);
  say(
    "child-inherit",
    `${field(whileChild, "result") === "acquired" ? "not-inherited" : "inherited"} childHasFd=${childHasFd} cloexec=${cloexec} childAlive=${alive(childPid)}`,
  );
  kill(childPid);
}

// C4c: a second open in the same process.
async function sameProcess(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const started = spawnWorker(
    candidate,
    reports,
    "same-process",
    join(context.space("same"), "F"),
  );
  const report = await started.wait();
  await started.child.exited;
  note(candidate, report);
  say(
    "same-process-second-open",
    `${field(report, "result")} first=${field(report, "first")} code=${field(report, "code")}`,
  );
}

// C4d: a stopped holder.
async function stoppedHolder(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const file = join(context.space("stopped"), "F");
  const holder = spawnWorker(candidate, reports, "hold", file);
  await holder.wait();
  kill(holder.child.pid, "SIGSTOP");
  say(
    "stopped-holder",
    field(await attempt(candidate, reports, file), "result"),
  );
  kill(holder.child.pid, "SIGCONT");
  kill(holder.child.pid);
  await holder.child.exited;
}

// C5: per-file independence, and two contenders in opposite order.
async function pairs(context: Context): Promise<void> {
  const { candidate, reports, say } = context;
  const pair = context.space("pair");
  const fileF = join(pair, "F");
  const fileG = join(pair, "G");
  const solo = spawnWorker(candidate, reports, "hold", fileF);
  await solo.wait();
  say("per-file", field(await attempt(candidate, reports, fileG), "result"));
  kill(solo.child.pid);
  await solo.child.exited;
  const go = join(pair, "go");
  const first = spawnWorker(
    candidate,
    reports,
    "hold-then-try",
    fileF,
    fileG,
    go,
  );
  const second = spawnWorker(
    candidate,
    reports,
    "hold-then-try",
    fileG,
    fileF,
    go,
  );
  await Promise.all([first.wait(), second.wait()]);
  writeFileSync(go, "go\n");
  const attempted = (report: Report) => report.phase === "attempted";
  const [outcomeA, outcomeB] = await Promise.all([
    waitFor(first.report, attempted, 5_000),
    waitFor(second.report, attempted, 5_000),
  ]);
  say(
    "opposite-order",
    `${field(outcomeA, "result")} ${field(outcomeB, "result")} deadlock=${outcomeA === undefined || outcomeB === undefined}`,
  );
  kill(first.child.pid);
  kill(second.child.pid);
  await Promise.all([first.child.exited, second.child.exited]);
}

// Linux: is the holder's descriptor close-on-exec (O_CLOEXEC, 02000000
// octal, in the /proc/<pid>/fdinfo flags)?
function fdinfoCloexec(pid: number, fd: string): string {
  try {
    const flags = /^flags:\s+([0-7]+)$/m.exec(
      readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"),
    )?.[1];
    return flags === undefined
      ? "unknown"
      : String((Number.parseInt(flags, 8) & 0o2000000) !== 0);
  } catch {
    return "unknown";
  }
}
// Linux: does the child hold any descriptor on `file`?
function childHoldsFile(pid: number, file: string): string {
  try {
    const target = realpathSync.native(file);
    return String(
      readdirSync(`/proc/${pid}/fd`).some((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`) === target;
        } catch {
          return false;
        }
      }),
    );
  } catch {
    return "unknown";
  }
}
