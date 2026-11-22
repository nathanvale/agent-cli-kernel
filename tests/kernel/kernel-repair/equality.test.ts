import { expect } from "bun:test";
import { resolve } from "node:path";
import { command, contractFor } from "../../../kernel/src/kernel/index.ts";
import { sameJson } from "../../../kernel/src/kernel/validation/json-equality.ts";
import { buildUnchecked, runFamily } from "./harness.ts";
import { emptyInput, unchanged } from "./shapes.ts";

const composed = "é";
const decomposed = "é";
const pairs = () => ({
  canonical: sameJson(
    { [composed]: 1, [decomposed]: 2 },
    { [decomposed]: 2, [composed]: 1 },
  ),
  order: sameJson({ b: 1, a: 2 }, { a: 2, b: 1 }),
  changed: sameJson({ b: 1, a: 2 }, { a: 3, b: 1 }),
});
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reversed(entry)]),
  );
}

runFamily("R15", {
  "R15.canonically-equivalent-keys": () => expect(pairs().canonical).toBe(true),
  "R15.member-order": () => expect(pairs().order).toBe(true),
  "R15.value-change": () => expect(pairs().changed).toBe(false),
  "R15.locale-independent": async () => {
    // Platform: Bun 1.4.4 keeps its default en-US collation locale regardless of LC_ALL or LANG.
    const module = resolve(
      import.meta.dir,
      "../../../kernel/src/kernel/validation/json-equality.ts",
    );
    const source = `const { sameJson } = await import(${JSON.stringify(module)});
const nfc = "\\u00e9", nfd = "e\\u0301";
const answers = () => [
  sameJson({ [nfc]: 1, [nfd]: 2 }, { [nfd]: 2, [nfc]: 1 }),
  sameJson({ z: 1, "\\u00e4": 2, a: 3 }, { a: 3, "\\u00e4": 2, z: 1 }),
  sameJson({ a: 1, A: 2 }, { A: 2, a: 1 }),
];
const native = String.prototype.localeCompare;
const arms = [{ name: "runtime-default", locale: null, answers: answers() }];
for (const [locale, options] of [["sv", {}], ["tr", {}], ["en", { sensitivity: "base" }]]) {
  const collator = new Intl.Collator(locale, options);
  String.prototype.localeCompare = function (other) { return collator.compare(String(this), String(other)); };
  arms.push({ name: locale, locale: collator.resolvedOptions().locale, tie: "a".localeCompare("A") === 0, answers: answers() });
  String.prototype.localeCompare = native;
}
process.stdout.write(JSON.stringify({ defaultLocale: new Intl.Collator().resolvedOptions().locale, arms }));`;
    const observed: unknown[] = [];
    for (const locale of ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"]) {
      const child = Bun.spawn([process.execPath, "-e", source], {
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const parsed: unknown = JSON.parse(stdout);
      observed.push(parsed);
    }
    const same = [true, true, true];
    for (const child of observed)
      expect(child).toMatchObject({
        arms: [
          { name: "runtime-default", locale: null, answers: same },
          { name: "sv", locale: "sv", tie: false, answers: same },
          { name: "tr", locale: "tr", tie: false, answers: same },
          { name: "en", locale: "en", tie: true, answers: same },
        ],
      });
  },
  "R15.reordered-discovery-validates": async () => {
    const read = command({
      identity: "specimen.read",
      route: ["read"],
      summary: "Read.",
      input: emptyInput,
      capabilities: {},
      run: () => {
        throw new Error("Never entered.");
      },
    });
    const contract = contractFor({ cli: "specimen", commands: [read] });
    for (const [identity, data] of [
      ["specimen.help", contract.help()],
      ["specimen.discovery", contract.discover()],
    ] as const) {
      const built = await buildUnchecked(
        contract,
        { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
        {
          runId: "run-1",
          message: "Navigation.",
          data: reversed(data),
          effects: unchanged,
        },
      );
      expect(built).toMatchObject({ ok: true });
    }
  },
});
