import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  station,
  contractFor,
} from "../../starters/contract3/src/kernel/index.ts";

const input = {
  arguments: [
    {
      name: "item",
      summary: "Item.",
      required: true,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 12,
        choices: null,
        pattern: null,
      },
    },
  ],
  options: [
    {
      name: "--count",
      aliases: ["-n"],
      summary: "Count.",
      required: false,
      repeatable: false,
      value: { kind: "integer", minimum: -2, maximum: 5 },
    },
    {
      name: "--detail",
      aliases: [],
      summary: "Detail.",
      required: false,
      repeatable: false,
      value: null,
    },
  ],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

test("one executable declaration projects input and strictly parses literal cases", async () => {
  const show = command({
    capabilities: {},
    identity: "items.show",
    route: ["show"],
    summary: "Show an item.",
    input,
    run: (_input, context) =>
      context.result(
        { commandIdentity: "items.show", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
  });
  const contract = contractFor({ cli: "items", commands: [show] });
  expect(contract.discoverCommand("items.show")?.input).toEqual(input);
  expect(
    await contract.parse("items.show", ["alpha", "-n", "-2", "--detail"]),
  ).toEqual({
    ok: true,
    value: { item: "alpha", "--count": -2, "--detail": true },
  });
  for (const args of [
    [],
    ["alpha", "--count=2"],
    ["alpha", "--count", "01"],
    ["alpha", "--count", "6"],
    ["alpha", "--detail", "true"],
    ["alpha", "--detail", "--detail"],
    ["alpha", "--unknown"],
    ["-item"],
  ])
    expect((await contract.parse("items.show", args)).ok).toBe(false);
  expect(await contract.parse("items.show", ["--", "--json"])).toEqual({
    ok: true,
    value: { item: "--json" },
  });
});

test("untrusted patterns terminate within the reader budget and invalid declarations refuse", async () => {
  expect(() =>
    command({
      capabilities: {},
      identity: "bad",
      route: ["bad"],
      summary: "Bad.",
      input: {
        ...input,
        constraints: [
          { kind: "requires", ifPresent: "absent", thenPresent: "item" },
        ],
      },
      run: (_input, context) =>
        context.result(
          { commandIdentity: "bad", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Read.",
            data: null,
            effects: {
              completed: [],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          },
        ),
    }),
  ).toThrow();
  const hostile = command({
    capabilities: {},
    identity: "items.hostile",
    route: ["hostile"],
    summary: "Pattern budget.",
    input: {
      ...input,
      arguments: [
        {
          ...input.arguments[0],
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 4096,
            choices: null,
            pattern: "(a+)+",
          },
        },
      ],
    },
    run: (_input, context) =>
      context.result(
        { commandIdentity: "items.hostile", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
  });
  const contract = contractFor({ cli: "items", commands: [hostile] });
  const start = performance.now();
  expect(
    await contract.parse("items.hostile", [`${"a".repeat(100)}!`]),
  ).toMatchObject({ ok: false, reason: "pattern budget" });
  expect(performance.now() - start).toBeLessThan(2000);
});

test("caller values for later commands are validated before the current handler", async () => {
  let guarded = 0;
  const pending = command({
    identity: "items.pending",
    route: ["pending"],
    summary: "Read an item.",
    input: {
      ...input,
      arguments: [
        {
          ...input.arguments[0],
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 8,
            choices: ["alpha"],
            pattern: null,
          },
        },
      ],
    },
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: "items.pending", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
  });
  const issued = station(commonCauses, {
    commandIdentity: "items.issue",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read reference.",
    guidance: {
      next: {
        kind: "command",
        command: "items.pending",
        args: ["{binding.item}"],
      },
    },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "handler-not-entered",
  });
  const issue = command({
    identity: "items.issue",
    route: ["issue"],
    summary: "Issue a reference.",
    input: {
      ...input,
      arguments: [
        {
          ...input.arguments[0],
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
    capabilities: {},
    futureBindings: { item: "item" },
    stations: [issued],
    run: (_input, context) => {
      guarded++;
      return context.result(
        { commandIdentity: "items.issue", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      );
    },
  });
  const contract = contractFor({ cli: "items", commands: [issue, pending] });
  const invalid = [
    "",
    " ",
    "x".repeat(1025),
    "--force",
    "a\nb",
    "a\u200bb",
    "a\u2028b",
    "a\u2029b",
    "pending",
    "beta",
  ];
  expect(invalid).toHaveLength(10);
  for (const value of invalid) {
    expect(
      (await contract.execute("items.issue", ["--", value], "run-1")).ok,
    ).toBe(false);
    expect((await issue.execute(["--", value], {}, "run-1")).ok).toBe(false);
  }
  expect(guarded).toBe(0);
  expect(
    await contract.execute("items.issue", ["alpha"], "run-2"),
  ).toMatchObject({ ok: true, value: { commandIdentity: "items.issue" } });
  expect(guarded).toBe(1);
});

test("admitted prototype-like input names behave as own dictionary keys", async () => {
  for (const name of ["constructor", "toString", "__proto__", "item"]) {
    const read = command({
      identity: "items.read",
      route: ["read"],
      summary: "Read.",
      input: { ...input, arguments: [{ ...input.arguments[0], name }] },
      capabilities: {},
      run: (_input, context) =>
        context.result(
          { commandIdentity: "items.read", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Read.",
            data: null,
            effects: {
              completed: [],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          },
        ),
    });
    const contract = contractFor({ cli: "items", commands: [read] });
    const expected = Object.fromEntries([[name, "alpha"]]);
    expect(await contract.parse("items.read", ["alpha"])).toEqual({
      ok: true,
      value: expected,
    });
    expect(await contract.resolve(["read", "alpha"])).toMatchObject({
      ok: true,
      value: { input: expected },
    });
  }
});

test("reused declarations validate future inputs against their current contract", async () => {
  const schema = {
    arguments: [
      {
        name: "item",
        summary: "Item.",
        required: true,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 8,
          choices: null,
          pattern: null,
        },
      },
    ],
    options: [],
    constraints: [],
    deadlineSupported: false,
    additionalArguments: false,
    additionalOptions: false,
  } as const;
  const selected = station(commonCauses, {
    commandIdentity: "items.source",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read.",
    guidance: {
      next: {
        kind: "command",
        command: "items.target",
        args: ["{binding.item}"],
      },
    },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "input-registry",
  });
  let calls = 0;
  const source = command({
    identity: "items.source",
    route: ["source"],
    summary: "Read reference.",
    input: schema,
    capabilities: {},
    futureBindings: { item: "item" },
    stations: [selected],
    run: (input, context) => {
      calls++;
      return context.result(selected, {
        message: "Read.",
        data: null,
        bindings: { item: input.item },
        effects: {
          completed: [],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        },
      });
    },
  });
  function target(choice: string) {
    return command({
      identity: "items.target",
      route: ["target"],
      summary: "Read target.",
      input: {
        ...schema,
        arguments: [
          {
            ...schema.arguments[0],
            value: { ...schema.arguments[0].value, choices: [choice] },
          },
        ],
      },
      capabilities: {},
      run: (_input, context) =>
        context.result(
          { commandIdentity: "items.target", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Read.",
            data: null,
            effects: {
              completed: [],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          },
        ),
    });
  }
  const first = contractFor({
    cli: "items",
    commands: [source, target("alpha")],
  });
  const second = contractFor({
    cli: "items",
    commands: [source, target("beta")],
  });
  expect((await first.execute("items.source", ["beta"], "run-1")).ok).toBe(
    false,
  );
  expect(calls).toBe(0);
  expect((await first.execute("items.source", ["alpha"], "run-2")).ok).toBe(
    true,
  );
  expect((await second.execute("items.source", ["beta"], "run-3")).ok).toBe(
    true,
  );
  expect((await second.execute("items.source", ["alpha"], "run-4")).ok).toBe(
    false,
  );
  expect(calls).toBe(2);
});
