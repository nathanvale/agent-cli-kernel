import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { at, listOf } from "./helper/json.ts";
import {
  cli,
  observation,
  probeArgvs,
  readIndex,
  repositoryRoot,
  runPlace,
  sha256,
  targetArgs,
} from "./helper/place.ts";
import type { Observation, RunPlace } from "./helper/place.ts";

const untrustedExit = 70;
const helperEntry = join(import.meta.dir, "helper", "cli.ts");
const undeclaredCommand = "verify-cli-undeclared-command";

export type Limits = {
  readonly probeMilliseconds: number;
  readonly commandMilliseconds: number;
  readonly driveMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly outputBytes: number;
};

export const defaultLimits: Limits = {
  probeMilliseconds: 60_000,
  commandMilliseconds: 600_000,
  driveMilliseconds: 7_200_000,
  graceMilliseconds: 10_000,
  outputBytes: 8_388_608,
};

export type Ran = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type Spawn = (
  args: readonly string[],
  cwd: string,
  milliseconds: number,
) => Promise<Ran>;

export type FailureId =
  | "kernel-import"
  | "helper-no-envelope"
  | "helper-exit-mismatch"
  | "helper-usage-exit"
  | "observation-mismatch"
  | "evidence-mismatch"
  | "check-internal"
  | "child-timeout";

export type Failure = { readonly id: FailureId; readonly detail: string };

const kernelRepair =
  "Reinstall the kernel at the repository's pin, and report the fault to the kernel's owner with this line.";

const repairs: Readonly<Record<FailureId, string>> = {
  "kernel-import":
    "Run bun install --frozen-lockfile in the repository root, so agent-cli-kernel resolves from the skill folder.",
  "helper-no-envelope": kernelRepair,
  "helper-exit-mismatch": kernelRepair,
  "helper-usage-exit": kernelRepair,
  "observation-mismatch": kernelRepair,
  "evidence-mismatch":
    "Keep this run's folder as it is for review, and launch a new run in another folder.",
  "check-internal": `Report this line to ${cli}'s owner.`,
  "child-timeout":
    "Find what held the child past its limit, such as a target waiting on input, and run the command again.",
};

export function failureLine(failure: Failure): string {
  return `${cli}: RAW FAIL ${failure.id}: ${failure.detail} Repair: ${repairs[failure.id]}\n`;
}

const targetCommands = ["ready", "probe", "sweep", "findings"];
const runCommands = ["launch", "drive", "report", "cleanup", "pending"];

export function absoluteArgv(
  argv: readonly string[],
  cwd: string,
): readonly string[] {
  const name = argv[0] ?? "";
  if (!targetCommands.includes(name) && !runCommands.includes(name))
    return argv;
  return argv.map((word, index) =>
    index === 0 || word.startsWith("-") ? word : resolve(cwd, word),
  );
}

function positional(argv: readonly string[], index: number) {
  return argv.filter((word) => !word.startsWith("-"))[index];
}

export type Bound = {
  readonly root: string | undefined;
  readonly target: string | undefined;
  readonly run: RunPlace | undefined;
};

