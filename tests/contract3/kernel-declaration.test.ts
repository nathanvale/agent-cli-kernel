import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repository = join(import.meta.dir, "../..");
const kernelSource = join(repository, "starters/contract3");
const lintFolder = join(kernelSource, "config/kernel");

function json(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key))
    throw new Error(`Missing ${key}.`);
  const found: unknown = Reflect.get(value, key);
  return found;
}

function entries(value: unknown, where: string): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} is not an object.`);
  return Object.keys(value).map((key) => [key, field(value, key)]);
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not a list.`);
  return value.map((item: unknown) => {
    if (typeof item !== "string")
      throw new Error(`${where} holds ${JSON.stringify(item)}.`);
    return item;
  });
}

function versions(value: unknown, where: string): [string, string][] {
  return entries(value, where).map(([name, version]) => {
    if (typeof version !== "string")
      throw new Error(`${where}.${name} is not a version.`);
    return [name, version];
  });
}

type Owner = {
  name: string;
  roots: string[];
  requires: string[];
  packages: [string, string][];
  deadCodeEntries: string[];
};

function readDeclaration(): Owner[] {
  const declaration = json(join(lintFolder, "kernel-declaration.json"));
  expect(field(declaration, "schemaVersion")).toBe(2);
  const base = field(declaration, "base");
  return [
    {
      name: "base",
      roots: strings(field(base, "roots"), "base.roots"),
      requires: [],
      packages: versions(field(base, "packages"), "base.packages"),
      deadCodeEntries: strings(
        field(base, "deadCodeEntries"),
        "base.deadCodeEntries",
      ),
    },
    ...entries(field(declaration, "addons"), "addons").map(([name, addon]) => {
      const root = field(addon, "root");
      if (typeof root !== "string")
        throw new Error(`${name}.root is not a path.`);
      return {
        name,
        roots: [root],
        requires: strings(field(addon, "requires"), `${name}.requires`),
        packages: versions(field(addon, "packages"), `${name}.packages`),
        deadCodeEntries: strings(
          field(addon, "deadCodeEntries"),
          `${name}.deadCodeEntries`,
        ),
      };
    }),
  ];
}

function files(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const sorted = (values: readonly string[]) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("kernel-declaration.json, the kernel's statement of its stamp roots and add-on requirements", () => {
  const owners = readDeclaration();
  const addons = owners.filter(({ name }) => name !== "base");

  test("the declared packages, base and every add-on together, equal package.json dependencies, each declared once", () => {
    const declared = owners.flatMap(({ packages }) => packages);
    expect(sorted(declared.map(([name]) => name))).toEqual(
      sorted([...new Set(declared.map(([name]) => name))]),
    );
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(
        versions(
          field(json(join(repository, "package.json")), "dependencies"),
          "package.json dependencies",
        ),
      ),
    );
  });

  test("every declared root is a folder under the kernel source, no root holds another, and every add-on folder is declared", () => {
    const roots = owners.flatMap(({ roots }) => roots);
    for (const root of roots)
      expect(statSync(join(kernelSource, root)).isDirectory()).toBe(true);
    for (const outer of roots)
      for (const inner of roots)
        if (outer !== inner) expect(inner.startsWith(`${outer}/`)).toBe(false);
    expect(sorted(addons.flatMap(({ roots }) => roots))).toEqual(
      sorted(
        readdirSync(join(kernelSource, "src/addons")).map(
          (name) => `src/addons/${name}`,
        ),
      ),
    );
  });

  test("every dead-code entry sits in its owner's root, and together they equal the .fallowrc.json entries under the kernel source", () => {
    for (const { roots, deadCodeEntries } of owners)
      for (const entry of deadCodeEntries)
        expect(roots.some((root) => entry.startsWith(`${root}/`))).toBe(true);
    const prefix = `${relative(repository, kernelSource)}/`;
    expect(
      sorted(
        owners.flatMap(({ deadCodeEntries }) =>
          deadCodeEntries.map((entry) => `${prefix}${entry}`),
        ),
      ),
    ).toEqual(
      sorted(
        strings(
          field(json(join(repository, ".fallowrc.json")), "entry"),
          ".fallowrc.json entry",
        ).filter((entry) => entry.startsWith(prefix)),
      ),
    );
  });

  test("requires names only declared add-ons and holds no cycle", () => {
    const names = new Set(addons.map(({ name }) => name));
    const requires = new Map(
      addons.map(({ name, requires }) => [name, requires]),
    );
    const reaches = (from: string, seen: readonly string[]): boolean =>
      (requires.get(from) ?? []).some(
        (next) => seen.includes(next) || reaches(next, [...seen, next]),
      );
    for (const { name, requires: required } of addons) {
      for (const other of required) expect(names.has(other)).toBe(true);
      expect(reaches(name, [name])).toBe(false);
    }
  });

  test("no add-on source imports another add-on's folder, so a requirement can come only from kernel-declaration.json", () => {
    const crossings: string[] = [];
    for (const { name, roots } of addons)
      for (const file of files(join(kernelSource, roots[0] ?? "")))
        for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
          /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
        )) {
          const target = relative(
            kernelSource,
            resolve(dirname(file), specifier),
          );
          const owner = addons.find(({ roots: [root = ""] }) =>
            `${target}/`.startsWith(`${root}/`),
          );
          if (specifier.startsWith(".") && owner && owner.name !== name)
            crossings.push(`${relative(kernelSource, file)} -> ${specifier}`);
        }
    expect(crossings).toEqual([]);
  });

  test("no file in the stamped lint folder names the kernel's folder in this repository", () => {
    const named = files(lintFolder).filter((file) =>
      readFileSync(file, "utf8").includes(relative(repository, kernelSource)),
    );
    expect(named).toEqual([]);
  });
});
