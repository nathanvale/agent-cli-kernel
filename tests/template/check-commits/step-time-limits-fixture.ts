import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { repository } from "../../support/check-commits-fixture.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import {
  processGroupOf,
  type SignalAt,
  spawnBounded,
} from "../../support/process.ts";
import { signalGroupIfPresent, signalIfPresent } from "../../support/signal.ts";

export const reapBound = 5_000;

const doctorSources = [
  "scripts/doctor.ts",
  "scripts/process-runner.ts",
  "src/toolchain-resolution.ts",
];

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ESRCH") return false;
    throw error;
  }
}

// Platform: an orphan is reaped by init or launchd, not by this process, so
// it can answer signal 0 for a while after it was killed.
export function exited(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < reapBound) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

const ownProcessGroup = processGroupOf(process.pid);

export function recordedProcesses(path: string): {
  readonly group: number | undefined;
  readonly pids: readonly number[];
} {
  if (!existsSync(path)) return { group: undefined, pids: [] };
  const numbers = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const [group, ...pids] = numbers;
  return { group, pids };
}

export function reapRecorded(path: string): void {
  const { group, pids } = recordedProcesses(path);
  if (group === undefined || group === ownProcessGroup) return;
  const stillInGroup = pids.filter(
    (pid) => pid !== process.pid && processGroupOf(pid) === group,
  );
  if (stillInGroup.length === 0) return;
  signalGroupIfPresent(group, "SIGKILL");
  for (const pid of stillInGroup)
    if (processGroupOf(pid) === group) signalIfPresent(pid, "SIGKILL");
}

function sleepScript(
  ledger: string,
  pids: string,
  ignoreTerm: boolean,
): string {
  const trap = ignoreTerm ? "trap '' TERM; " : "";
  return [
    ...(ignoreTerm ? ["trap '' TERM"] : []),
    `(${trap}exec sleep 300) &`,
    "child=$!",
    "pgid=$(perl -e 'print getpgrp(0)')",
    `printf '%s\\n%s\\n%s\\n' "$pgid" "$$" "$child" > '${pids}'`,
    `echo started >> '${ledger}'`,
    "wait",
  ].join("\n");
}

export function hangIgnoringTerm(ledger: string, pids: string): string {
  return sleepScript(ledger, pids, true);
}

export function sleepWithChild(ledger: string, pids: string): string {
  return sleepScript(ledger, pids, false);
}

export function gitWrapper(scratch: string, body: string): string {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is not on PATH.");
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  ${body}
fi
exec '${realGit}' "$@"
`,
    { mode: 0o755 },
  );
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

export function runDoctor(
  root: string,
  env: Record<string, string> = {},
  options: {
    readonly boundMilliseconds?: number;
    readonly signalAt?: SignalAt;
  } = {},
) {
  return spawnBounded([process.execPath, join(root, "scripts/doctor.ts")], {
    cwd: root,
    env: { ...inherited(), ...gitEnv, ...env },
    ...options,
  });
}

function writeFile(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function doctorProject(
  folder: (prefix: string) => string,
  fallowScript: string,
): string {
  const root = folder("doctor-limit-");
  for (const path of doctorSources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ packageManager: `bun@${Bun.version}` }),
    "node_modules/typescript-eslint/package.json":
      '{"name":"typescript-eslint","main":"index.js"}',
    "node_modules/typescript-eslint/index.js": "module.exports = {};",
    "node_modules/typescript/package.json":
      '{"name":"typescript","version":"6.0.2","main":"index.js"}',
    "node_modules/typescript/index.js":
      'module.exports = { version: "6.0.2" };',
    "node_modules/@typescript/native/package.json": '{"version":"7.1.0-beta"}',
    "node_modules/fallow-type-aware/package.json":
      '{"name":"fallow-type-aware","version":"3.43.2"}',
    "node_modules/fallow-type-aware/node_modules/typescript/package.json":
      '{"version":"7.0.2"}',
    "node_modules/.bin/tsc": "#!/bin/sh\necho 'Version 7.1.0-beta'\n",
    "node_modules/.bin/fallow": fallowScript,
  };
  for (const [path, content] of Object.entries(files))
    writeFile(root, path, content);
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  chmodSync(join(root, "node_modules/.bin/fallow"), 0o755);
  return root;
}
