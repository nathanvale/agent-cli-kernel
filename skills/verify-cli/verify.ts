import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  at,
  evidenceBytesLimit,
  listOf,
  readRegularFile,
} from "./helper/json.ts";
import {
  cli,
  probeResult,
  probeArgvs,
  readIndex,
  repositoryRoot,
  verificationRun,
  sha256,
  targetArgs,
  targetLimits,
} from "./helper/place.ts";
import type { ProbeResult, VerificationRun } from "./helper/place.ts";

const kernelFaultExit = 70;
const targetFaultExit = 3;
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
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type Spawn = (
  args: readonly string[],
  cwd: string,
  milliseconds: number,
  outputBytes?: number,
) => Promise<Ran>;

export type FailureId =
  | "kernel-import"
  | "helper-no-envelope"
  | "helper-exit-mismatch"
  | "helper-usage-exit"
  | "observation-mismatch"
  | "target-not-repeatable"
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
  "target-not-repeatable":
    "Keep what changes between runs, such as a process id, out of the target's usage refusal and discovery, then run the command again.",
  "evidence-mismatch":
    "Keep this run's folder as it is for review, and launch a new run in another folder.",
  "check-internal": `Report this line to ${cli}'s owner.`,
  "child-timeout":
    "Find what held the child past its limit, then run the command again.",
};

export function failureLine(failure: Failure): string {
  const kind =
    failure.id === "target-not-repeatable" ? "TARGET FAIL" : "RAW FAIL";
  return `${cli}: ${kind} ${failure.id}: ${failure.detail} Repair: ${repairs[failure.id]}\n`;
}

