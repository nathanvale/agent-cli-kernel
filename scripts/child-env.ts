import { basename, delimiter, dirname } from "node:path";
import type { Subprocess } from "bun";

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

// Holds the child in `tracker` while it runs, so the caller's stop handler
// can signal it.
export async function runWithOwnTools(
  argv: readonly string[],
  cwd: string,
  tracker: { child?: Subprocess },
  { detached = false }: { readonly detached?: boolean } = {},
) {
  const child = Bun.spawn([...argv], {
    cwd,
    env: ownTools,
    stdout: "pipe",
    stderr: "pipe",
    detached,
  });
  tracker.child = child;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  delete tracker.child;
  return { exitCode, signalCode: child.signalCode, output: stdout + stderr };
}
