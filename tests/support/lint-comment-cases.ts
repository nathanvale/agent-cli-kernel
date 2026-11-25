import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { templateSourceFile } from "./template-lint.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSupportedFallowTargets(): readonly string[] {
  const require = createRequire(import.meta.url);
  const parsed: unknown = JSON.parse(
    readFileSync(require.resolve("fallow/issue-registry.json"), "utf8"),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.issue_types)) {
    throw new Error("fallow/issue-registry.json missing issue_types array");
  }
  const targets = new Set<string>();
  for (const item of parsed.issue_types) {
    if (!isRecord(item) || typeof item.suppress_comment !== "string") continue;
    const match =
      /^\/\/\s*fallow-ignore-(?:next-line|file)\s+([a-z][a-z0-9-]*)$/.exec(
        item.suppress_comment,
      );
    const target = match?.[1];
    if (target === undefined) continue;
    targets.add(target);
    if (item.id === target && Array.isArray(item.aliases)) {
      for (const alias of item.aliases) {
        if (typeof alias === "string" && alias.length > 0) targets.add(alias);
      }
    }
  }
  return [...targets].sort();
}

export const supportedFallowTargets: readonly string[] =
  readSupportedFallowTargets();

export const commentCases = [
  [templateSourceFile, "// Loop over the names.\nexport const a = 1;", [1]],
  [
    templateSourceFile,
    "// A workaround until the parser is fixed:\n// it drops the last token.\nexport const a = 1;",
    [1],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "/* Narration */ export const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "/** Adds one. */\nexport const add = (n: number) => n + 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Note.\n// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [1],
  ],
  [templateSourceFile, "export const a = 1; // trailing narration", [1]],
  [
    templateSourceFile,
    "// Note.\n// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [1],
  ],
  [templateSourceFile, "// SAFETY:\nconst x = y as Foo;", [1]],
  [templateSourceFile, "// SAFETY: nothing here is cast.\nconst x = y;", [1]],
  [
    templateSourceFile,
    "// SAFETY: a const assertion needs no proof.\nconst x = y as const;",
    [1],
  ],
  [
    templateSourceFile,
    "// SAFETY: a blank line detaches this from the cast.\n\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "const a = 1; // SAFETY: trailing the previous line.\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "// SAFETY: the cast is two statements down.\nconst a = 1;\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "// platform: lower case is not the marker\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Interface: a host passes the descriptor\n// to contractFor.\nexport const a = 1;",
    [],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "// The accepted\n// decision N4a keeps the line on stdout.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "export function f(y: unknown) {\n  // SAFETY: the caller passes a Foo.\n  return y as Foo;\n}",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape.\nexport const x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape,\n// so every key is present.\nconst x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the cast sits in the second argument.\nconsole.log(1, y as Foo);",
    [],
  ],
  [
    templateSourceFile,
    'export const text = "// not a comment";\nexport const tpl = `/* nor this */`;',
    [],
  ],
] as const;
