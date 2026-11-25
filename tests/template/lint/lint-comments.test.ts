import { expect, test } from "bun:test";
import { loadFallowTargets } from "../../../config/comment-directives.mjs";
import {
  commentCases,
  supportedFallowTargets,
} from "../../support/lint-comment-cases.ts";
import {
  hits,
  messages,
  templateSourceFile,
} from "../../support/template-lint.ts";

const fullCommentMessage =
  "A comment reads as permission, and the next agent builds on it. Keep a comment only when its first word is Platform: (behaviour of a runtime, operating system or tool this repository cannot change) or Interface: (a public contract the types cannot state), or when it cites an accepted decision (AGENTS.md, Authority), or when it opens with SAFETY: and a justification, on its own lines directly above the statement that holds a type cast (as T, not as const). Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.";

const withExport = (comment: string) => `${comment}\nexport const a = 1;`;

const refusedDirectiveLookalikes = [
  withExport(
    "// global state is fine here: resolution runs once.\n// TODO remove the cast once the adapter types land.",
  ),
  withExport("// global state is fine here."),
  withExport("// globals are shared here."),
  withExport("// exported from index."),
  withExport("// eslint is strict here."),
  withExport("// eslint-disable TODO smuggled prose"),
  withExport("// eslint-enable TODO smuggled prose"),
  withExport("// eslint-foo bar"),
  withExport("// eslint-disable-foo bar"),
  withExport("// @ts-foo bar"),
  withExport("// @ts-expect-errors bar"),
  withExport("// biome-ignore-foo bar"),
  withExport("// fallow-ignore-foo bar"),
  withExport("// @ts-expect-error: bad type\n// TODO remove this cast"),
  withExport("// eslint-disable-next-line no-console\n// TODO remove this"),
  withExport("// biome-ignore format: keep table aligned\n// TODO clean up"),
  withExport(
    "// fallow-ignore-next-line unused-export -- kept for api\n// TODO clean up",
  ),
  withExport("/* @ts-expect-error: bad type\n   TODO remove this */"),
  withExport(
    "/* biome-ignore format: keep table\u2028TODO remove this cast */",
  ),
  withExport(
    "/* biome-ignore format: keep table\u2029TODO remove this cast */",
  ),
  withExport("/* fallow-ignore-next-line is how you hide a finding. */"),
  withExport("// fallow-ignore-next-line is how you hide a finding."),
  withExport("// fallow-ignore unused-export"),
  withExport("// fallow-ignore-next-line unused -- kept for api"),
  withExport("/* @ts-nocheck prose */"),
  withExport("/* @ts-check prose */"),
  withExport("/* @ts-nocheck */"),
  withExport("/* @ts-check */"),
  withExport("// @ts-nocheck prose"),
  withExport("// @ts-check prose"),
  withExport("// biome-ignore format"),
  withExport("// biome-ignore prose without colon"),
  withExport("// biome-ignore-all foo: reason"),
  withExport("/* eslint-disable TODO smuggled prose */"),
  withExport("/* global state is fine here. */"),
  withExport("/* exported from index. */"),
  withExport("/* eslint is strict here. */"),
  withExport("// eslint-disable"),
  withExport("// eslint-enable"),
  withExport("// eslint no-console: off"),
  withExport("// global foo"),
  withExport("// globals foo"),
  withExport("// exported a"),
  withExport("/* globals */"),
  withExport("/* exported */"),
  "export const a = 1; /* fallow-ignore-file -- prose */",
  "/* fallow-ignore-file -- prose */ export const b = 1;",
  "export const a = 1; /* fallow-ignore-next-line unused-export -- prose */",
  "/* fallow-ignore-next-line unused-export -- prose */ export const b = 1;",
  withExport(
    "// biome-ignore lint/remove/thisCast: prose must not become permission",
  ),
  withExport("// biome-ignore lint/fakeGroup: prose"),
  withExport("// biome-ignore lint/style/fakeRule: prose"),
  withExport("// biome-ignore assist/source: prose"),
  withExport("// biome-ignore assist/source/fakeAction: prose"),
  withExport("// biome-ignore lint/style/useConst lint/style/fakeRule: prose"),
  withExport("// biome-ignore lint/style/useConst prose: reason"),
  withExport("// fallow-ignore-next-line this-is-plain-prose"),
  withExport("// fallow-ignore-file this-is-plain-prose"),
  withExport(
    "// fallow-ignore-next-line unused-exports -- plural is not accepted",
  ),
  withExport(
    "// fallow-ignore-next-line unused-optional-dependency -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line unused-optional-deps -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line boundary-coverage -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line boundary-coverage-violations -- wrong alias",
  ),
  withExport(
    "// fallow-ignore-next-line sql-injection -- must use security-sink",
  ),
  withExport(
    "// fallow-ignore-next-line high-complexity -- must use complexity",
  ),
  withExport("// fallow-ignore-next-line unused-export, fake-target -- mixed"),
  withExport("// fallow-ignore-next-line policy-violation:bad -- missing rule"),
  withExport("// fallow-ignore-next-line unused-export --"),
] as const;

