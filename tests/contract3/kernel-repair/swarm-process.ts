// Runs one swarm-triage scenario as a real child process and returns what an
// agent observes: exit code, both streams and the parsed machine envelope.
const entry = new URL("swarm-cli.ts", import.meta.url).pathname;

export type Observed = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Readonly<Record<string, unknown>> | undefined;
};

function resultOf(stdout: string): Observed["result"] {
  if (stdout.trim() === "") return undefined;
  const envelope: unknown = JSON.parse(stdout);
  const result: unknown =
    typeof envelope === "object" && envelope !== null
      ? Reflect.get(envelope, "result")
      : undefined;
  return typeof result === "object" && result !== null
    ? Object.fromEntries(Object.entries(result))
    : undefined;
}

export async function runScenario(
  scenario: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
  path = entry,
): Promise<Observed> {
  const child = Bun.spawn([process.execPath, path, scenario, ...argv], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exit, stdout, stderr, result: resultOf(stdout) };
}
