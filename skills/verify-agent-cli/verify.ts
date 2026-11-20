// Interface: the check that does not go through the kernel. It imports
// agent-cli-kernel only to see that it loads, starts its children with
// Bun.spawn and writes its own streams, so the consumer lint's five hits on
// this file are recorded in eslint-suppressions.json on purpose. It shares
// only the kernel-free helper/place.ts and helper/json.ts with the helper.
import { join } from "node:path";
import type { Subprocess } from "bun";
import { at } from "./helper/json.ts";
import {
  entryFor,
  readRunRecord,
  runPlace,
  verificationFolder,
} from "./helper/place.ts";

const rawFailureExit = 70;
const unknownWord = "verify-agent-cli-no-such-command";

export type Bounds = {
  readonly helperMilliseconds: number;
  readonly targetMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly outputBytes: number;
};

const defaultBounds: Bounds = {
  helperMilliseconds: 660_000,
  targetMilliseconds: 30_000,
  graceMilliseconds: 10_000,
  outputBytes: 8_388_608,
};

export type Ran = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stopped: string | null;
};

export type Place = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

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
  return Buffer.concat(kept).toString("utf8");
}

function afterDelay(milliseconds: number): {
  readonly passed: Promise<void>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { passed, cancel: () => clearTimeout(timer) };
}