const admittedDirectives = [
  withExport("// @ts-expect-error -- lock test"),
  withExport("// @ts-expect-error: lock test"),
  withExport("// @ts-ignore reason"),
  withExport("// @ts-nocheck"),
  withExport("// @ts-check"),
  withExport("// biome-ignore format: keep table"),
  withExport("// biome-ignore lint/style/useConst: keep binding mutable"),
  withExport(
    "// biome-ignore lint/style/useConst lint/suspicious/noExplicitAny: reason",
  ),
  withExport(
    "// biome-ignore lint/style/useConst(foo) lint/suspicious/noExplicitAny: reason",
  ),
  withExport("// biome-ignore assist/source/organizeImports: preserve order"),
  withExport("// fallow-ignore-next-line -- blanket reason"),
  withExport("// fallow-ignore-next-line complexity -- kept complex"),
  withExport("// fallow-ignore-file complexity -- kept complex"),
  withExport(
    "// fallow-ignore-next-line unused-export, complexity -- combined",
  ),
  withExport(
    "// fallow-ignore-next-line policy-violation:pack/rule -- scoped rule",
  ),
  withExport("// fallow-ignore-next-line unused-export -- kept for api"),
  withExport("// fallow-ignore-file unused-export -- kept for api"),
  withExport("/* fallow-ignore-file unused-export -- kept for api */"),
  withExport("  /* fallow-ignore-next-line unused-export -- kept for api */"),
  ...supportedFallowTargets.map((target) =>
    withExport(`// fallow-ignore-next-line ${target} -- supported`),
  ),
  withExport("// eslint-disable-next-line no-console"),
  withExport(
    "// eslint-disable-next-line @typescript-eslint/consistent-type-assertions",
  ),
  "export const a = 1; // eslint-disable-line no-console",
  withExport("/* eslint-disable */"),
  withExport("/* eslint-enable */"),
  withExport("/* eslint no-console: off */"),
  withExport("/* global foo */"),
  withExport("/* globals foo */"),
  withExport("/* exported a */"),
] as const;

for (const [filePath, code, lines] of commentCases)
  test(`no-comments ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = await hits("no-comments", filePath, code);
    expect(found.map(({ line }) => line)).toEqual([...lines]);
    for (const { message } of found)
      expect(message).toContain(
        "Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
      );
  });

test("no-comments refuses directive-lookalike prose and trailing lines in template files, and admits exact directives", async () => {
  expect([...loadFallowTargets()].sort()).toEqual([...supportedFallowTargets]);
  for (const code of refusedDirectiveLookalikes) {
    expect(await hits("no-comments", templateSourceFile, code)).toEqual([
      { line: 1, message: fullCommentMessage },
    ]);
  }
  for (const code of admittedDirectives) {
    expect(await hits("no-comments", templateSourceFile, code)).toEqual([]);
  }
});

const inlineDirectivePaths = [
  templateSourceFile,
  "scripts/read-file.ts",
  "tests/template/doctor/doctor.test.ts",
  "config/template-rules.mjs",
  "eslint.config.mjs",
  "kernel/src/addons/menu/index.ts",
  "tests/kernel/lint-rules.test.ts",
  "skills/verify-cli/helper/place.ts",
] as const;

const noInlineMessage = (directive: string) =>
  `'${directive}' has no effect because you have 'noInlineConfig' setting in your config.`;

const inlineDirectiveMembers = [
  ...[
    "/* eslint-disable */",
    "// eslint-disable-next-line repository/no-in-operator -- Hack: silence rule",
    "/* eslint-disable-next-line repository/no-in-operator -- Hack: silence rule */",
    "/* eslint-enable */",
    "/* eslint no-console: off */",
    "/* global x */",
    "/* globals x */",
    "/* globals */",
    "/* exported a */",
    "/* exported */",
  ].map((d) => [withExport(d), noInlineMessage(d)] as const),
  [
    "export const a = 1; // eslint-disable-line no-console",
    noInlineMessage("// eslint-disable-line no-console"),
  ],
  [
    "export const a = 1; /* eslint-disable-line no-console */",
    noInlineMessage("/* eslint-disable-line no-console */"),
  ],
] as const;

const inlineDirectiveLintBound = 60_000;

test(
  "noInlineConfig refuses every inline ESLint directive across all repository paths and keeps rules active",
  async () => {
    for (const filePath of inlineDirectivePaths) {
      for (const [code, expectedMessage] of inlineDirectiveMembers) {
        const found = (await messages(filePath, code)).filter(
          ({ ruleId }) => ruleId === null,
        );
        expect(found).toEqual([
          { ruleId: null, line: 1, message: expectedMessage },
        ]);
      }
    }
    const planted = await messages(
      "scripts/read-file.ts",
      [
        "export function errorCode(error: unknown): boolean {",
        '  if (typeof error !== "object" || error === null) return false;',
        "  // eslint-disable-next-line repository/no-in-operator -- Hack: silence rule",
        '  return "code" in error;',
        "}",
      ].join("\n"),
    );
    expect(planted.map(({ ruleId, line }) => [ruleId, line])).toEqual([
      [null, 3],
      ["repository/no-in-operator", 4],
    ]);
    expect(
      await messages(
        "scripts/read-file.ts",
        [
          "export function errorCode(error: unknown): boolean {",
          '  if (typeof error !== "object" || error === null) return false;',
          '  return Object.hasOwn(error, "code");',
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  },
  inlineDirectiveLintBound,
);