export function bound(argv: readonly string[]): Bound {
  const name = argv[0] ?? "";
  const first = positional(argv, 1);
  if (targetCommands.includes(name) && first !== undefined)
    return { root: repositoryRoot(first), target: first, run: undefined };
  if (name === "launch") {
    const target = positional(argv, 2);
    return {
      root: target === undefined ? undefined : repositoryRoot(target),
      target,
      run: undefined,
    };
  }
  if (!runCommands.includes(name) || first === undefined)
    return { root: undefined, target: undefined, run: undefined };
  const place = runPlace(first);
  const read = readIndex(place);
  if (read.kind !== "read")
    return {
      root: undefined,
      target: undefined,
      run: existsSync(place.index) ? place : undefined,
    };
  return {
    root: read.run.repository,
    target: ["drive", "report"].includes(name)
      ? join(read.run.repository, read.run.target)
      : undefined,
    run: place,
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function oneJsonLine(text: string): unknown {
  const lines = text.split("\n");
  if (lines.length !== 2 || lines[1] !== "") return undefined;
  try {
    const value: unknown = JSON.parse(lines[0] ?? "");
    return value;
  } catch {
    return undefined;
  }
}

export function timeoutFailure(
  ran: Ran,
  what: string,
  milliseconds: number,
): Failure[] {
  return ran.timedOut
    ? [
        {
          id: "child-timeout",
          detail: `${what} ran past its limit of ${String(milliseconds)} ms and was stopped.`,
        },
      ]
    : [];
}

export async function kernelImport(
  spawn: Spawn,
  skillFolder: string,
  limits: Limits,
): Promise<Failure[]> {
  const ran = await spawn(
    ["--no-install", "-e", 'await import("agent-cli-kernel");'],
    skillFolder,
    limits.probeMilliseconds,
  );
  const late = timeoutFailure(
    ran,
    "the kernel import",
    limits.probeMilliseconds,
  );
  if (late.length > 0) return late;
  return ran.exitCode === 0
    ? []
    : [
        {
          id: "kernel-import",
          detail: `importing agent-cli-kernel from ${skillFolder} exited ${String(ran.exitCode)}: ${firstLine(ran.stderr)}`,
        },
      ];
}

export function envelopeFailures(
  ran: Ran,
  what: string,
): { readonly failures: Failure[]; readonly envelope: unknown } {
  const envelope = oneJsonLine(ran.stdout);
  const said = at(envelope, "result", "exitCode");
  if (envelope === undefined || typeof said !== "number")
    return {
      failures: [
        {
          id: "helper-no-envelope",
          detail: `${what} exited ${String(ran.exitCode)} without exactly one envelope on stdout. stderr: ${firstLine(ran.stderr)}`,
        },
      ],
      envelope,
    };
  if (said !== ran.exitCode)
    return {
      failures: [
        {
          id: "helper-exit-mismatch",
          detail: `${what}'s envelope says exit ${String(said)}, but its process exited ${String(ran.exitCode)}.`,
        },
      ],
      envelope,
    };
  return { failures: [], envelope };
}

export async function helperProbe(
  spawn: Spawn,
  cwd: string,
  limits: Limits,
): Promise<Failure[]> {
  const ran = await spawn(
    ["--no-install", helperEntry, undeclaredCommand, "--json"],
    cwd,
    limits.probeMilliseconds,
  );
  const late = timeoutFailure(
    ran,
    "the helper's probe",
    limits.probeMilliseconds,
  );
  if (late.length > 0) return late;
  const judged = envelopeFailures(ran, "the helper's probe");
  if (judged.failures.length > 0) return judged.failures;
  return ran.exitCode === 2
    ? []
    : [
        {
          id: "helper-usage-exit",
          detail: `the helper answered a command it does not declare with exit ${String(ran.exitCode)}, not 2.`,
        },
      ];
}

function observationOf(value: unknown): Observation | undefined {
  const exitCode = at(value, "exitCode");
  const stdoutBytes = at(value, "stdoutBytes");
  const stderrSha256 = at(value, "stderrSha256");
  if (
    (exitCode !== null && typeof exitCode !== "number") ||
    typeof stdoutBytes !== "number" ||
    typeof stderrSha256 !== "string"
  )
    return undefined;
  return {
    argv: listOf(at(value, "argv")).map(String),
    exitCode,
    stdoutBytes,
    stderrSha256,
  };
}

export function compared(
  helper: Observation | undefined,
  raw: Observation,
): Failure[] {
  const where = JSON.stringify(raw.argv);
  if (helper === undefined)
    return [
      {
        id: "observation-mismatch",
        detail: `the helper's probe returned no observation for ${where}.`,
      },
    ];
  const fields = [
    ["exit code", helper.exitCode, raw.exitCode],
    ["stdout byte count", helper.stdoutBytes, raw.stdoutBytes],
    ["stderr hash", helper.stderrSha256, raw.stderrSha256],
  ] as const;
  return fields
    .filter(([, seen, actual]) => seen !== actual)
    .map(([field, seen, actual]) => ({
      id: "observation-mismatch",
      detail: `for ${where} the helper saw ${field} ${String(seen)}, and a raw run saw ${String(actual)}.`,
    }));
}

export async function observationFailures(
  spawn: Spawn,
  target: string,
  root: string,
  limits: Limits,
): Promise<Failure[]> {
  const ran = await spawn(
    ["--no-install", helperEntry, "probe", target, "--json"],
    root,
    limits.commandMilliseconds,
  );
  const late = timeoutFailure(
    ran,
    "the helper's probe command",
    limits.commandMilliseconds,
  );
  if (late.length > 0) return late;
  const judged = envelopeFailures(ran, "the helper's probe command");
  if (judged.failures.length > 0) return judged.failures;
  const seen = listOf(at(judged.envelope, "result", "data", "probes"));
  const failures: Failure[] = [];
  for (const [index, argv] of probeArgvs.entries()) {
    const raw = await spawn(
      targetArgs(target, argv),
      root,
      limits.probeMilliseconds,
    );
    const rawLate = timeoutFailure(
      raw,
      `a raw run of ${JSON.stringify(argv)}`,
      limits.probeMilliseconds,
    );
    if (rawLate.length > 0) return rawLate;
    failures.push(
      ...compared(observationOf(seen[index]), observation(argv, raw)),
    );
  }
  return failures;
}

export function evidenceFailures(place: RunPlace): Failure[] {
  const read = readIndex(place);
  if (read.kind === "missing") return [];
  if (read.kind === "unreadable")
    return [{ id: "evidence-mismatch", detail: read.reason }];
  const failures: Failure[] = [];
  for (const row of read.steps) {
    const path = join(place.evidence, row.file);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      failures.push({ id: "evidence-mismatch", detail: `${path} is missing.` });
      continue;
    }
    if (sha256(bytes) !== row.sha256)
      failures.push({
        id: "evidence-mismatch",
        detail: `${path} no longer matches the hash its index row recorded.`,
      });
  }
  return failures;
}

export type Relayed = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export function relayed(helper: Ran, json: boolean): Relayed {
  if (json) return { stream: "stdout", text: helper.stdout };
  const envelope = oneJsonLine(helper.stdout);
  const message = String(at(envelope, "message"));
  if (helper.exitCode !== 0) return { stream: "stderr", text: `${message}\n` };
  const data = at(envelope, "result", "data");
  return {
    stream: "stdout",
    text:
      data === null || data === undefined
        ? `${message}\n`
        : `${message}\n${JSON.stringify(data, null, 2)}\n`,
  };
}

export type Checked =
  | { readonly kind: "untrusted"; readonly failures: readonly Failure[] }
  | { readonly kind: "trusted"; readonly helper: Ran };

export async function check(
  given: readonly string[],
  cwd: string,
  spawn: Spawn,
  limits: Limits = defaultLimits,
): Promise<Checked> {
  const argv = absoluteArgv(
    given.filter((word) => word !== "--json"),
    cwd,
  );
  const found = bound(argv);
  const root = found.root ?? cwd;
  const first = [
    ...(await kernelImport(spawn, import.meta.dir, limits)),
    ...(await helperProbe(spawn, root, limits)),
  ];
  if (first.length > 0) return { kind: "untrusted", failures: first };
  const name = argv[0] ?? "";
  const failures: Failure[] = [];
  if (
    found.target !== undefined &&
    [
      "ready",
      "probe",
      "sweep",
      "findings",
      "launch",
      "drive",
      "report",
    ].includes(name)
  )
    failures.push(
      ...(await observationFailures(spawn, found.target, root, limits)),
    );
  if (found.run !== undefined) failures.push(...evidenceFailures(found.run));
  if (failures.length > 0) return { kind: "untrusted", failures };
  const milliseconds =
    name === "drive" ? limits.driveMilliseconds : limits.commandMilliseconds;
  const helper = await spawn(
    ["--no-install", helperEntry, ...argv, "--json"],
    root,
    milliseconds,
  );
  const late = timeoutFailure(
    helper,
    `the helper's ${name} command`,
    milliseconds,
  );
  if (late.length > 0) return { kind: "untrusted", failures: late };
  const judged = envelopeFailures(helper, `the helper's ${name} command`);
  failures.push(...judged.failures);
  if (found.run !== undefined && ["drive", "cleanup"].includes(name))
    failures.push(...evidenceFailures(found.run));
  return failures.length > 0
    ? { kind: "untrusted", failures }
    : { kind: "trusted", helper };
}

const running = new Set<Subprocess>();
let received: "SIGTERM" | "SIGINT" | undefined;

async function capped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  done: Promise<unknown>,
): Promise<string> {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  void done.then(() => reader.cancel().catch(() => undefined));
  for (;;) {
    const next = await reader.read().catch(() => undefined);
    if (next === undefined || next.done) break;
    const room = limit - size;
    if (room > 0) kept.push(next.value.slice(0, room));
    size += next.value.byteLength;
  }
  return new TextDecoder().decode(Buffer.concat(kept));
}

