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
import { signalIfPresent } from "../../support/signal.ts";

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
  signalIfPresent(pid, signal);
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
function filesystem(folder: string): string {
  const real = realpathSync.native(folder);
  const mounts =
    linux && existsSync("/proc/self/mountinfo")
      ? linuxMounts()
      : darwinMounts();
  // Platform: macOS firmlinks data paths into /System/Volumes/Data, so the mount point
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
