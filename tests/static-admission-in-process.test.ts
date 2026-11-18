import { test, expect } from "bun:test";
import {
  parseOptions,
  compare,
  jsonFile,
  inventory,
  run,
} from "../src/static-admission.ts";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import {
  causeOf,
  createAdmissionFolder,
  grow,
  environment,
  fields,
} from "./support/static-admission-in-process-fixture.ts";

const folder = createAdmissionFolder();

const usage =
  "Usage: bun run admit:static <repository> <simple|complex> <evidence folder>";

test("parseOptions resolves the three paths and keeps the environment it was given", () => {
  const env = { MARKER: "kept" };
  const options = parseOptions(["repo", "complex", "out/evidence"], env);
  expect(options).toEqual({
    project: resolve("repo"),
    profile: "complex",
    evidence: resolve("out/evidence"),
    env,
    childMilliseconds: 120_000,
  });
  expect(options.env).toBe(env);
  expect(parseOptions(["repo", "simple", "e"], env).profile).toBe("simple");
});

test("parseOptions refuses a missing project, profile or evidence folder with the usage line", async () => {
  for (const argv of [
    [],
    ["repo"],
    ["repo", "simple"],
    ["", "simple", "evidence"],
    ["repo", "simple", ""],
  ]) {
    expect(await causeOf(() => parseOptions(argv, {}))).toBe("usage");
  }
  expect(() => parseOptions(["repo"], {})).toThrow(usage);
});

test("parseOptions refuses an extra argument and an unknown profile", async () => {
  expect(await causeOf(() => parseOptions(["r", "simple", "e", "x"], {}))).toBe(
    "usage",
  );
  expect(await causeOf(() => parseOptions(["r", "medium", "e"], {}))).toBe(
    "usage:profile",
  );
  expect(await causeOf(() => parseOptions(["r", "", "e"], {}))).toBe(
    "usage:profile",
  );
  expect(() => parseOptions(["r", "medium", "e"], {})).toThrow(usage);
});

test("compare accepts equal scalars, arrays and nested documents", () => {
  expect(() => compare(1, 1, "p")).not.toThrow();
  expect(() => compare("a", "a", "p")).not.toThrow();
  expect(() => compare(null, null, "p")).not.toThrow();
  expect(() => compare([1, { a: 2 }], [1, { a: 2 }], "p")).not.toThrow();
  expect(() =>
    compare({ a: { b: [1] }, c: true }, { c: true, a: { b: [1] } }, "p"),
  ).not.toThrow();
});

test("compare names the path of a scalar, array or null difference", async () => {
  expect(await causeOf(() => compare(1, 2, "p"))).toBe("p");
  expect(await causeOf(() => compare("1", 1, "p"))).toBe("p");
  expect(await causeOf(() => compare([1, 2], [2, 1], "p"))).toBe("p");
  expect(await causeOf(() => compare([], {}, "p"))).toBe("p");
  expect(await causeOf(() => compare({}, null, "p"))).toBe("p");
  expect(await causeOf(() => compare(undefined, {}, "p"))).toBe("p");
});

test("compare refuses a document where the other side has a list", async () => {
  expect(await causeOf(() => compare([], { a: 1 }, "p"))).toBe("p");
  expect(await causeOf(() => compare({ a: 1 }, [], "p"))).toBe("p");
});

test("compare names the nested path of a missing, extra or changed key", async () => {
  expect(await causeOf(() => compare({}, { a: { b: 1 } }, "p"))).toBe("p.a");
  expect(await causeOf(() => compare({ a: {} }, { a: { b: 1 } }, "p"))).toBe(
    "p.a.b",
  );
  expect(await causeOf(() => compare({ a: { b: 1 } }, { a: {} }, "p"))).toBe(
    "p.a.b",
  );
  expect(
    await causeOf(() => compare({ a: { b: 2 } }, { a: { b: 1 } }, "p")),
  ).toBe("p.a.b");
});

test("compare reports the first difference in sorted key order", async () => {
  expect(
    await causeOf(() => compare({ a: 1, b: 2 }, { b: 1, a: 2 }, "p")),
  ).toBe("p.a");
  expect(
    await causeOf(() => compare({ z: 1, y: 1 }, { a: 1, z: 1, y: 1 }, "p")),
  ).toBe("p.a");
  expect(await causeOf(() => compare({ b: 1, a: 1 }, {}, "p"))).toBe("p.a");
});

test("jsonFile reads comments and trailing commas as a document", async () => {
  const root = folder();
  grow(root, { "a.json": '// note\n{ "a": [1, 2,], }\n' });
  expect(await jsonFile(join(root, "a.json"))).toEqual({ a: [1, 2] });
});

test("jsonFile refuses a missing file by name and a non-document by path", async () => {
  const root = folder();
  grow(root, { "list.json": "[]", "number.json": "5", "null.json": "null" });
  expect(await causeOf(() => jsonFile(join(root, "gone.json")))).toBe(
    "file:missing:gone.json",
  );
  for (const name of ["list.json", "number.json", "null.json"])
    expect(await causeOf(() => jsonFile(join(root, name)))).toBe(
      `json:${join(root, name)}`,
    );
});