export function untrustedExit(failures: readonly Failure[]): number {
  return failures.every((failure) => failure.id === "target-not-repeatable")
    ? targetFaultExit
    : kernelFaultExit;
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
  readonly run: VerificationRun | undefined;
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
  const place = verificationRun(first);
  const read = readIndex(place);
  if (read.kind !== "read")
    return {
      root: undefined,
      target: undefined,
      run: existsSync(place.index) ? place : undefined,
    };
  return {
    root: existsSync(read.run.repository) ? read.run.repository : undefined,
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

function judgedRun(ran: Ran, what: string, milliseconds: number) {
  const late = timeoutFailure(ran, what, milliseconds);
  return late.length > 0
    ? { failures: late, envelope: undefined }
    : envelopeFailures(ran, what);
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
  const judged = judgedRun(ran, "the helper's probe", limits.probeMilliseconds);
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

function probeResultOf(value: unknown): ProbeResult | undefined {
  const exitCode = at(value, "exitCode");
  const stdoutBytes = at(value, "stdoutBytes");
  const stdoutSha256 = at(value, "stdoutSha256");
  const stderrSha256 = at(value, "stderrSha256");
  if (
    (exitCode !== null && typeof exitCode !== "number") ||
    typeof stdoutBytes !== "number" ||
    typeof stdoutSha256 !== "string" ||
    typeof stderrSha256 !== "string"
  )
    return undefined;
  return {
    argv: listOf(at(value, "argv")).map(String),
    exitCode,
    stdoutBytes,
    stdoutSha256,
    stderrSha256,
  };
}

export function compared(
  helper: ProbeResult | undefined,
  raw: ProbeResult,
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
    ["stdout hash", helper.stdoutSha256, raw.stdoutSha256],
    ["stderr hash", helper.stderrSha256, raw.stderrSha256],
  ] as const;
  return fields
    .filter(([, seen, actual]) => seen !== actual)
    .map(([field, seen, actual]) => ({
      id: "observation-mismatch",
      detail: `for ${where} the helper saw ${field} ${String(seen)}, and a raw run saw ${String(actual)}.`,
    }));
}

type Round =
  | { readonly kind: "failed"; readonly failures: Failure[] }
  | {
      readonly kind: "seen";
      readonly helper: readonly (ProbeResult | undefined)[];
      readonly raw: readonly ProbeResult[];
    };

async function probeRound(
  spawn: Spawn,
  target: string,
  root: string,
  limits: Limits,
): Promise<Round> {
  const ran = await spawn(
    ["--no-install", helperEntry, "probe", target, "--json"],
    root,
    limits.commandMilliseconds,
  );
  const judged = judgedRun(
    ran,
    "the helper's probe command",
    limits.commandMilliseconds,
  );
  if (judged.failures.length > 0)
    return { kind: "failed", failures: judged.failures };
  const seen = listOf(at(judged.envelope, "result", "data", "probes"));
  const raw: ProbeResult[] = [];
  for (const argv of probeArgvs)
    raw.push(
      probeResult(
        argv,
        await spawn(
          targetArgs(target, argv),
          root,
          targetLimits.timeoutMilliseconds,
          targetLimits.outputLimitBytes,
        ),
      ),
    );
  return {
    kind: "seen",
    helper: probeArgvs.map((_, index) => probeResultOf(seen[index])),
    raw,
  };
}

function steady(
  first: ProbeResult | undefined,
  second: ProbeResult | undefined,
): boolean {
  if (first === undefined || second === undefined) return first === second;
  return compared(first, second).length === 0;
}

export async function probeFailures(
  spawn: Spawn,
  target: string,
  root: string,
  limits: Limits,
): Promise<Failure[]> {
  const first = await probeRound(spawn, target, root, limits);
  if (first.kind === "failed") return first.failures;
  const mismatches = first.raw.map((raw, index) =>
    compared(first.helper[index], raw),
  );
  if (mismatches.every((found) => found.length === 0)) return [];
  const second = await probeRound(spawn, target, root, limits);
  if (second.kind === "failed") return second.failures;
  return mismatches.flatMap((found, index) => {
    if (found.length === 0) return [];
    const helperSteady = steady(first.helper[index], second.helper[index]);
    const rawSteady = steady(first.raw[index], second.raw[index]);
    if (helperSteady && rawSteady) return found;
    return [
      {
        id: "target-not-repeatable" as const,
        detail: `the target answered ${JSON.stringify(probeArgvs[index])} differently on two runs, so the helper's observation cannot be confirmed.`,
      },
    ];
  });
}

export function evidenceFailures(place: VerificationRun): Failure[] {
  const read = readIndex(place);
  if (read.kind === "missing") return [];
  if (read.kind === "unreadable")
    return [{ id: "evidence-mismatch", detail: read.reason }];
  const failures: Failure[] = [];
  for (const row of read.steps) {
    const path = join(place.evidence, row.file);
    const file = readRegularFile(path, evidenceBytesLimit);
    if (file.kind !== "read")
      failures.push({
        id: "evidence-mismatch",
        detail: file.kind === "missing" ? `${path} is missing.` : file.reason,
      });
    else if (sha256(file.bytes) !== row.sha256)
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

export function relayed(helper: Ran, json: boolean, self: string): Relayed {
  if (json) return { stream: "stdout", text: helper.stdout };
  const envelope = oneJsonLine(helper.stdout);
  const message = String(at(envelope, "message")).replaceAll(
    `${cli} --help`,
    () => `${self} --help`,
  );
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

function beforeLiteral(argv: readonly string[], after = false) {
  const literal = argv.indexOf("--") >>> 0;
  return after ? argv.slice(literal) : argv.slice(0, literal);
}

export type Checked =
  | { readonly kind: "untrusted"; readonly failures: readonly Failure[] }
  | { readonly kind: "trusted"; readonly helper: Ran };

export async function kernelFreeCheck(
  given: readonly string[],
  cwd: string,
  spawn: Spawn,
  limits: Limits = defaultLimits,
): Promise<Checked> {
  const argv = absoluteArgv(
    beforeLiteral(given)
      .filter((word) => word !== "--json")
      .concat(beforeLiteral(given, true)),
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
    [...targetCommands, "launch", "drive", "report"].includes(name)
  )
    failures.push(...(await probeFailures(spawn, found.target, root, limits)));
  if (found.run !== undefined) failures.push(...evidenceFailures(found.run));
  if (failures.length > 0) return { kind: "untrusted", failures };
  const milliseconds =
    name === "drive" ? limits.driveMilliseconds : limits.commandMilliseconds;
  const helper = await spawn(
    [
      "--no-install",
      helperEntry,
      ...beforeLiteral(argv),
      "--json",
      ...beforeLiteral(argv, true),
    ],
    root,
    milliseconds,
  );
  failures.push(
    ...judgedRun(helper, `the helper's ${name} command`, milliseconds).failures,
  );
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

function signalGroup(child: Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function bunSpawn(
  env: Readonly<Record<string, string | undefined>>,
  limits: Limits = defaultLimits,
): Spawn {
  return async (args, cwd, milliseconds, outputBytes) => {
    if (received !== undefined)
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    const child = Bun.spawn([process.execPath, ...args], {
      cwd,
      env: { ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    running.add(child);
    let timedOut = false;
    const term = afterDelay(milliseconds);
    const kill = afterDelay(milliseconds + limits.graceMilliseconds);
    void term.passed.then(() => {
      timedOut = true;
      signalGroup(child, "SIGTERM");
    });
    void kill.passed.then(() => {
      signalGroup(child, "SIGKILL");
    });
    const drain = child.exited.then(() => afterDelay(limits.graceMilliseconds));
    const drained = drain.then((delay) => delay.passed);
    const [stdout, stderr] = await Promise.all([
      capped(child.stdout, outputBytes ?? limits.outputBytes, drained),
      capped(child.stderr, outputBytes ?? limits.outputBytes, drained),
    ]);
    await child.exited;
    signalGroup(child, "SIGKILL");
    (await drain).cancel();
    term.cancel();
    kill.cancel();
    running.delete(child);
    return {
      exitCode: child.exitCode,
      signal: child.signalCode === null ? null : String(child.signalCode),
      stdout,
      stderr,
      timedOut,
    };
  };
}

export function forwardStops(
  limits = defaultLimits,
  listen: (signal: NodeJS.Signals, stop: () => void) => unknown = (
    signal,
    stop,
  ) => process.on(signal, stop),
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    listen(signal, () => {
      received ??= signal;
      for (const child of running) signalGroup(child, "SIGTERM");
      setTimeout(() => {
        for (const child of running) signalGroup(child, "SIGKILL");
      }, limits.graceMilliseconds).unref();
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
    checked = await kernelFreeCheck(argv, cwd, spawn, limits);
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
      exit: untrustedExit(checked.failures),
      writes: checked.failures.map((failure) => ({
        stream: "stderr",
        text: failureLine(failure),
      })),
    };
  return {
    exit: checked.helper.exitCode ?? kernelFaultExit,
    writes: [
      relayed(
        checked.helper,
        beforeLiteral(argv).includes("--json"),
        `bun ${relative(cwd, import.meta.path)}`,
      ),
    ],
  };
}

function written(write: Relayed): Promise<void> {
  const stream = write.stream === "stdout" ? process.stdout : process.stderr;
  return new Promise((done) => {
    stream.write(write.text, () => {
      done();
    });
  });
}

if (import.meta.main) {
  forwardStops();
  const { exit, writes } = await main(
    process.argv.slice(2),
    process.cwd(),
    bunSpawn(process.env),
  );
  for (const write of writes) await written(write);
  process.exit(exit);
}
