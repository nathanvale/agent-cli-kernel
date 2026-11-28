import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapProblems,
  mappedGlossaryFiles,
} from "../../../scripts/glossary-map.ts";
import {
  ownershipProblems,
  readOwnership,
} from "../../../scripts/glossary-ownership.ts";
import {
  readRepositoryGlossary,
  recordedHitsFile,
  recordedUnusedTermsFile,
  termUseProblems,
  trackedTexts,
} from "../../../scripts/glossary.ts";
import { publicSurfaceFile } from "../../../scripts/public-surface.ts";
import { git } from "../../support/git-fixture.ts";
import {
  check,
  glossary,
  namesCheckFixture,
  put,
  thrownBy,
} from "./names-check-fixture.ts";

const { emptyRepository } = namesCheckFixture();
const fixtureGitBound = 4_000;
const namesGitBound = 10_000;
const timeoutHeadroom = 5_000;

function sequentialTimeout(fixtureCalls: number, namesCalls: number): number {
  return (
    fixtureCalls * fixtureGitBound +
    namesCalls * namesGitBound +
    timeoutHeadroom
  );
}

const stateGlossaryPath = "kernel/src/addons/state/GLOSSARY.md";
const stateGlossary = `# State add-on glossary

This file holds the words of the state add-on; \`GLOSSARY-MAP.md\` lists every glossary.

**State add-on**:
The add-on that owns the journal and the state a changing command works in.

**supersedeUnresolved**:
A changing command's promise that it is safe to run again.
_Avoid_: reclaim
`;

