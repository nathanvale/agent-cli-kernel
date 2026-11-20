import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import { emptyInput as input, unchanged } from "./kernel-repair/shapes.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";

test("handoff objects ignore key order while inspection arrays preserve declaration order", async () => {
  const refused = station(commonCauses, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_AUTHORITY_REQUIRED",
    trigger: "Authority is unavailable.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "Inspect authority.",
        inspect: [
          { kind: "instruction", text: "Inspect the requested item." },
          { kind: "instruction", text: "Inspect its authority." },
        ],
      },
    },
    repairAction: "Resolve the authority requirement.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "authority-refusal",
  });
  const facts = {
    message: "Authority required.",
    data: null,
    effects: unchanged,
  } as const;
  const check = command({
    capabilities: {},
    identity: "notes.check",
    route: ["check"],
    summary: "Check notes.",
    input,
    stations: [refused],
    run: () => Promise.reject(new Error("The handler never runs here.")),
  });
  const contract = contractFor({ cli: "notes", commands: [check] });
  const built = await contract.build(refused, { ...facts, runId: "run-1" });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("Expected authority refusal.");
  const reordered = {
    inspect: [
      { text: "Inspect the requested item.", kind: "instruction" },
      { text: "Inspect its authority.", kind: "instruction" },
    ],
    reason: "Inspect authority.",
    owner: "operator",
  };
  expect(
    (
      await contract.validate({
        ...built.value,
        result: { ...built.value.result, handoff: reordered },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await contract.validate({
        ...built.value,
        result: {
          ...built.value.result,
          handoff: { ...reordered, inspect: [...reordered.inspect].reverse() },
        },
      })
    ).ok,
  ).toBe(false);
});

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
    run: readsUnchanged("notes.list"),
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
    effects: unchanged,
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
  if (!built.ok) throw new Error("Expected valid instruction result.");
  expect(
    (
      await contract.validate({
        ...built.value,
        result: {
          ...built.value.result,
          next: { text: "Inspect the listed notes.", kind: "instruction" },
        },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await contract.validate({
        ...built.value,
        result: {
          ...built.value.result,
          next: { text: "Different instruction.", kind: "instruction" },
        },
      })
    ).ok,
  ).toBe(false);
  expect(() =>
    station(commonCauses, {
      ...success,
      causeCode: "INTERNAL_PREPARATION",
      repairAction: "Repair preparation.",
      guidance: { next: { kind: "instruction", text: "Repair preparation." } },
    }),
  ).toThrow("Fallback station words are reserved.");
});

test("navigation rejects colliding identities and route resolution never initialises a handler", async () => {
  let calls = 0;
  const list = command({
    capabilities: {},
    identity: "notes.list",
    route: ["list"],
    summary: "List.",
    input,
    run: (_input, context) => {
      calls++;
      return context.result(
        { commandIdentity: "notes.list", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: ["note-1"],
          effects: unchanged,
        },
      );
    },
  });
  expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow(
    "Duplicate command identity.",
  );
  const contract = contractFor({ cli: "notes", commands: [list] });
  expect(contract.help().commands).toHaveLength(1);
  expect(await contract.resolve(["list", "--json"])).toMatchObject({
    ok: true,
    value: { commandIdentity: "notes.list", machine: true, input: {} },
  });
  expect(calls).toBe(0);
  const result = await contract.execute("notes.list", [], "run-1");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected handler result.");
  expect(await contract.buildResult(result.value)).toMatchObject({
    ok: true,
    value: { result: { data: ["note-1"] } },
  });
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
        run: readsUnchanged("notes.list"),
      }),
    ],
  });
  const built = await contract.build(success, {
    runId: "run-2",
    message: "Listed.",
    data: null,
    effects: unchanged,
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

test("binding and idempotency values are rejected consistently at build and wire ingress", async () => {
  const target = command({
    identity: "notes.inspect",
    route: ["inspect"],
    summary: "Read.",
    capabilities: {},
    input: {
      ...input,
      arguments: [
        {
          name: "item",
          summary: "Item.",
          required: true,
          value: {
            kind: "string",
            minLength: 0,
            maxLength: 4096,
            choices: null,
            pattern: null,
          },
        },
      ],
    },
    run: readsUnchanged("notes.inspect"),
  });
  const selected = station(commonCauses, {
    commandIdentity: "notes.issue",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read reference.",
    guidance: {
      next: {
        kind: "command",
        command: "notes.inspect",
        args: ["{binding.item}"],
      },
    },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "binding-output",
  });
  const issue = command({
    identity: "notes.issue",
    route: ["issue"],
    summary: "Read reference.",
    input,
    capabilities: {},
    stations: [selected],
    run: readsUnchanged("notes.issue"),
  });
  const contract = contractFor({ cli: "notes", commands: [issue, target] });
  const facts = {
    runId: "run-1",
    message: "Read.",
    data: null,
    effects: unchanged,
  } as const;
  const valid = await contract.build(selected, {
    ...facts,
    bindings: { item: "alpha" },
  });
  expect(valid.ok).toBe(true);
  if (!valid.ok) throw new Error("Valid control refused.");
  const invalid = [
    "",
    "  ",
    "x".repeat(1025),
    "--force",
    "a\nb",
    "a\u200bb",
    "a\u2028b",
    "a\u2029b",
    "inspect",
  ];
  expect(invalid).toHaveLength(9);
  for (const item of invalid) {
    expect(
      (await contract.build(selected, { ...facts, bindings: { item } })).ok,
    ).toBe(false);
    expect(
      (
        await contract.validate({
          ...valid.value,
          result: {
            ...valid.value.result,
            bindings: { item },
            next: { kind: "command", command: "notes.inspect", args: [item] },
          },
        })
      ).ok,
    ).toBe(false);
  }
  for (const bindings of [undefined, {}, { item: "alpha", extra: "beta" }])
    expect(
      (
        await contract.validate({
          ...valid.value,
          result: { ...valid.value.result, bindings },
        })
      ).ok,
    ).toBe(false);
  expect(
    Reflect.set(issue.stations[0]?.guidance.next ?? {}, "kind", "retry"),
  ).toBe(false);
  const keyed = station(commonCauses, {
    ...selected,
    repairAction: null,
    commandIdentity: "notes.keyed",
    guidance: {
      next: {
        kind: "command",
        command: "notes.inspect",
        args: ["{idempotencyKey}"],
      },
    },
  });
  const keyedContract = contractFor({
    cli: "notes",
    commands: [
      target,
      command({
        identity: "notes.keyed",
        route: ["keyed"],
        summary: "Read key.",
        input,
        capabilities: {},
        stations: [keyed],
        run: readsUnchanged("notes.keyed"),
      }),
    ],
  });
  expect(
    (await keyedContract.build(keyed, { ...facts, idempotencyKey: "alpha" }))
      .ok,
  ).toBe(true);
  expect(
    (await keyedContract.build(keyed, { ...facts, idempotencyKey: "--force" }))
      .ok,
  ).toBe(false);
});
