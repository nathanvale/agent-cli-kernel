import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git, initRepository } from "../../support/git-fixture.ts";
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
