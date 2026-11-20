import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hooks } from "../../../scripts/doctor.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { gitEnv, gitOutput } from "../../support/git-fixture.ts";

const folder = ownedFolders();
const notRun =
  "so this checkout's pre-commit and pre-push hooks do not run. Repair: git config core.hooksPath .githooks.";

function underEnvironment<T>(
  changes: Readonly<Record<string, string>>,
  body: () => T,
): T {
  const saved = Object.fromEntries(
    Object.keys(changes).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(changes))
    process.env[name] = value;
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

function hooksOf(root: string, changes: Record<string, string> = {}) {
  return underEnvironment({ ...gitEnv, CI: "", ...changes }, () => hooks(root));
}

function checkout(hooksPath?: string): string {
  const root = folder("doctor-hooks-");
  mkdirSync(join(root, ".githooks"));
  gitOutput(root, "init", "--quiet");
  if (hooksPath !== undefined)
    gitOutput(root, "config", "core.hooksPath", hooksPath);
  return root;
}

function stubGit(script: string): Record<string, string> {
  const bin = folder("doctor-hooks-git-");
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

test("hooks passes a folder with no .githooks", () => {
  expect(hooksOf(folder("doctor-hooks-"))).toEqual({
    status: "ok",
    check: "hooks",
    detail: "no .githooks folder, so no repository hooks apply.",
  });
});

test("hooks passes a .githooks folder outside any git checkout", () => {
  const root = folder("doctor-hooks-");
  mkdirSync(join(root, ".githooks"));
  expect(hooksOf(root)).toEqual({
    status: "ok",
    check: "hooks",
    detail: "not a git checkout, so no git hooks apply.",
  });
});

test("hooks fails when core.hooksPath is not set, naming the command that sets it", () => {
  expect(hooksOf(checkout())).toEqual({
    status: "FAIL",
    check: "hooks",
    detail: `core.hooksPath is not set, ${notRun}`,
  });
});

test("hooks fails when core.hooksPath names another folder", () => {
  expect(hooksOf(checkout("elsewhere"))).toEqual({
    status: "FAIL",
    check: "hooks",
    detail: `core.hooksPath is elsewhere, ${notRun}`,
  });
});

test("hooks does not fail an unset core.hooksPath in a hosted check, which commits nothing", () => {
  expect(hooksOf(checkout(), { CI: "true" })).toEqual({
    status: "ok",
    check: "hooks",
    detail: `core.hooksPath is not set, ${notRun} A hosted check commits nothing, so it needs none.`,
  });
});

test("hooks passes when core.hooksPath runs this checkout's .githooks, written relative or absolute", () => {
  const relative = checkout(".githooks");
  const absolute = checkout();
  gitOutput(absolute, "config", "core.hooksPath", join(absolute, ".githooks"));
  for (const root of [relative, absolute])
    expect(hooksOf(root)).toEqual({
      status: "ok",
      check: "hooks",
      detail: "core.hooksPath runs this checkout's .githooks.",
    });
});

test("hooks warns, with git's exit and reason, when git config cannot be read", () => {
  const root = checkout();
  const failing = stubGit(
    'case "$3" in rev-parse) echo "$2"; exit 0;; *) echo "stub refused" >&2; exit 2;; esac',
  );
  expect(hooksOf(root, failing)).toEqual({
    status: "WARN",
    check: "hooks",
    detail:
      "git config --get core.hooksPath exited 2 (stub refused), so whether this checkout's hooks run is unknown. Repair: run git config --get core.hooksPath in the repository root to see why.",
  });
});

test("hooks stops a git that does not answer at its bound and warns", () => {
  const root = checkout();
  const started = performance.now();
  const finding = hooksOf(root, stubGit("exec sleep 10"));
  expect(performance.now() - started).toBeLessThan(6_000);
  expect(finding).toEqual({
    status: "WARN",
    check: "hooks",
    detail:
      "git did not answer within 4000 ms, so whether this checkout's hooks run is unknown. Repair: run git config --get core.hooksPath in the repository root to see why.",
  });
}, 15_000);

test("hooks warns when git cannot start, and does not throw", () => {
  const root = checkout();
  const emptyBin = folder("doctor-hooks-no-git-");
  const finding = hooksOf(root, { PATH: emptyBin });
  expect(finding.status).toBe("WARN");
  expect(finding.detail).toStartWith("git could not start (");
  expect(finding.detail).toEndWith(
    "), so whether this checkout's hooks run is unknown. Repair: run git config --get core.hooksPath in the repository root to see why.",
  );
});

test("hooks warns, with git's reason, when a checkout's configuration cannot be read", () => {
  const root = checkout();
  writeFileSync(join(root, ".git/config"), "[core\nbroken", { flag: "a" });
  const finding = hooksOf(root);
  expect(finding.status).toBe("WARN");
  expect(finding.detail).toStartWith(
    "git rev-parse --show-toplevel exited 128 (fatal: bad config line",
  );
});

test("hooks reads core.hooksPath as git does: a home-relative path expands, and a trailing space is kept", () => {
  const root = checkout();
  gitOutput(root, "config", "core.hooksPath", `~/${basename(root)}/.githooks`);
  expect(hooksOf(root, { HOME: dirname(root) })).toEqual({
    status: "ok",
    check: "hooks",
    detail: "core.hooksPath runs this checkout's .githooks.",
  });
  gitOutput(root, "config", "core.hooksPath", ".githooks ");
  expect(hooksOf(root)).toEqual({
    status: "FAIL",
    check: "hooks",
    detail: `core.hooksPath is .githooks , ${notRun}`,
  });
});