test("jsonFile passes on a read error that is not a missing file", async () => {
  const root = folder();
  mkdirSync(join(root, "directory.json"));
  const cause = await causeOf(() => jsonFile(join(root, "directory.json")));
  expect(cause).toBeInstanceOf(Error);
  expect(cause).toHaveProperty("code", "EISDIR");
});

test("jsonFile passes on a parse error", async () => {
  const root = folder();
  grow(root, { "broken.json": "{ not json" });
  expect(
    await causeOf(() => jsonFile(join(root, "broken.json"))),
  ).toBeInstanceOf(SyntaxError);
});

test("inventory digests every file in sorted order and skips tool folders", async () => {
  const root = folder();
  grow(root, {
    "b.txt": "hello",
    "a/z.txt": "z",
    "a.txt": "a",
    "deep/er/file.txt": "x",
    ".git/config": "ignored",
    "node_modules/pkg/index.js": "ignored",
    ".fallow/cache": "ignored",
    "deep/.fallow/cache": "ignored",
    "deep/node_modules/pkg": "ignored",
  });
  mkdirSync(join(root, "empty"));
  const files = await inventory(root);
  expect(Object.keys(files)).toEqual([
    "a.txt",
    "a/z.txt",
    "b.txt",
    "deep/er/file.txt",
  ]);
  expect(files["b.txt"]).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("inventory lists nested files in one sorted order", async () => {
  const root = folder();
  const names = Array.from(
    { length: 12 },
    (_, index) => `d${index % 4}/f${index}.txt`,
  ).sort();
  grow(
    root,
    Object.fromEntries([...names].reverse().map((name) => [name, name])),
  );
  expect(Object.keys(await inventory(root))).toEqual(names);
});

test("inventory sees a content change and an added file", async () => {
  const root = folder();
  grow(root, { "a.txt": "one" });
  const before = await inventory(root);
  writeFileSync(join(root, "a.txt"), "two");
  grow(root, { "b.txt": "x" });
  const after = await inventory(root);
  expect(after["a.txt"]).not.toBe(before["a.txt"]);
  expect(Object.keys(after)).toEqual(["a.txt", "b.txt"]);
});

test("inventory refuses a symbolic link and names its relative path", async () => {
  const root = folder();
  grow(root, { "a/real.txt": "x" });
  symlinkSync(join(root, "a/real.txt"), join(root, "a/link.txt"));
  expect(await causeOf(() => inventory(root))).toBe("scope:symlink:a/link.txt");
});

test("inventory ignores a symbolic link inside a skipped folder", async () => {
  const root = folder();
  grow(root, { "a.txt": "x", "node_modules/real": "y" });
  symlinkSync(join(root, "a.txt"), join(root, "node_modules/link"));
  expect(Object.keys(await inventory(root))).toEqual(["a.txt"]);
});

test("run prints a refusal with the usage line and exits one when the arguments are wrong", async () => {
  const result = await run(["only-one"], environment());
  expect(result.exitCode).toBe(1);
  expect(result.output.endsWith("\n")).toBe(true);
  expect(JSON.parse(result.output)).toEqual({
    status: "refused",
    cause: "usage",
    detail: usage,
  });
  const profile = await run(["a", "huge", "b"], environment());
  expect(profile.exitCode).toBe(1);
  expect(JSON.parse(profile.output)).toEqual({
    status: "refused",
    cause: "usage:profile",
    detail: usage,
  });
});

test("run refuses a project without a package.json after it records the inventory", async () => {
  const project = folder();
  grow(project, { "a.txt": "hello" });
  const evidence = join(folder(), "evidence/nested");
  const result = await run([project, "simple", evidence], environment());
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.output)).toEqual({
    status: "refused",
    cause: "file:missing:package.json",
    detail: "file:missing:package.json",
  });
  expect(
    JSON.parse(readFileSync(join(evidence, "before.json"), "utf8")),
  ).toEqual({
    "a.txt": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
  expect(readFileSync(join(evidence, "before.json"), "utf8")).toEndWith("}\n");
});

test("run refuses a symbolic link in the project before it reads any policy", async () => {
  const project = folder();
  grow(project, { "a.txt": "x" });
  symlinkSync(join(project, "a.txt"), join(project, "link.txt"));
  const result = await run(
    [project, "simple", join(folder(), "evidence")],
    environment(),
  );
  expect(JSON.parse(result.output)).toMatchObject({
    status: "refused",
    cause: "scope:symlink:link.txt",
  });
});

test("run reports an unexpected failure as an admission error with its message", async () => {
  const missing = join(folder(), "not-there");
  const result = await run(
    [missing, "simple", join(folder(), "evidence")],
    environment(),
  );
  expect(result.exitCode).toBe(1);
  const printed = fields(JSON.parse(result.output));
  expect(printed).toMatchObject({
    status: "refused",
    cause: "admission:error",
  });
  expect(printed.detail).toContain("ENOENT");
});