function afterDelay(milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<void>((done) => {
    timer = setTimeout(done, milliseconds);
  });
  return { passed, cancel: () => clearTimeout(timer) };
}

export function bunSpawn(
  env: Readonly<Record<string, string | undefined>>,
  limits: Limits = defaultLimits,
): Spawn {
  return async (args, cwd, milliseconds) => {
    if (received !== undefined)
      return { exitCode: null, stdout: "", stderr: "", timedOut: false };
    const child = Bun.spawn([process.execPath, ...args], {
      cwd,
      env: { ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    running.add(child);
    let timedOut = false;
    const term = afterDelay(milliseconds);
    const kill = afterDelay(milliseconds + limits.graceMilliseconds);
    void term.passed.then(() => {
      timedOut = true;
      child.kill("SIGTERM");
    });
    void kill.passed.then(() => child.kill("SIGKILL"));
    const drain = child.exited.then(() => afterDelay(limits.graceMilliseconds));
    const drained = drain.then((delay) => delay.passed);
    const [stdout, stderr] = await Promise.all([
      capped(child.stdout, limits.outputBytes, drained),
      capped(child.stderr, limits.outputBytes, drained),
    ]);
    await child.exited;
    (await drain).cancel();
    term.cancel();
    kill.cancel();
    running.delete(child);
    return { exitCode: child.exitCode, stdout, stderr, timedOut };
  };
}

function forwardStops(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      received ??= signal;
      for (const child of running) child.kill("SIGTERM");
    });
}

export function stopExit(): number | undefined {
  if (received === "SIGTERM") return 143;
  if (received === "SIGINT") return 130;
  return undefined;
}

export async function main(
  argv: readonly string[],
  cwd: string,
  spawn: Spawn,
  limits: Limits = defaultLimits,
): Promise<{ readonly exit: number; readonly writes: readonly Relayed[] }> {
  let checked: Checked;
  try {
    checked = await check(argv, cwd, spawn, limits);
  } catch (error) {
    checked = {
      kind: "untrusted",
      failures: [
        {
          id: "check-internal",
          detail: `the check threw: ${error instanceof Error ? firstLine(error.message) : String(error)}`,
        },
      ],
    };
  }
  const stopped = stopExit();
  if (stopped !== undefined)
    return {
      exit: stopped,
      writes: [
        {
          stream: "stderr",
          text: `${cli}: stopped by ${String(received)}; the helper stopped its children first.\n`,
        },
      ],
    };
  if (checked.kind === "untrusted")
    return {
      exit: untrustedExit,
      writes: checked.failures.map((failure) => ({
        stream: "stderr",
        text: failureLine(failure),
      })),
    };
  return {
    exit: checked.helper.exitCode ?? untrustedExit,
    writes: [relayed(checked.helper, argv.includes("--json"))],
  };
}

if (import.meta.main) {
  forwardStops();
  const { exit, writes } = await main(
    process.argv.slice(2),
    process.cwd(),
    bunSpawn(process.env),
  );
  for (const write of writes)
    if (write.stream === "stdout") process.stdout.write(write.text);
    else process.stderr.write(write.text);
  process.exit(exit);
}
