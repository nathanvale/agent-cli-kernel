// Interface: the check that does not go through the kernel. It imports
// agent-cli-kernel only to see that it loads, starts its children with
// Bun.spawnSync and writes its own streams, so the consumer lint's four hits
// on this file are recorded in eslint-suppressions.json on purpose.
import { isAbsolute, join } from "node:path";

const rawFailureExit = 70;
const helperBoundMilliseconds = 660_000;
const targetBoundMilliseconds = 30_000;
const unknownWord = "verify-agent-cli-no-such-command";

export type Ran = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type Place = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

function spawn(args: readonly string[], timeout: number, place: Place): Ran {
  const ran = Bun.spawnSync([process.execPath, ...args], {
    cwd: place.cwd,
    env: { ...place.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function fieldOf(value: unknown, ...names: readonly string[]): unknown {
  let current = value;
  for (const name of names) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, name)) return undefined;
    current = Reflect.get(current, name);
  }
  return current;
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
      (name) => typeof fieldOf(kernel, name) === "function",
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

export function entryOf(argv: readonly string[], cwd: string): string {
  const given = argv[argv.indexOf("--entry") + 1];
  const entry =
    argv.includes("--entry") && given !== undefined ? given : "src/cli.ts";
  return isAbsolute(entry) ? entry : join(cwd, entry);
}

export function targetFailures(entry: string, place: Place): string[] {
  const failures: string[] = [];
  const unknown = spawn(
    ["--no-install", entry, unknownWord],
    targetBoundMilliseconds,
    place,
  );
  if (
    unknown.exitCode !== 2 ||
    unknown.stdout !== "" ||
    !/\[USAGE_UNKNOWN_COMMAND\]\n$/.test(unknown.stderr)
  )
    failures.push(
      `target-usage: an unknown command exited ${String(unknown.exitCode)} with ${String(unknown.stdout.length)} bytes on stdout; it must exit 2, print nothing on stdout, and end stderr with [USAGE_UNKNOWN_COMMAND]. stderr: ${firstLine(unknown.stderr)}`,
    );
  const discovery = spawn(
    ["--no-install", entry, "--discover", "--json"],
    targetBoundMilliseconds,
    place,
  );
  const envelope = oneJsonLine(discovery.stdout);
  const claimed = fieldOf(envelope, "result", "exitCode");
  if (
    discovery.exitCode !== 0 ||
    discovery.stderr !== "" ||
    typeof fieldOf(envelope, "contractVersion") !== "string" ||
    claimed !== 0
  )
    failures.push(
      `target-discovery: --discover --json exited ${String(discovery.exitCode)}, its envelope says exit ${String(claimed)}; both must be 0, with one envelope on stdout and nothing on stderr. stderr: ${firstLine(discovery.stderr)}`,
    );
  return failures;
}

export function helperFailures(helper: Ran): string[] {
  const envelope = oneJsonLine(helper.stdout);
  const said = fieldOf(envelope, "result", "exitCode");
  if (envelope === undefined || typeof said !== "number")
    return [
      `helper-no-envelope: the helper exited ${String(helper.exitCode)} without one envelope on stdout. stderr: ${firstLine(helper.stderr)}`,
    ];
  if (said !== helper.exitCode)
    return [
      `helper-exit-mismatch: the helper's envelope says exit ${String(said)}, but its process exited ${String(helper.exitCode)}. Its message: ${String(fieldOf(envelope, "message"))}`,
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
  const message = String(fieldOf(envelope, "message"));
  if (helper.exitCode !== 0) {
    const cause = String(fieldOf(envelope, "result", "causeCode"));
    return {
      stream: "stderr",
      text: `verify-agent-cli: ${message} [${cause}]\n`,
    };
  }
  const data = fieldOf(envelope, "result", "data");
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
): Promise<{ readonly failures: readonly string[]; readonly helper: Ran }> {
  const failures = await kernelFailures();
  if (argv[0] === "doctor")
    failures.push(...targetFailures(entryOf(argv, place.cwd), place));
  const helper = spawn(
    [
      "--no-install",
      join(import.meta.dir, "helper", "cli.ts"),
      ...argv.filter((word) => word !== "--json"),
      "--json",
    ],
    helperBoundMilliseconds,
    place,
  );
  failures.push(...helperFailures(helper));
  return { failures, helper };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const { failures, helper } = await verify(argv, {
    cwd: process.cwd(),
    env: process.env,
  });
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
