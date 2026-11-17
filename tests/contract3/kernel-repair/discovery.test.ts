import { expect } from "bun:test";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import { buildUnchecked, runFamily } from "./harness.ts";
import { emptyInput as input, unchanged } from "./shapes.ts";

const exitOwner = {
  "0": "success",
  "1": "internal",
  "2": "usage",
  "3": "domain",
  "4": "schema",
  "75": "transient",
};
const signals: Readonly<Record<string, string>> = {
  "130": "SIGINT",
  "143": "SIGTERM",
};

function fixture() {
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: "specimen.read", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
  return contractFor({ cli: "specimen", commands: [read] });
}
type Contract = ReturnType<typeof fixture>;

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path)
    current =
      typeof current === "object" && current !== null
        ? Reflect.get(current, key)
        : undefined;
  return current;
}
function attempt(target: unknown, key: string | number, value: unknown) {
  try {
    if (typeof target === "object" && target !== null)
      Reflect.set(target, key, value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}
function stationOf(contract: Contract, identity: string, causeCode: string) {
  return contract
    .discoverCommand(identity)
    ?.stations.find((item) => item.causeCode === causeCode);
}
function mutateAll(contract: Contract) {
  const discovered = contract.discover();
  attempt(discovered.exitMeanings, "0", "other");
  attempt(discovered.signalExits, "130", "SIGHUP");
  for (const identity of ["specimen.read", "specimen.help"]) {
    const preparation = stationOf(contract, identity, "INTERNAL_PREPARATION");
    attempt(field(preparation, "guidance", "next"), "command", "specimen.read");
    attempt(field(preparation, "guidance", "next"), "kind", "retry");
    attempt(field(preparation, "retryDelayPolicy"), "kind", "bounded");
    const unchangedResult = stationOf(
      contract,
      identity,
      "INTERNAL_RESULT_UNCHANGED",
    );
    attempt(field(unchangedResult, "guidance", "handoff"), "reason", "Forged.");
    attempt(
      field(unchangedResult, "guidance", "handoff", "inspect", 0),
      "text",
      "Forged inspection.",
    );
    attempt(field(unchangedResult, "guidance", "handoff", "inspect"), 0, {
      kind: "instruction",
      text: "Forged entry.",
    });
    const stations = contract.discoverCommand(identity)?.stations;
    attempt(stations, 0, { causeCode: "FORGED" });
    attempt(stations, "length", 0);
  }
}
function snapshot(contract: Contract) {
  return structuredClone({
    read: contract.discoverCommand("specimen.read"),
    help: contract.discoverCommand("specimen.help"),
  });
}

runFamily("R09", {
  "R09.exit-meanings-immutable": () => {
    const contract = fixture();
    mutateAll(contract);
    expect(contract.discover().exitMeanings).toEqual(exitOwner);
  },
  "R09.signal-exits-immutable": () => {
    const contract = fixture();
    mutateAll(contract);
    expect<unknown>(contract.discover().signalExits).toEqual(signals);
  },
  "R09.kernel-stations-immutable": () => {
    const contract = fixture();
    const before = snapshot(contract);
    mutateAll(contract);
    expect(snapshot(contract)).toEqual(before);
  },
  "R09.second-contract-exact-tables": () => {
    const first = fixture();
    mutateAll(first);
    const second = fixture();
    for (const contract of [first, second]) {
      expect(contract.discover().exitMeanings).toEqual(exitOwner);
      expect<unknown>(contract.discover().signalExits).toEqual(signals);
    }
  },
  "R09.built-words-original": async () => {
    const contract = fixture();
    const before = stationOf(contract, "specimen.read", "INTERNAL_PREPARATION");
    const original = structuredClone(field(before, "guidance"));
    mutateAll(contract);
    const built = await buildUnchecked(
      contract,
      { commandIdentity: "specimen.read", causeCode: "INTERNAL_PREPARATION" },
      { runId: "run-1", message: "Prepared.", data: null, effects: unchanged },
    );
    expect(field(built, "ok")).toBe(true);
    expect(field(built, "value", "result", "next")).toEqual(
      field(original, "next"),
    );
  },
  "R09.altered-discovery-refused": async () => {
    const contract = fixture();
    mutateAll(contract);
    const build = (data: unknown): Promise<unknown> =>
      buildUnchecked(
        contract,
        {
          commandIdentity: "specimen.discovery",
          causeCode: "SUCCESS_UNCHANGED",
        },
        { runId: "run-1", message: "Discovered.", data, effects: unchanged },
      );
    const exact = structuredClone(contract.discover());
    expect(field(await build(exact), "ok")).toBe(true);
    expect(
      field(await build({ ...exact, exitMeanings: exitOwner }), "ok"),
    ).toBe(true);
    expect(
      field(
        await build({
          ...exact,
          exitMeanings: { ...exitOwner, "0": "other" },
        }),
        "ok",
      ),
    ).toBe(false);
    expect(
      field(
        await build({ ...exact, signalExits: { ...signals, "130": "SIGHUP" } }),
        "ok",
      ),
    ).toBe(false);
  },
});
