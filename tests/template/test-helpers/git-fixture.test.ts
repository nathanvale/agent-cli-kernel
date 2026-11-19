import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git, initRepository } from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";

test("initRepository builds a sha1 repository when the caller's git defaults to sha256", () => {
  const saved = process.env.GIT_DEFAULT_HASH;
  process.env.GIT_DEFAULT_HASH = "sha256";
  const base = testFolder("git-fixture-");
  try {
    const root = join(base, "repository");
    initRepository(root);
    expect(git(root, "rev-parse", "--show-object-format")).toBe("sha1");
  } finally {
    if (saved === undefined) delete process.env.GIT_DEFAULT_HASH;
    else process.env.GIT_DEFAULT_HASH = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
