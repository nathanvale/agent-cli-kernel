import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";

function underSha256<T>(body: () => T): T {
  const saved = process.env.GIT_DEFAULT_HASH;
  try {
    process.env.GIT_DEFAULT_HASH = "sha256";
    return body();
  } finally {
    if (saved === undefined) delete process.env.GIT_DEFAULT_HASH;
    else process.env.GIT_DEFAULT_HASH = saved;
  }
}

test("initRepository builds a sha1 repository when the caller's git defaults to sha256", () => {
  underSha256(() => {
    const base = testFolder("git-fixture-");
    try {
      const root = join(base, "repository");
      initRepository(root);
      expect(git(root, "rev-parse", "--show-object-format")).toBe("sha1");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test("the sha256 default never outlives a setup that throws", () => {
  const saved = process.env.GIT_DEFAULT_HASH;
  expect(() =>
    underSha256(() => {
      throw new Error("Planted setup failure.");
    }),
  ).toThrow("Planted setup failure.");
  expect(process.env.GIT_DEFAULT_HASH).toBe(saved);
});

function startedUnderTrace(trace: string, body: () => void): string[] {
  const saved = process.env.GIT_TRACE2_EVENT;
  try {
    process.env.GIT_TRACE2_EVENT = trace;
    body();
  } finally {
    if (saved === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = saved;
  }
  return readFileSync(trace, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line): string[] => {
      const event: unknown = JSON.parse(line);
      if (typeof event !== "object" || event === null) return [];
      const name: unknown = "event" in event ? event.event : undefined;
      const argv: unknown = "argv" in event ? event.argv : undefined;
      return (name === "start" || name === "child_start") && Array.isArray(argv)
        ? [`${String(name)}: ${argv.map(String).join(" ")}`]
        : [];
    });
}

test("a fixture commit starts no background git maintenance that could still write in a folder a test removes", () => {
  const base = testFolder("git-fixture-");
  try {
    const root = join(base, "repository");
    initRepository(root);
    const started = startedUnderTrace(join(base, "trace.json"), () => {
      commitIn(root, "one change", { "a.txt": "a\n" });
    });
    expect(started.some((line) => / commit /.test(line))).toBe(true);
    expect(started.filter((line) => /\b(maintenance|gc)\b/.test(line))).toEqual(
      [],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
