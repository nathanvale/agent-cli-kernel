import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../starters/contract3/src/kernel/index.ts";
const input = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

test("declared stations bind identity and words, with built-ins and fallback stations discoverable", async () => {
  const success = station(commonCauses, {
    commandIdentity: "notes.list",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Notes read.",
    guidance: {
      next: { kind: "instruction", text: "Inspect the listed notes." },
    },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "notes-list-process",
  });
  const list = command({
    capabilities: {},
    identity: "notes.list",
    route: ["list"],
    summary: "List notes.",
    input,
    stations: [success],
    run: () => null,
  });
  const contract = contractFor({ cli: "notes", commands: [list] });
  expect(
    contract.discover().commands.map((item) => item.commandIdentity),
  ).toEqual([
    "notes.command-discovery",
    "notes.discovery",
    "notes.dispatch",
    "notes.help",
    "notes.list",
  ]);
  expect(
    contract
      .discoverCommand("notes.list")
      ?.stations.map((item) => item.causeCode),
  ).toEqual([
    "SUCCESS_UNCHANGED",
    "USAGE_INVALID_INVOCATION",
    "INTERNAL_PREPARATION",
    "INTERNAL_RESULT_UNCHANGED",
  ]);
  const built = await contract.build(success, {
    runId: "run-1",
    message: "Listed notes.",
    data: [],
    effects: {
      completed: [],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    },
    causeCode: "TRANSIENT_NOT_STARTED",
    exitCode: 75,
  });
  expect(built).toMatchObject({
    ok: true,
    value: {
      result: {
        commandIdentity: "notes.list",
        causeCode: "SUCCESS_UNCHANGED",
        exitCode: 0,
        next: { kind: "instruction", text: "Inspect the listed notes." },
      },
    },
  });
  expect(() =>
    station(commonCauses, {
      ...success,
      causeCode: "INTERNAL_PREPARATION",
      repairAction: "Repair preparation.",
      guidance: { next: { kind: "instruction", text: "Repair preparation." } },
    }),
  ).toThrow();
});

test("navigation rejects colliding identities and route resolution never initialises a handler", async () => {
  let calls = 0;
  const list = command({
    capabilities: {},
    identity: "notes.list",
    route: ["list"],
    summary: "List.",
    input,
    run: () => {
      calls++;
      return ["note-1"];
    },
  });
  expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow();
  const contract = contractFor({ cli: "notes", commands: [list] });
  expect(contract.help().commands).toHaveLength(1);
  expect(await contract.resolve(["list", "--json"])).toMatchObject({
    ok: true,
    value: { commandIdentity: "notes.list", machine: true, input: {} },
  });
  expect(calls).toBe(0);
  expect(await list.execute([], {})).toEqual({ ok: true, value: ["note-1"] });
  expect(calls).toBe(1);
  expect(await contract.resolve([])).toMatchObject({
    ok: false,
    commandIdentity: "notes.dispatch",
    causeCode: "USAGE_INVALID_INVOCATION",
  });
  expect(await contract.resolve(["not-list"])).toMatchObject({
    ok: false,
    commandIdentity: "notes.dispatch",
    causeCode: "USAGE_UNKNOWN_COMMAND",
  });
});

test("output validates declarations, diagnostic variants and fixed guidance", async () => {
  const success = station(commonCauses, {
    commandIdentity: "notes.list",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read notes.",
    guidance: { next: { kind: "done" } },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "list-process",
  });
  const contract = contractFor({
    cli: "notes",
    commands: [
      command({
        capabilities: {},
        identity: "notes.list",
        route: ["list"],
        summary: "List.",
        input,
        stations: [success],
        run: () => null,
      }),
    ],
  });
  const built = await contract.build(success, {
    runId: "run-2",
    message: "Listed.",
    data: null,
    effects: {
      completed: [],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    },
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("Expected valid result.");
  for (const mutation of [
    { commandIdentity: "notes.absent" },
    {
      causeCode: "USAGE_UNKNOWN_COMMAND",
      outcome: "refused",
      failureClass: "usage",
      exitCode: 2,
      repairAction: "Select route.",
      next: { kind: "instruction", text: "Select route." },
    },
    { next: { kind: "instruction", text: "Changed words." } },
  ])
    expect(
      (
        await contract.validate({
          ...built.value,
          result: { ...built.value.result, ...mutation },
        })
      ).ok,
    ).toBe(false);
  expect(
    (
      await contract.validate({
        ...built.value,
        diagnostics: {
          status: "unavailable",
          reason: "status-invalid",
          trusted: {},
        },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await contract.validate({
        ...built.value,
        diagnostics: { status: "unavailable", reason: "made-up", trusted: {} },
      })
    ).ok,
  ).toBe(false);
});
