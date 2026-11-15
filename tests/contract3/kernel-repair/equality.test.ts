import { expect } from "bun:test";
import { resolve } from "node:path";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import { sameJson } from "../../../starters/contract3/src/kernel/validation/json-equality.ts";
import { buildUnchecked, runFamily } from "./harness.ts";
import { emptyInput, unchanged } from "./shapes.ts";

// R15 (F16). NFC and NFD spellings of e-acute are distinct keys that a
// locale collation ranks equal (WIRE-1: member order carries no meaning).
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
    const module = resolve(
      import.meta.dir,
      "../../../starters/contract3/src/kernel/validation/json-equality.ts",
    );
    const source = `const { sameJson } = await import(${JSON.stringify(module)});
const a = "\\u00e9", b = "e\\u0301";
process.stdout.write(JSON.stringify([sameJson({ [a]: 1, [b]: 2 }, { [b]: 2, [a]: 1 }), sameJson({ z: 1, "\\u00e4": 2, a: 3 }, { a: 3, "\\u00e4": 2, z: 1 })]));`;
    const answers = new Set<string>();
    for (const locale of ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"]) {
      const child = Bun.spawn([process.execPath, "-e", source], {
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      answers.add(stdout);
    }
    expect([...answers]).toEqual(["[true,true]"]);
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
