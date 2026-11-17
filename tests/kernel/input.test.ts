import type { InputSchema } from "../../kernel/src/kernel/index.ts";
import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  station,
  contractFor,
} from "../../kernel/src/kernel/index.ts";
import { unchanged } from "./kernel-repair/shapes.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";

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
    run: readsUnchanged("items.show"),
  });
  const contract = contractFor({ cli: "items", commands: [show] });
  expect(contract.discoverCommand("items.show")?.input).toEqual(input);
  expect(
    await contract.parse("items.show", ["alpha", "-n", "-2", "--detail"]),
  ).toEqual({
    ok: true,
    value: { item: "alpha", "--count": -2, "--detail": true },
  });
  const refusals = [
    [[], "input", "required slot or constraint"],
    [["alpha", "--count=2"], "argv", "unknown option"],
    [["alpha", "--count", "01"], "input", "integer syntax"],
    [["alpha", "--count", "6"], "input", "integer bounds"],
    [["alpha", "--detail", "true"], "argv", "additional argument"],
    [["alpha", "--detail", "--detail"], "--detail", "repeated slot"],
    [["alpha", "--unknown"], "argv", "unknown option"],
    [["-item"], "argv", "unknown option"],
  ] as const;
  expect(refusals).toHaveLength(8);
  for (const [args, path, reason] of refusals)
    expect(await contract.parse("items.show", args)).toEqual({
      ok: false,
      path,
      reason,
    });
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
      run: readsUnchanged("bad"),
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
    run: readsUnchanged("items.hostile"),
  });
  const contract = contractFor({ cli: "items", commands: [hostile] });
  const start = performance.now();
  expect(
    await contract.parse("items.hostile", [`${"a".repeat(100)}!`]),
  ).toMatchObject({ ok: false, reason: "pattern budget" });
  expect(performance.now() - start).toBeLessThan(2000);
});

