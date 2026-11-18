import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Fault,
  faultsTouchedSince,
} from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  headOf,
  limitTests,
  recorded,
  rejection,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { commit, gitOutput } from "../../support/git-fixture.ts";

const { folder, isolated, planted } = createPlantedFaultFixture();

describe("faultsTouchedSince", () => {
  const other: Fault = {
    id: "def5678-other",
    patch: "tests/planted-faults/patches/def5678-other.patch",
    testFile: "tests/limit.test.ts",
    title: "^L\\.weak ",
    source: "def5678 fix: other",
  };
  const otherPatch = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-export const other = 2;
+export const other = 1;
`;

  function twoFaults() {
    const fixture = planted();
    commit(fixture.root, "add other", {
      "src/other.ts": "export const other = 2;\n",
    });
    write(fixture.root, other.patch, otherPatch);
    recorded(fixture.root, [fixture.fault, other]);
    return { ...fixture, base: headOf(fixture.root) };
  }

  test("names only the faults whose patch touches a file changed since the base", async () => {
    const { root, id, base } = twoFaults();
    commit(root, "reword the refusal", {
      "src/limit.ts": guarded.replace("must be", "has to be"),
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose own patch changed, though no patched file did", async () => {
    const { root, base } = twoFaults();
    commit(root, "replant other", { [other.patch]: `${otherPatch}\n` });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([other.id]);
  });

  test("names no fault when the changed files are ones no patch touches", async () => {
    const { root, base } = twoFaults();
    commit(root, "notes", { "README.md": "notes\n" });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([]);
  });

  test("names a fault whose test file changed, though its patched file did not", async () => {
    const { root, id, base } = twoFaults();
    commit(root, "weaken the refusal test", {
      "tests/limit.test.ts": limitTests.replace(
        "L.refuses NaN twice",
        "L.refuses NaN again",
      ),
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id, other.id]);
  });

  test("names a fault whose patched file was renamed away", async () => {
    const { root, id, base } = twoFaults();
    gitOutput(root, "mv", "src/limit.ts", "src/bound.ts");
    gitOutput(root, "commit", "--quiet", "-m", "rename limit");
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose patched file moved before the base, when the moved file changes", async () => {
    const { root, id } = twoFaults();
    gitOutput(root, "mv", "src/limit.ts", "src/bound.ts");
    gitOutput(root, "commit", "--quiet", "-m", "rename limit");
    const base = headOf(root);
    commit(root, "reword the refusal", {
      "src/bound.ts": guarded.replace("must be", "has to be"),
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose moved anchor is ambiguous at the base when one of its places changes", async () => {
    const { root, id } = twoFaults();
    gitOutput(root, "mv", "src/limit.ts", "src/bound.ts");
    commit(root, "rename limit and copy it", { "src/copy.ts": guarded });
    const base = headOf(root);
    commit(root, "export a bound", {
      "src/bound.ts": `${guarded}export const bound = 1;\n`,
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose patch deletes a whole file when only that file changed", async () => {
    const { root } = twoFaults();
    commit(root, "delete other", {
      [other.patch]: `diff --git a/src/other.ts b/src/other.ts
deleted file mode 100644
--- a/src/other.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const other = 2;
`,
    });
    const deleting = headOf(root);
    commit(root, "change other", {
      "src/other.ts": "export const other = 3;\n",
    });
    const { result } = await isolated(() => faultsTouchedSince(root, deleting));
    expect(result).toEqual([other.id]);
  });

  test("names a fault whose record changed, though no file it names did", async () => {
    const { root, id, fault, base } = twoFaults();
    recorded(root, [{ ...fault, title: "^L\\.weak " }, other]);
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("refuses a git read that outlasts its bound, naming the read", async () => {
    const { root, base } = twoFaults();
    const tools = folder("planted-faults-slow-git-");
    writeFileSync(join(tools, "git"), "#!/bin/sh\nexec sleep 10\n", {
      mode: 0o755,
    });
    const path = process.env.PATH;
    const began = performance.now();

    const message = await rejection(
      isolated(() => {
        process.env.PATH = `${tools}:${path}`;
        try {
          return faultsTouchedSince(root, base);
        } finally {
          process.env.PATH = path;
        }
      }),
    );

    expect(message).toBe(
      `git rev-parse --verify --quiet ${base}^{commit} did not finish within 4 s. Repair: run it by hand in ${root} to see where it waits, then run this command again.`,
    );
    expect(performance.now() - began).toBeLessThan(6_000);
  }, 15_000);

  test("refuses a fault whose patch file is missing, naming the file", async () => {
    const { root, base } = twoFaults();
    rmSync(join(root, other.patch));

    const message = await rejection(
      isolated(() => faultsTouchedSince(root, base)),
    );

    expect(message).toBe(
      `${other.patch} does not exist, so ${other.id} has no planted fault to apply. Repair: plant the fault again by hand, run git diff -- <each file you edited> > '${other.patch}', then undo the planted edit. Done when bun run fault-replay ${other.id} passes.`,
    );
  });

  test("refuses a failed search for a moved anchor, naming git's words and the repair", async () => {
    const { root } = twoFaults();
    gitOutput(root, "mv", "src/limit.ts", "src/bound.ts");
    gitOutput(root, "commit", "--quiet", "-m", "rename limit");
    const base = headOf(root);
    const real = Bun.which("git");
    if (real === null) throw new Error("No git on PATH.");
    const tools = folder("planted-faults-failing-grep-");
    writeFileSync(
      join(tools, "git"),
      `#!/bin/sh\nif [ "$1" = grep ]; then echo "fatal: planted grep failure" >&2; exit 128; fi\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;

    const message = await rejection(
      isolated(() => {
        process.env.PATH = `${tools}:${path}`;
        try {
          return faultsTouchedSince(root, base);
        } finally {
          process.env.PATH = path;
        }
      }),
    );

    const anchor = guarded.split("\n")[1] ?? "";
    expect(message).toBe(
      `git grep -l -F -e '${anchor}' ${base} failed: fatal: planted grep failure. Repair: run it by hand in ${root} to see why, then run this command again.`,
    );
  });

  test("refuses a base git cannot resolve, naming it", async () => {
    const { root } = twoFaults();
    expect(
      await rejection(isolated(() => faultsTouchedSince(root, "no-such-base"))),
    ).toBe(
      "no-such-base is not a commit in this repository. Repair: pass a commit or branch, such as origin/main.",
    );
  });
});