function mapOf(rows: readonly string[]): string {
  return [
    "# Glossary map",
    "",
    "| Glossary | Owns | Where |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function splitRepository(
  files: Record<string, string>,
  extraMapRows: readonly string[] = [],
  surfaceExports: readonly string[] = [],
): string {
  const root = emptyRepository();
  const map = mapOf([
    "| Kernel | Root words | [GLOSSARY.md](GLOSSARY.md) |",
    ...extraMapRows,
  ]);
  put(root, "GLOSSARY.md", glossary);
  put(root, "GLOSSARY-MAP.md", map);
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  put(
    root,
    publicSurfaceFile,
    JSON.stringify({
      exports: surfaceExports,
      consumedExports: [],
      importers: [],
    }),
  );
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(
    root,
    "add",
    "--",
    "GLOSSARY.md",
    "GLOSSARY-MAP.md",
    recordedHitsFile,
    publicSurfaceFile,
    ...Object.keys(files),
  );
  git(root, "commit", "--quiet", "-m", "split glossaries");
  return root;
}

test("CG.a mappedGlossaryFiles returns the linked GLOSSARY.md paths in order", () => {
  const map = mapOf([
    "| Kernel | Root words | [GLOSSARY.md](GLOSSARY.md) |",
    `| State add-on | State words | [${stateGlossaryPath}](${stateGlossaryPath}) |`,
    "| Template | Template words | [Template](https://example.test/GLOSSARY.md) |",
    "| Contract | No word. External | [Authority](docs/agents/cli-kernel.md) |",
  ]);
  expect(mappedGlossaryFiles(map)).toEqual(["GLOSSARY.md", stateGlossaryPath]);
});

test(
  "CG.b a term defined only in a context glossary counts as defined and context glossaries are not read as uses",
  () => {
    const root = splitRepository(
      {
        [stateGlossaryPath]: stateGlossary,
        "docs/notes.md":
          "A planted fault, a recorded hit and the state add-on.\n",
      },
      [
        `| State add-on | State words | [${stateGlossaryPath}](${stateGlossaryPath}) |`,
      ],
    );
    const loaded = readRepositoryGlossary(root);
    const texts = trackedTexts(root);
    expect(texts).not.toContain(stateGlossary);
    expect(termUseProblems(loaded, texts, [])).toEqual([
      `"supersedeUnresolved" appears in no tracked file outside the glossary files. Repair: use it, remove it from ${stateGlossaryPath}, or record it in ${recordedUnusedTermsFile} with the ticket that will use it.`,
    ]);
    expect(
      termUseProblems(loaded, texts, [
        {
          term: "supersedeUnresolved",
          reason: "Not used yet.",
          ticket: "MAG-1",
        },
      ]),
    ).toEqual([]);
  },
  sequentialTimeout(3, 1),
);

test(
  "CG.c an Avoid word from a context glossary is refused in a file name, in --staged mode, and on the public surface",
  async () => {
    const root = splitRepository(
      {
        [stateGlossaryPath]: stateGlossary,
        "src/public.ts": "export function reclaimState() {}\n",
      },
      [
        `| State add-on | State words | [${stateGlossaryPath}](${stateGlossaryPath}) |`,
      ],
      ["src/public.ts"],
    );
    expect(await check(root, ["docs/reclaim-notes.md"])).toEqual({
      stderr: `docs/reclaim-notes.md uses "reclaim", which ${stateGlossaryPath} lists under Avoid for "supersedeUnresolved". Repair: rename it with the glossary word.\n`,
      code: 1,
    });
    expect(await check(root, ["src/public.ts"])).toEqual({
      stderr: `src/public.ts:1 public declaration "reclaimState" breaks Avoid: uses "reclaim", which ${stateGlossaryPath} lists under Avoid for "supersedeUnresolved". Repair: rename it with the glossary word.\n`,
      code: 1,
    });
    put(
      root,
      stateGlossaryPath,
      stateGlossary.replace("_Avoid_: reclaim", "_Avoid_: force"),
    );
    put(root, "docs/force-notes.md", "notes\n");
    git(root, "add", "--", stateGlossaryPath, "docs/force-notes.md");
    put(root, stateGlossaryPath, stateGlossary);
    expect(await check(root, ["--staged"])).toEqual({
      stderr: `docs/force-notes.md uses "force", which ${stateGlossaryPath} lists under Avoid for "supersedeUnresolved". Repair: rename it with the glossary word.\n`,
      code: 1,
    });
  },
  sequentialTimeout(4, 14),
);

test(
  "CG.d a term defined in two glossaries is refused, while two entries with the same name in one glossary pass",
  async () => {
    const duplicatePath = "kernel/src/addons/state/GLOSSARY.md";
    const duplicateRoot = splitRepository(
      {
        [duplicatePath]:
          "# State add-on glossary\n\n**Planted fault**:\nDefined twice.\n",
      },
      [`| State add-on | State words | [${duplicatePath}](${duplicatePath}) |`],
    );
    const expected = `"Planted fault" is defined in both GLOSSARY.md and ${duplicatePath}. Repair: keep its definition in the one glossary that owns it.`;
    expect(
      mapProblems(
        readFileSync(join(duplicateRoot, "GLOSSARY-MAP.md"), "utf8"),
        duplicateRoot,
      ),
    ).toEqual([expected]);
    expect(await check(duplicateRoot, ["docs/notes.md"])).toEqual({
      stderr: `${expected}\n`,
      code: 2,
    });

    const diagnosticsPath = "kernel/src/addons/diagnostics/GLOSSARY.md";
    const diagnosticsRoot = splitRepository(
      {
        [diagnosticsPath]:
          "# Diagnostics add-on glossary\n\n**Diagnostics add-on**:\nFirst entry.\n\n**Diagnostics add-on**:\nSecond entry.\n",
      },
      [
        `| Diagnostics add-on | Diagnostics words | [${diagnosticsPath}](${diagnosticsPath}) |`,
      ],
    );
    expect(
      mapProblems(
        readFileSync(join(diagnosticsRoot, "GLOSSARY-MAP.md"), "utf8"),
        diagnosticsRoot,
      ),
    ).toEqual([]);
    expect(await check(diagnosticsRoot, ["docs/notes.md"])).toEqual({
      stderr: "",
      code: 0,
    });
  },
  sequentialTimeout(6, 0),
);

test(
  "CG.e a map link to a missing context glossary is refused in mapProblems, working-tree check, and --staged mode",
  async () => {
    const missingPath = "kernel/src/addons/missing/GLOSSARY.md";
    const root = splitRepository({}, [
      `| Missing add-on | Missing words | [${missingPath}](${missingPath}) |`,
    ]);
    const expected = `GLOSSARY-MAP.md points to ${missingPath}, which does not exist. Repair: correct the link, or remove its row.`;
    expect(
      mapProblems(readFileSync(join(root, "GLOSSARY-MAP.md"), "utf8"), root),
    ).toEqual([expected]);
    expect(await check(root, ["docs/notes.md"])).toEqual({
      stderr: `${expected}\n`,
      code: 2,
    });
    expect(await check(root, ["--staged"])).toEqual({
      stderr: `git has no staged ${missingPath}, so the names check cannot judge a commit by the ${missingPath} it will contain. Repair: stage it with git add ${missingPath}, then run the names check again.\n`,
      code: 2,
    });
  },
  sequentialTimeout(3, 5),
);

test("CG.f kernelEntries defined only in a context glossary pass ownership, while an undefined one is refused", () => {
  const rootGlossary = `# Root glossary

**Pin**:
A record.

### Shared tool words

**Gate**:
A required validation.
`;
  const ownership = (entries: readonly string[]) =>
    readOwnership(
      JSON.stringify({
        acceptedHandoff: "h",
        kernelEntries: entries,
        sharedSource: {
          commit: "a".repeat(40),
          exportSha256: "x",
          rewrittenHere: [],
        },
      }),
    );
  expect(
    ownershipProblems(rootGlossary, ownership(["Pin", "State add-on"]), [
      stateGlossary,
    ]),
  ).toEqual([]);
  expect(
    ownershipProblems(rootGlossary, ownership(["Pin", "Missing term"]), [
      stateGlossary,
    ]),
  ).toEqual([
    'glossary-ownership.json accepts "Missing term", and GLOSSARY.md does not define it outside the shared tool words. Repair: define it here, or remove it from kernelEntries.',
  ]);
});

test.each([
  ["leading ./", `./${stateGlossaryPath}`],
  [". segment", "kernel/./src/addons/state/GLOSSARY.md"],
  [".. segment", "kernel/src/addons/../addons/state/GLOSSARY.md"],
  ["doubled slash", "kernel/src//addons/state/GLOSSARY.md"],
  ["leading /", `/${stateGlossaryPath}`],
  ["trailing /", `${stateGlossaryPath}/`],
])(
  "CG.g a non-plain mapped glossary path (%s) is refused by mapProblems and every mapped reader",
  async (_kind, badPath) => {
    const root = splitRepository({ [stateGlossaryPath]: stateGlossary }, [
      `| State add-on | State words | [${badPath}](${badPath}) |`,
    ]);
    const map = readFileSync(join(root, "GLOSSARY-MAP.md"), "utf8");
    const expected = `GLOSSARY-MAP.md points to ${badPath}, which is not a plain repository-relative path. Repair: write the link with no leading / or ./, no trailing /, and no . or .. or empty segment.`;
    expect(mapProblems(map, root)).toEqual([expected]);
    expect(thrownBy(() => mappedGlossaryFiles(map))).toBe(expected);
    expect(thrownBy(() => readRepositoryGlossary(root))).toBe(expected);
    expect(thrownBy(() => trackedTexts(root))).toBe(expected);
    expect(await check(root, ["docs/notes.md"])).toEqual({
      stderr: `${expected}\n`,
      code: 2,
    });
    expect(await check(root, ["--staged"])).toEqual({
      stderr: `${expected}\n`,
      code: 2,
    });
  },
  sequentialTimeout(3, 4),
);