async function spawn(
  args: readonly string[],
  bound: number,
  place: Place,
  bounds: Bounds,
): Promise<Ran> {
  if (received !== undefined)
    return { exitCode: null, stdout: "", stderr: "", stopped: received };
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: place.cwd,
    env: { ...place.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(child);
  let stopped: string | null = null;
  const term = afterDelay(bound);
  const kill = afterDelay(bound + bounds.graceMilliseconds);
  void term.passed.then(() => {
    stopped = `SIGTERM after ${String(bound)} ms`;
    child.kill("SIGTERM");
  });
  void kill.passed.then(() => {
    stopped = `SIGKILL after ${String(bound + bounds.graceMilliseconds)} ms`;
    child.kill("SIGKILL");
  });
  const drain = child.exited.then(() => afterDelay(bounds.graceMilliseconds));
  const drained = drain.then((delay) => delay.passed);
  const [stdout, stderr] = await Promise.all([
    capped(child.stdout, bounds.outputBytes, drained),
    capped(child.stderr, bounds.outputBytes, drained),
  ]);
  await child.exited;
  (await drain).cancel();
  term.cancel();
  kill.cancel();
  running.delete(child);
  return { exitCode: child.exitCode, stdout, stderr, stopped };
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

export async function kernelFailures(): Promise<string[]> {
  try {
    const kernel: unknown = await import("agent-cli-kernel");
    return ["command", "contractFor", "runProcess"].every(
      (name) => typeof at(kernel, name) === "function",
    )
      ? []
      : [
          "kernel-exports: agent-cli-kernel lacks command, contractFor or runProcess",
        ];
  } catch (error) {
    return [
      `kernel-import: ${error instanceof Error ? firstLine(error.message) : "agent-cli-kernel did not import"}`,
    ];
  }
}

function optionValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function entryOf(argv: readonly string[], place: Place): string {
  const run = optionValue(argv, "--run");
  const record =
    run === undefined
      ? undefined
      : readRunRecord(runPlace(verificationFolder(place.env), run));
  return entryFor(optionValue(argv, "--entry"), record, place.cwd);
}

export async function targetFailures(
  entry: string,
  place: Place,
  bounds: Bounds = defaultBounds,
): Promise<string[]> {
  const failures: string[] = [];
  const unknown = await spawn(
    ["--no-install", entry, unknownWord],
    bounds.targetMilliseconds,
    place,
    bounds,
  );
  if (unknown.exitCode !== 2)
    failures.push(
      `target-usage-exit: an unknown command exited ${String(unknown.exitCode)}, not 2. stderr: ${firstLine(unknown.stderr)}`,
    );
  if (
    unknown.stdout !== "" ||
    !/^[^\n]+ \[USAGE_UNKNOWN_COMMAND\]\n$/.test(unknown.stderr)
  )
    failures.push(
      `target-usage-streams: an unknown command must print nothing on stdout and one stderr line ending [USAGE_UNKNOWN_COMMAND]; it printed ${String(unknown.stdout.length)} bytes on stdout. stderr: ${firstLine(unknown.stderr)}`,
    );
  const discovery = await spawn(
    ["--no-install", entry, "--discover", "--json"],
    bounds.targetMilliseconds,
    place,
    bounds,
  );
  const envelope = oneJsonLine(discovery.stdout);
  const claimed = at(envelope, "result", "exitCode");
  if (
    discovery.exitCode !== 0 ||
    discovery.stderr !== "" ||
    typeof at(envelope, "contractVersion") !== "string" ||
    claimed !== 0
  )
    failures.push(
      `target-discovery: --discover --json exited ${String(discovery.exitCode)}, its envelope says exit ${String(claimed)}; both must be 0, with one envelope on stdout and nothing on stderr. stderr: ${firstLine(discovery.stderr)}`,
    );
  return failures;
}

export function helperFailures(helper: Ran): string[] {
  if (helper.stopped !== null)
    return [
      `helper-stopped: the helper was stopped (${helper.stopped}) before it answered.`,
    ];
  const envelope = oneJsonLine(helper.stdout);
  const said = at(envelope, "result", "exitCode");
  if (envelope === undefined || typeof said !== "number")
    return [
      `helper-no-envelope: the helper exited ${String(helper.exitCode)} without one envelope on stdout. stderr: ${firstLine(helper.stderr)}`,
    ];
  if (said !== helper.exitCode)
    return [
      `helper-exit-mismatch: the helper's envelope says exit ${String(said)}, but its process exited ${String(helper.exitCode)}. Its message: ${String(at(envelope, "message"))}`,
    ];
  return [];
}

export type Relayed = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export function relayed(helper: Ran, json: boolean): Relayed {
  if (json) return { stream: "stdout", text: helper.stdout };
  const envelope = oneJsonLine(helper.stdout);
  const message = String(at(envelope, "message"));
  if (helper.exitCode !== 0) {
    const cause = String(at(envelope, "result", "causeCode"));
    return {
      stream: "stderr",
      text: `verify-agent-cli: ${message} [${cause}]\n`,
    };
  }
  const data = at(envelope, "result", "data");
  return {
    stream: "stdout",
    text:
      data === null || data === undefined
        ? `${message}\n`
        : `${message}\n${JSON.stringify(data, null, 2)}\n`,
  };
}

export async function verify(
  argv: readonly string[],
  place: Place,
  bounds: Bounds = defaultBounds,
): Promise<{ readonly failures: readonly string[]; readonly helper: Ran }> {
  const failures = await kernelFailures();
  if (argv[0] === "doctor") {
    try {
      failures.push(
        ...(await targetFailures(entryOf(argv, place), place, bounds)),
      );
    } catch (error) {
      failures.push(
        `target-entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const helper = await spawn(
    [
      "--no-install",
      join(import.meta.dir, "helper", "cli.ts"),
      ...argv.filter((word) => word !== "--json"),
      "--json",
    ],
    bounds.helperMilliseconds,
    place,
    bounds,
  );
  failures.push(...helperFailures(helper));
  return { failures, helper };
}

function stopExit(): number | undefined {
  if (received === "SIGTERM") return 143;
  if (received === "SIGINT") return 130;
  return undefined;
}

function forwardStops(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      received ??= signal;
      for (const child of running) child.kill("SIGTERM");
    });
}

if (import.meta.main) {
  forwardStops();
  const argv = process.argv.slice(2);
  const { failures, helper } = await verify(argv, {
    cwd: process.cwd(),
    env: process.env,
  });
  const stopped = stopExit();
  if (stopped !== undefined) {
    process.stderr.write(
      `verify-agent-cli: stopped by ${String(received)}; the helper stopped its drive first.\n`,
    );
    process.exit(stopped);
  }
  if (failures.length > 0) {
    for (const failure of failures)
      process.stderr.write(`verify-agent-cli: RAW FAIL ${failure}\n`);
    process.exit(rawFailureExit);
  }
  const { stream, text } = relayed(helper, argv.includes("--json"));
  if (stream === "stdout") process.stdout.write(text);
  else process.stderr.write(text);
  process.exit(helper.exitCode ?? rawFailureExit);
}
