import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { envelopeShape } from "../../../starters/contract3/src/kernel/validation/result.ts";
import { envelope } from "./envelope-fixture.ts";
import { contractUnchecked } from "./harness.ts";
import { emptyInput, unchanged } from "./shapes.ts";

// Swarm-triage kernel-internal findings (K2-6, K2-12). Their oracle is the
// coding standard and the predicate's own declared type, not a frozen case.

test("K2-6: envelopeShape, typed `value is Envelope`, checks diagnostics", () => {
  // Diagnostics written from the DIAG available shape, not kernel output.
  const available = {
    status: "available",
    file: null,
    sinkFailure: null,
    droppedRecords: 0,
    unflushedRecords: 0,
    truncatedRecords: 0,
    countsComplete: true,
    closed: true,
  };
  expect(envelopeShape(envelope(null))).toBe(true);
  expect(envelopeShape({ ...envelope(null), diagnostics: available })).toBe(
    true,
  );
  for (const diagnostics of [
    "not a diagnostics object",
    { ...available, status: "invented" },
    { ...available, droppedRecords: -1 },
  ])
    expect(envelopeShape({ ...envelope(null), diagnostics })).toBe(false);
});

test("K2-12: a fault inside validation after the snapshot propagates instead of blaming the external value", async () => {
  // The step target's declaration throws on read once armed, after
  // admission: a fault in the CLI's own validation steps, not in the value.
  const defect = new TypeError("Deliberate defect inside a validation step.");
  let armed = false;
  const target = {
    commandIdentity: "specimen.target",
    route: ["target"],
    summary: "Target.",
    effectClass: "inspect",
    stations: [],
    capabilities: {},
    get input() {
      if (armed) throw defect;
      return emptyInput;
    },
    execute: () =>
      Promise.resolve({
        ok: false,
        path: "handler",
        reason: "Never runs.",
      } as const),
  };
  const step = {
    kind: "command",
    command: "specimen.target",
    args: [],
  } as const;
  const read = station(commonCauses, {
    commandIdentity: "specimen.read",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read.",
    guidance: { next: step },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "swarm-internal",
  });
  const source = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    stations: [read],
    run: (_input, context) =>
      context.result(read, {
        message: "Read.",
        data: null,
        effects: unchanged,
      }),
  });
  const contract = contractUnchecked(contractFor, {
    cli: "specimen",
    commands: [source, target],
  });
  const validate: unknown =
    typeof contract === "object" && contract !== null
      ? Reflect.get(contract, "validate")
      : undefined;
  if (typeof validate !== "function") throw new Error("No validate.");
  const value = {
    ...envelope(null),
    availablePaths: ["specimen.read"],
    result: { ...envelope(null).result, next: step },
  };
  // Twin: unarmed, the same conforming envelope validates.
  expect(await Reflect.apply(validate, contract, [value])).toMatchObject({
    ok: true,
  });
  armed = true;
  await expect(Reflect.apply(validate, contract, [value])).rejects.toBe(defect);
  // An unreadable external value is still refused as one.
  armed = false;
  const hostile = {
    ...value,
    get message() {
      throw new Error("Hostile getter.");
    },
  };
  expect(await Reflect.apply(validate, contract, [hostile])).toEqual({
    ok: false,
    path: "$",
    reason: "not plain bounded JSON",
  });
});