const admittedFutureRows = [
  {
    name: "noninteger dynamic deadline",
    args: ["--deadline-ms", "{binding.delay}", "{binding.item}"],
    accepted: false,
    delay: "not-int",
  },
  {
    name: "runtime-owned deadline",
    args: ["--deadline-ms", "{binding.delay}", "{binding.item}"],
    accepted: true,
    runtimeOwned: true,
  },
  {
    name: "dynamic deadline",
    args: ["--deadline-ms", "{binding.delay}", "{binding.item}"],
    accepted: true,
    delay: "10",
  },
  {
    name: "invalid dynamic deadline",
    args: ["--deadline-ms", "{binding.delay}", "{binding.item}"],
    accepted: false,
    delay: "0",
  },
  { name: "ordinary target", args: ["{binding.item}"], accepted: true },
  {
    name: "deadline target",
    args: ["--deadline-ms", "10", "{binding.item}"],
    accepted: true,
  },
  {
    name: "deadline and delimiter",
    args: ["--deadline-ms", "10", "--", "{binding.item}"],
    accepted: true,
  },
  {
    name: "literal deadline operand, wide literal slot",
    args: ["--", "--deadline-ms", "{binding.item}"],
    accepted: true,
    literalMaxLength: 16,
  },
];
const rejectedFutureRows = [
  {
    name: "literal deadline operand",
    args: ["--", "--deadline-ms", "{binding.item}"],
    literalMaxLength: 12,
    reason: /literal value for literal/,
  },
  {
    name: "malformed deadline",
    args: ["--deadline-ms", "0", "{binding.item}"],
    reason: /literal deadline/,
  },
  {
    name: "repeated deadline",
    args: ["--deadline-ms", "10", "--deadline-ms", "20", "{binding.item}"],
    reason: /deadline option/,
  },
];
function futureDeclarations(row: {
  readonly name: string;
  readonly args: readonly string[];
  readonly delay?: string;
  readonly runtimeOwned?: boolean;
  readonly literalMaxLength?: number;
}) {
  const handled = { count: 0 };
  const pending = command({
    identity: "items.pending",
    route: ["pending"],
    summary: "Read an item.",
    input: {
      ...input,
      deadlineSupported: true,
      arguments: [
        ...(row.literalMaxLength === undefined
          ? []
          : [
              {
                ...input.arguments[0],
                name: "literal",
                value: {
                  ...input.arguments[0].value,
                  maxLength: row.literalMaxLength,
                },
              },
            ]),
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
    run: readsUnchanged("items.pending"),
  });
  const issued = station(commonCauses, {
    commandIdentity: "items.issue",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read reference.",
    guidance: {
      next: {
        kind: "command",
        command: "items.pending",
        args: row.args,
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
      options: [
        ...input.options,
        {
          name: "--delay",
          aliases: [],
          summary: "Future deadline.",
          required: true,
          repeatable: false,
          value: input.arguments[0].value,
        },
      ],
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
    futureBindings:
      !row.runtimeOwned && row.args.some((token) => token === "{binding.delay}")
        ? { item: "item", delay: "--delay" }
        : { item: "item" },
    stations: [issued],
    run: (parsed, context) => {
      handled.count++;
      const facts = { message: "Read.", data: null, effects: unchanged };
      return context.result(
        { commandIdentity: "items.issue", causeCode: "SUCCESS_UNCHANGED" },
        row.literalMaxLength === undefined
          ? facts
          : { ...facts, bindings: { item: parsed.item } },
      );
    },
  });
  return { issue, pending, handled };
}

test("future binding rows are exactly the ruled admitted and rejected sets", () => {
  expect(admittedFutureRows.map((row) => row.name).sort()).toEqual(
    [
      "noninteger dynamic deadline",
      "runtime-owned deadline",
      "dynamic deadline",
      "invalid dynamic deadline",
      "ordinary target",
      "deadline target",
      "deadline and delimiter",
      "literal deadline operand, wide literal slot",
    ].sort(),
  );
  expect(rejectedFutureRows.map((row) => row.name).sort()).toEqual(
    [
      "literal deadline operand",
      "malformed deadline",
      "repeated deadline",
    ].sort(),
  );
});

test.each(rejectedFutureRows)(
  "future binding steps that can never parse are refused at declaration: $name",
  (row) => {
    const { issue, pending, handled } = futureDeclarations(row);
    let message = "";
    try {
      contractFor({ cli: "items", commands: [issue, pending] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("items.pending");
    expect(message).toContain("items.issue");
    expect(message).toMatch(row.reason);
    expect(handled.count).toBe(0);
  },
);

test.each(admittedFutureRows)(
  "future bindings reject invalid target values before the handler: $name",
  async (row) => {
    const { args, accepted, delay } = row;
    const sourceArgs = (item: string) => ["--delay", delay ?? "10", "--", item];
    const { issue, pending, handled } = futureDeclarations(row);
    const admitted = (() => {
      try {
        return contractFor({ cli: "items", commands: [issue, pending] });
      } catch {
        return undefined;
      }
    })();
    expect(admitted).toBeDefined();
    if (!admitted) return;
    const contract = admitted;
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
        (await contract.execute("items.issue", sourceArgs(value), "run-1")).ok,
      ).toBe(false);
      expect((await issue.execute(sourceArgs(value), {}, "run-1")).ok).toBe(
        false,
      );
    }
    expect(handled.count).toBe(0);
    expect(
      (
        await contract.parse(
          "items.pending",
          args.map((token) =>
            token
              .replace("{binding.item}", "beta")
              .replace("{binding.delay}", delay ?? "10"),
          ),
        )
      ).ok,
    ).toBe(false);
    const run = await contract.execute(
      "items.issue",
      sourceArgs("alpha"),
      "run-2",
    );
    expect(run.ok).toBe(accepted);
    expect(handled.count).toBe(accepted ? 1 : 0);
    if (row.literalMaxLength === undefined || !run.ok) return;
    const emitted = ["--", "--deadline-ms", "alpha"];
    const built = await contract.buildResult(run.value);
    expect(built.ok).toBe(true);
    if (built.ok)
      expect(built.value.result.next).toEqual({
        kind: "command",
        command: "items.pending",
        args: emitted,
      });
    const parsed = await contract.parse("items.pending", emitted);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.deadlineMilliseconds).toBeUndefined();
  },
);

test("admitted prototype-like input names behave as own dictionary keys", async () => {
  for (const name of ["constructor", "toString", "__proto__", "item"]) {
    const read = command({
      identity: "items.read",
      route: ["read"],
      summary: "Read.",
      input: { ...input, arguments: [{ ...input.arguments[0], name }] },
      capabilities: {},
      run: readsUnchanged("items.read"),
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
        effects: unchanged,
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
      run: readsUnchanged("items.target"),
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

test("host pattern declarations reject invalid Unicode syntax before publication", async () => {
  function schema(pattern: string, option: boolean): InputSchema {
    const value = {
      kind: "string",
      minLength: 1,
      maxLength: 12,
      choices: null,
      pattern,
    } as const;
    return {
      ...input,
      arguments: option ? [] : [{ ...input.arguments[0], value }],
      options: option
        ? [
            {
              name: "--value",
              aliases: [],
              summary: "Value.",
              required: true,
              repeatable: false,
              value,
            },
          ]
        : [],
    };
  }
  function declared(pattern: string, option: boolean) {
    return command({
      identity: "items.pattern",
      route: ["pattern"],
      summary: "Read pattern input.",
      input: schema(pattern, option),
      capabilities: {},
      run: readsUnchanged("items.pattern"),
    });
  }
  for (const option of [false, true]) {
    const valid = declared("\\p{L}+", option);
    const contract = contractFor({ cli: "items", commands: [valid] });
    expect(contract.discoverCommand("items.pattern")?.input).toMatchObject(
      option
        ? {
            options: [
              {
                name: "--value",
                value: { kind: "string", pattern: "\\p{L}+" },
              },
            ],
          }
        : {
            arguments: [
              { name: "item", value: { kind: "string", pattern: "\\p{L}+" } },
            ],
          },
    );
    expect(
      (
        await contract.parse(
          "items.pattern",
          option ? ["--value", "αβ"] : ["αβ"],
        )
      ).ok,
    ).toBe(true);
    for (const pattern of ["[", "\\u{110000}"]) {
      expect(() => declared(pattern, option)).toThrow();
      const invalid = { ...valid, input: schema(pattern, option) };
      expect(() =>
        contractFor({ cli: "items", commands: [invalid] }),
      ).toThrow();
    }
  }
});
