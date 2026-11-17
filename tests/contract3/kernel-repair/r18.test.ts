import { expect } from "bun:test";
import * as kernel from "../../../starters/contract3/src/kernel/index.ts";
import { frozenInputs } from "./cases.ts";
import { contractUnchecked, runFamily, stateFixture } from "./harness.ts";
import {
  futureBindings,
  hold,
  observe,
  rows,
  sourceInput,
  stepStation,
  targets,
} from "./r18-spec.ts";
import type { Row } from "./r18-spec.ts";
import { unchanged } from "./shapes.ts";
import { neverRuns } from "./handlers.ts";

const source = "specimen.source";
const rejected = new Set(frozenInputs.r18Rejected.map(([suffix]) => suffix));
let entries = 0;
function commandSource(arm: "next" | "handoff", row: Row) {
  return kernel.command({
    identity: source,
    route: ["source"],
    summary: "Source.",
    input: sourceInput,
    futureBindings: futureBindings(row),
    capabilities: {},
    stations: [stepStation(kernel, source, arm, row)],
    run: (_input, context) => {
      entries++;
      return context.result(
        { commandIdentity: source, causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Source.",
          data: null,
          effects: unchanged,
        },
      );
    },
  });
}
function rawSource(arm: "next" | "handoff", row: Row) {
  return {
    commandIdentity: source,
    route: ["source"],
    summary: "Source.",
    input: sourceInput,
    futureBindings: futureBindings(row),
    capabilities: {},
    stations: [stepStation(kernel, source, arm, row)],
    effectClass: "inspect",
    execute: neverRuns,
  };
}
const admit = (declaration: unknown) => () =>
  contractUnchecked(kernel.contractFor, {
    cli: "specimen",
    commands: [declaration, ...targets(kernel)],
    causes: { HOLD: hold },
  });
let changingRun: Promise<unknown> | undefined;
async function changingObserved(id: string): Promise<unknown> {
  changingRun ??= stateFixture("r18-changing");
  const all: unknown = await changingRun;
  return typeof all === "object" && all !== null
    ? Reflect.get(all, id)
    : undefined;
}
const expected = (suffix: string) =>
  rejected.has(suffix)
    ? { admitted: false, namesStep: true, templateShown: false }
    : { admitted: true, namesStep: false, templateShown: true };

const implementations: Record<string, () => unknown> = {};
expect(Object.keys(rows).sort()).toEqual(
  [...frozenInputs.r18Rejected, ...frozenInputs.r18Admitted]
    .map(([suffix]) => suffix)
    .sort(),
);
for (const [suffix, row] of Object.entries(rows))
  for (const arm of frozenInputs.r18Arms) {
    const id = (path: string) => `R18.${suffix}.${arm}.${path}`;
    implementations[id("command")] = () =>
      expect(observe(admit(commandSource(arm, row)), source, row)).toEqual(
        expected(suffix),
      );
    implementations[id("raw")] = () =>
      expect(observe(admit(rawSource(arm, row)), source, row)).toEqual(
        expected(suffix),
      );
    implementations[id("changing")] = async () =>
      expect(await changingObserved(id("changing"))).toEqual(expected(suffix));
  }
implementations["R18.u1.slot-preflight-unchanged"] = async () => {
  for (const [suffix, argv, entered] of [
    ["a4.value-dependent-integer", ["--count", "abc"], 0],
    ["a4.value-dependent-integer", ["--count", "11"], 0],
    ["a4.value-dependent-integer", ["--count", "5"], 1],
    ["a1.valid-twin", ["--item", "x"], 1],
  ] as const) {
    const row = rows[suffix];
    if (!row) throw new Error(`Missing row ${suffix}.`);
    const contract = admit(commandSource("next", row))();
    const execute: unknown =
      typeof contract === "object" && contract !== null
        ? Reflect.get(contract, "execute")
        : undefined;
    if (typeof execute !== "function") throw new Error("No execute.");
    entries = 0;
    const outcome: unknown = await Reflect.apply(execute, contract, [
      source,
      argv,
      "run-1",
      {},
    ]);
    const ok: unknown =
      typeof outcome === "object" && outcome !== null
        ? Reflect.get(outcome, "ok")
        : undefined;
    expect({ entries, ok }).toEqual({
      entries: entered,
      ok: entered === 1,
    });
  }
};
implementations["R18.u3.existing-admission-unchanged"] = async () => {
  const undeclared = {
    ...rawSource("next", { target: "Missing", args: ["x"] }),
  };
  expect(() =>
    contractUnchecked(kernel.contractFor, {
      cli: "specimen",
      commands: [undeclared],
    }),
  ).toThrow();
  expect(await changingObserved("R18.u3.changing-target")).toEqual({
    refused: true,
  });
};

implementations["R18.u4.templated-option-token"] = () => {
  const row = { target: "Topt", args: ["--target", "main", "--x{runId}"] };
  let message = "";
  try {
    admit(rawSource("next", row))();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("specimen.topt");
  expect(message).toContain("run value");
  expect(message).not.toContain("is not an option");
};

runFamily("R18", implementations, 60000);
