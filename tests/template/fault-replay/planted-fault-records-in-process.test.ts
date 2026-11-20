import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  add,
  type Fault,
  readRecords,
  recordFile,
  recordsPath,
} from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  limitTests,
  rejection,
  sample,
  unguarded,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { gitOutput, commit } from "../../support/git-fixture.ts";

const { folder, isolated, repository } = createPlantedFaultFixture();

describe("readRecords", () => {
  function recordsIn(
    files: Readonly<Record<string, string>>,
    tests: string[] = [],
  ): string {
    const root = folder("planted-faults-records-");
    for (const file of tests) write(root, file, "");
    for (const [path, content] of Object.entries(files))
      write(root, path, content);
    return root;
  }

  const text = (record: unknown) => JSON.stringify(record);
  const sampleFile = recordFile(sample.id);

  test("gives no records when the records folder is absent", () => {
    expect(readRecords(recordsIn({}))).toEqual([]);
  });

  test("reads every record file in the folder, in id order, with every field", () => {
    const longer: Fault = { ...sample, id: `${sample.id}-longer` };
    const other: Fault = { ...sample, id: "000aaaa-other" };
    const root = recordsIn(
      {
        [recordFile(longer.id)]: text(longer),
        [sampleFile]: text(sample),
        [recordFile(other.id)]: text(other),
      },
      ["tests/limit.test.ts"],
    );

    expect(readRecords(root)).toEqual([other, sample, longer]);
  });

  test("reads a record file added beside the others, with no list to update", () => {
    const root = recordsIn({ [sampleFile]: text(sample) }, [
      "tests/limit.test.ts",
    ]);
    const added: Fault = { ...sample, id: "def5678-added" };
    write(root, recordFile(added.id), text(added));

    expect(readRecords(root).map(({ id }) => id)).toEqual([
      sample.id,
      added.id,
    ]);
  });

  test("keeps only the five named fields of a record", () => {
    const root = recordsIn({ [sampleFile]: text({ ...sample, extra: "x" }) }, [
      "tests/limit.test.ts",
    ]);

    expect(readRecords(root)).toEqual([sample]);
  });

  test("skips the macOS .DS_Store file in the records folder", () => {
    const root = recordsIn(
      { [sampleFile]: text(sample), [`${recordsPath}/.DS_Store`]: "x" },
      ["tests/limit.test.ts"],
    );

    expect(readRecords(root)).toEqual([sample]);
  });

  test("refuses any other dot-named file in the records folder, naming it", () => {
    const hidden: Fault = { ...sample, id: "def5678-hidden" };
    const root = recordsIn(
      {
        [sampleFile]: text(sample),
        [`${recordsPath}/.${hidden.id}.json`]: text(hidden),
      },
      ["tests/limit.test.ts"],
    );

    expect(() => readRecords(root)).toThrow(
      `${recordsPath}/.def5678-hidden.json is not a fault record file. Repair: keep each fault record as a plain file named <id>.json, with no leading dot, and nothing else in ${recordsPath}.`,
    );
  });

  test("refuses a folder in the records folder named like a record, naming it", () => {
    const root = recordsIn(
      {
        [sampleFile]: text(sample),
        [`${recordsPath}/def5678-folder.json/inner.json`]: text(sample),
      },
      ["tests/limit.test.ts"],
    );

    expect(() => readRecords(root)).toThrow(
      `${recordsPath}/def5678-folder.json is not a fault record file. Repair: keep each fault record as a plain file named <id>.json, with no leading dot, and nothing else in ${recordsPath}.`,
    );
  });

  test("refuses the old single list of records, beside the folder or alone, naming it", () => {
    const repair =
      "tests/planted-faults/fault-records.json is the old single list of each fault record, which nothing reads any more. Repair: move each entry in it to its own file, tests/planted-faults/fault-records/<id>.json, then delete tests/planted-faults/fault-records.json.";
    const beside = recordsIn(
      {
        [sampleFile]: text(sample),
        "tests/planted-faults/fault-records.json": text([sample]),
      },
      ["tests/limit.test.ts"],
    );
    const alone = recordsIn({
      "tests/planted-faults/fault-records.json": text([sample]),
    });

    expect(() => readRecords(beside)).toThrow(repair);
    expect(() => readRecords(alone)).toThrow(repair);
  });

  test("refuses a file in the records folder that is not a .json record, naming it", () => {
    const root = recordsIn(
      {
        [sampleFile]: text(sample),
        [`${recordsPath}/notes.txt`]: text({ ...sample, id: "notes" }),
      },
      ["tests/limit.test.ts"],
    );

    expect(() => readRecords(root)).toThrow(
      `${recordsPath}/notes.txt is not a fault record file. Repair: keep each fault record as a plain file named <id>.json, with no leading dot, and nothing else in ${recordsPath}.`,
    );
  });

  test("refuses a record file that is not JSON, naming the file", () => {
    const root = recordsIn({ [sampleFile]: "not json" });
    const parserSays = (() => {
      try {
        JSON.parse("not json");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("JSON.parse accepted 'not json'.");
    })();

    expect(() => readRecords(root)).toThrow(
      `${sampleFile} is not one JSON fault record: ${parserSays}. Repair: write one JSON object with the five record fields.`,
    );
  });

  test("refuses a record whose id is not its file name, naming both", () => {
    const root = recordsIn({ [recordFile("other")]: text(sample) }, [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${recordFile("other")} holds the record abc1234-limit. Repair: rename the file abc1234-limit.json, or correct its id.`,
    );
  });

  test.each([
    ["id", "name it <fix short sha>-<source file name>."],
    [
      "patch",
      "name the planted fault's patch under tests/planted-faults/patches.",
    ],
    ["testFile", "name a test file relative to the repository root."],
    [
      "title",
      "name the bun test -t pattern that selects the test that kills the planted fault.",
    ],
    ["source", "name it <fix short sha> <fix subject>."],
  ])("refuses a record with no %s and gives its repair", (field, repair) => {
    const record: Record<string, string> = { ...sample };
    delete record[field];
    const root = recordsIn({ [sampleFile]: text(record) }, [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${sampleFile} needs a non-empty string ${field}. Repair: ${repair}`,
    );
  });

  test("refuses a record whose field is empty or not text", () => {
    const empty = recordsIn({ [sampleFile]: text({ ...sample, title: "" }) }, [
      "tests/limit.test.ts",
    ]);
    const number = recordsIn({ [sampleFile]: text({ ...sample, patch: 3 }) }, [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(empty)).toThrow(
      `${sampleFile} needs a non-empty string title. Repair: name the bun test -t pattern that selects the test that kills the planted fault.`,
    );
    expect(() => readRecords(number)).toThrow(
      `${sampleFile} needs a non-empty string patch. Repair: name the planted fault's patch under tests/planted-faults/patches.`,
    );
  });

  test.each([
    ["null", "null"],
    ["a string", '"abc"'],
    ["a number", "7"],
    ["a list", "[]"],
  ])("refuses a record that is %s", (_name, entry) => {
    const root = recordsIn({ [sampleFile]: entry });

    expect(() => readRecords(root)).toThrow(
      `${sampleFile} needs a non-empty string id. Repair: name it <fix short sha>-<source file name>.`,
    );
  });

  test("refuses a record whose test file does not exist", () => {
    const root = recordsIn({ [sampleFile]: text(sample) });

    expect(() => readRecords(root)).toThrow(
      `${sampleFile} names testFile tests/limit.test.ts, which does not exist. Repair: name a test file relative to the repository root.`,
    );
  });

  test("reads the folder under the root it is given, not another", () => {
    const left = recordsIn({ [sampleFile]: text(sample) }, [
      "tests/limit.test.ts",
    ]);
    const right = recordsIn({});

    expect(readRecords(left)).toEqual([sample]);
    expect(readRecords(right)).toEqual([]);
  });
});

describe("add", () => {
  function fixed() {
    const root = repository("planted-faults-add-");
    commit(root, "base", {
      "src/limit.ts": unguarded,
      "src/other.ts": "a\n",
      "src/untouched.ts": "a\n",
    });
    const fix = commit(root, "fix: refuse a NaN limit", {
      "src/limit.ts": guarded,
      "src/other.ts": "b\n",
      "tests/limit.test.ts": limitTests,
    });
    const full = gitOutput(root, "rev-parse", "HEAD").trim();
    return { root, fix, full };
  }

  async function added(root: string, args: readonly string[]) {
    return isolated(() => add(root, args));
  }

  function savedRecords(root: string): Fault[] {
    return readRecords(root);
  }

  const args = (fix: string) => [
    fix,
    "src/limit.ts",
    "tests/limit.test.ts",
    "^L\\.refuses ",
  ];

  test("stores the fix's reverse hunk and a record file naming it", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, args(fix));

    const id = `${fix}-limit`;
    const record = {
      id,
      patch: `tests/planted-faults/patches/${id}.patch`,
      testFile: "tests/limit.test.ts",
      title: "^L\\.refuses ",
      source: `${fix} fix: refuse a NaN limit`,
    };
    expect(run.result).toBe(0);
    expect(run.stdout).toBe(
      `Added ${id}. Replay it: bun run fault-replay ${id}\n`,
    );
    expect(run.stderr).toBe("");
    expect(savedRecords(root)).toEqual([record]);
    expect(
      readFileSync(
        join(root, `tests/planted-faults/patches/${id}.patch`),
        "utf8",
      ),
    ).toBe(gitOutput(root, "diff", full, `${full}^`, "--", "src/limit.ts"));
    expect(readFileSync(join(root, recordFile(id)), "utf8")).toBe(
      `${JSON.stringify(record, null, 2)}\n`,
    );
    expect(run.leftovers).toEqual([]);
  });

  test("the stored patch applies to the fixed tree and removes the fix", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));

    gitOutput(
      root,
      "apply",
      join(root, `tests/planted-faults/patches/${fix}-limit.patch`),
    );

    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(unguarded);
  });

  test("accepts a full sha and records the short one", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, [full, ...args(fix).slice(1)]);

    expect(run.result).toBe(0);
    expect(run.stdout).toStartWith(`Added ${fix}-limit.`);
    expect(savedRecords(root)[0]?.source).toBe(
      `${fix} fix: refuse a NaN limit`,
    );
  });

  test("adds a record file beside the records already there, leaving them as they were", async () => {
    const { root, fix } = fixed();
    const first = await added(root, args(fix));
    expect(first.result).toBe(0);
    const firstRecord = readFileSync(
      join(root, recordFile(`${fix}-limit`)),
      "utf8",
    );

    const second = await added(root, [
      fix,
      "src/other.ts",
      "tests/limit.test.ts",
      "x",
    ]);

    expect(second.result).toBe(0);
    expect(savedRecords(root).map(({ id, title }) => [id, title])).toEqual([
      [`${fix}-limit`, "^L\\.refuses "],
      [`${fix}-other`, "x"],
    ]);
    expect(readFileSync(join(root, recordFile(`${fix}-limit`)), "utf8")).toBe(
      firstRecord,
    );
  });

  test("names the id after the source file without its extension", async () => {
    const root = repository("planted-faults-add-name-");
    commit(root, "base", { Makefile: "a\n", "src/x.tar.gz": "a\n" });
    commit(root, "fix: both", { Makefile: "b\n", "src/x.tar.gz": "b\n" });
    write(root, "t.test.ts", "");
    const short = gitOutput(root, "rev-parse", "--short", "HEAD").trim();

    const plain = await added(root, [short, "Makefile", "t.test.ts", "t"]);
    const dotted = await added(root, [short, "src/x.tar.gz", "t.test.ts", "t"]);

    expect(plain.result).toBe(0);
    expect(dotted.result).toBe(0);
    expect(savedRecords(root).map(({ id }) => id)).toEqual([
      `${short}-Makefile`,
      `${short}-x.tar`,
    ]);
  });

  test("refuses an id already recorded and leaves the files as they were", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));
    const recordPath = join(root, recordFile(`${fix}-limit`));
    const record = readFileSync(recordPath, "utf8");
    const patchPath = join(
      root,
      `tests/planted-faults/patches/${fix}-limit.patch`,
    );
    writeFileSync(patchPath, "edited by hand\n");

    const run = await added(root, [
      fix,
      "src/limit.ts",
      "tests/limit.test.ts",
      "^another title ",
    ]);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${recordsPath} already holds ${fix}-limit. Repair: plant it again by hand, run git diff -- 'src/limit.ts' > 'tests/planted-faults/patches/${fix}-limit.patch', then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    expect(readFileSync(recordPath, "utf8")).toBe(record);
    expect(readdirSync(join(root, recordsPath))).toEqual([`${fix}-limit.json`]);
    expect(readFileSync(patchPath, "utf8")).toBe("edited by hand\n");
  });

  test("refuses an id that differs from a recorded one only by letter case, and writes nothing", async () => {
    const root = repository("planted-faults-add-case-");
    commit(root, "base", { "src/limit.ts": "a\n", "lib/Limit.ts": "a\n" });
    commit(root, "fix: both limits", {
      "src/limit.ts": "b\n",
      "lib/Limit.ts": "b\n",
      "tests/limit.test.ts": limitTests,
    });
    const short = gitOutput(root, "rev-parse", "--short", "HEAD").trim();
    const first = await added(root, [
      short,
      "src/limit.ts",
      "tests/limit.test.ts",
      "^L ",
    ]);
    expect(first.result).toBe(0);
    const record = readFileSync(
      join(root, recordFile(`${short}-limit`)),
      "utf8",
    );

    const run = await added(root, [
      short,
      "lib/Limit.ts",
      "tests/limit.test.ts",
      "^L ",
    ]);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${recordsPath} already holds ${short}-limit, which differs from ${short}-Limit only by letter case, and a macOS folder holds one file for both. Repair: add the new record by hand under an id that differs by more than case.\n`,
    );
    expect(readdirSync(join(root, recordsPath))).toEqual([
      `${short}-limit.json`,
    ]);
    expect(readFileSync(join(root, recordFile(`${short}-limit`)), "utf8")).toBe(
      record,
    );
    expect(readdirSync(join(root, "tests/planted-faults/patches"))).toEqual([
      `${short}-limit.patch`,
    ]);
  });

  test("refuses a patch that already exists with no record, keeping it and writing no record", async () => {
    const { root, fix } = fixed();
    const patch = `tests/planted-faults/patches/${fix}-limit.patch`;
    write(root, patch, "kept\n");

    const run = await added(root, args(fix));

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${patch} already exists, and no record names it. Repair: delete or rename that patch if nothing uses it, then run this command again.\n`,
    );
    expect(readFileSync(join(root, patch), "utf8")).toBe("kept\n");
    expect(readdirSync(join(root, recordsPath))).toEqual([]);
  });

  test.each([
    ["the fix sha", 0],
    ["the source path", 1],
    ["the test file", 2],
    ["the title", 3],
  ])("exits 2 with usage when %s is missing", async (_name, missing) => {
    const { root, fix } = fixed();
    const given = args(fix).slice(0, missing);

    const run = await added(root, given);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "Usage: bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
  });

  test("exits 2 and names the short sha when the fix leaves the source path alone", async () => {
    const { root, fix } = fixed();

    const run = await added(root, [
      fix,
      "src/untouched.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(run.result).toBe(2);
    expect(run.stderr).toBe(
      `${fix} does not change src/untouched.ts. Repair: pass a path that git diff --name-only ${fix}^ ${fix} lists.\n`,
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("refuses a sha that is no commit, in git's words", async () => {
    const { root } = fixed();

    const run = added(root, [
      "nope",
      "src/limit.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toStartWith(
      "git rev-parse --verify nope^{commit}:",
    );
  });

  test("refuses a test file that does not exist and writes nothing", async () => {
    const { root, fix } = fixed();

    const run = added(root, [
      fix,
      "src/limit.ts",
      "tests/missing.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toBe(
      "planted-fault:add names testFile tests/missing.test.ts, which does not exist. Repair: name a test file relative to the repository root.",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("works in the repository it is given, not the working directory's", async () => {
    const { root, fix } = fixed();
    const elsewhere = repository("planted-faults-add-elsewhere-");
    commit(elsewhere, "base", { "src/limit.ts": "x\n" });

    const run = await added(root, args(fix));

    expect(run.result).toBe(0);
    expect(existsSync(join(elsewhere, recordsPath))).toBe(false);
    expect(readdirSync(join(root, "tests/planted-faults")).sort()).toEqual([
      "fault-records",
      "patches",
    ]);
  });
});
