import { writeFileSync } from "node:fs";
import { join } from "node:path";

const gitMilliseconds = 4_000;

export const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: "",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

// Platform: A git hook runs the suite with these set, and they would point the
// fixture's git at the caller's repository.
const gitLocation = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
]);

export function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !gitLocation.has(name)),
  );
}

export function gitResult(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not exit within ${gitMilliseconds} ms.`,
    );
  return result;
}

export function git(root: string, ...args: string[]): string {
  const result = gitResult(root, ...args);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function commitIn(
  root: string,
  subject: string,
  changes: Record<string, string | null>,
) {
  for (const [path, content] of Object.entries(changes))
    if (content === null) git(root, "rm", "--quiet", "--", path);
    else {
      writeFileSync(join(root, path), content);
      git(root, "add", "--", path);
    }
  git(root, "commit", "--quiet", "--allow-empty", "-m", subject);
  return {
    sha: git(root, "rev-parse", "HEAD"),
    short: git(root, "rev-parse", "--short", "HEAD"),
  };
}
