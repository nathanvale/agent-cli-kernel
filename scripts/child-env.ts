import { basename, delimiter, dirname } from "node:path";

// `bun run` prepends the caller's node_modules/.bin folders to PATH. Drop
// them so a child process sees only what its own tree installs.
const ownTools = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(delimiter)
    .filter(
      (entry) =>
        basename(entry) !== ".bin" ||
        basename(dirname(entry)) !== "node_modules",
    )
    .join(delimiter),
};

const graceMilliseconds = 2_000;
// The child's group has no live process to signal. ESRCH: every member is
// reaped. EPERM: macOS answers it when every member left is a zombie.
const groupGone = new Set<unknown>(["ESRCH", "EPERM"]);

export async function runWithOwnTools(
  argv: readonly string[],
  cwd: string,
  tracker: { stop?: () => void },
  { limitMilliseconds }: { readonly limitMilliseconds?: number } = {},
) {
  const child = Bun.spawn([...argv], {
    cwd,
    env: ownTools,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const send = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!groupGone.has(Reflect.get(Object(error), "code"))) throw error;
    }
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (escalation !== undefined) return;
    send("SIGTERM");
    escalation = setTimeout(() => send("SIGKILL"), graceMilliseconds);
  };
  let timedOut = false;
  const limit =
    limitMilliseconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stop();
        }, limitMilliseconds);
  tracker.stop = stop;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (escalation !== undefined) send("SIGKILL");
    return {
      exitCode,
      signalCode: child.signalCode,
      timedOut,
      output: stdout + stderr,
    };
  } finally {
    clearTimeout(limit);
    clearTimeout(escalation);
    delete tracker.stop;
  }
}
