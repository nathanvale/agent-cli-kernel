export const commentCases = [
  [
    "src/static-admission.ts",
    "// Loop over the names.\nexport const a = 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// A workaround until the parser is fixed:\n// it drops the last token.\nexport const a = 1;",
    [1],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "/* Narration */ export const a = 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "/** Adds one. */\nexport const add = (n: number) => n + 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// Note.\n// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [1],
  ],
  ["src/static-admission.ts", "export const a = 1; // trailing narration", [1]],
  [
    "src/static-admission.ts",
    "// Note.\n// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [1],
  ],
  ["src/static-admission.ts", "// SAFETY:\nconst x = y as Foo;", [1]],
  [
    "src/static-admission.ts",
    "// SAFETY: nothing here is cast.\nconst x = y;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: a const assertion needs no proof.\nconst x = y as const;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: a blank line detaches this from the cast.\n\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "const a = 1; // SAFETY: trailing the previous line.\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the cast is two statements down.\nconst a = 1;\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// platform: lower case is not the marker\nexport const a = 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// Interface: a host passes the descriptor\n// to contractFor.\nexport const a = 1;",
    [],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "// The accepted\n// decision N4a keeps the line on stdout.\nexport const a = 1;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "export function f(y: unknown) {\n  // SAFETY: the caller passes a Foo.\n  return y as Foo;\n}",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape.\nexport const x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape,\n// so every key is present.\nconst x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the cast sits in the second argument.\nconsole.log(1, y as Foo);",
    [],
  ],
  [
    "src/static-admission.ts",
    'export const text = "// not a comment";\nexport const tpl = `/* nor this */`;',
    [],
  ],
] as const;
