import { expect, test } from "bun:test";
import { command, contractFor } from "../../kernel/src/kernel/index.ts";

const empty = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: true,
  additionalArguments: false,
  additionalOptions: false,
} as const;
function specimen(deadlineSupported = true) {
  const observed: unknown[] = [];
  const check = command({
    identity: "sample.check",
    route: ["check"],
    summary: "Check input.",
    input: { ...empty, deadlineSupported },
    capabilities: {},
    run: (input, context) => {
      observed.push(input);
      return context.result(
        { commandIdentity: "sample.check", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Checked.",
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
  return {
    observed,
    check,
    contract: contractFor({ cli: "sample", commands: [check] }),
  };
}

test("supported deadlines retain metadata apart from domain input in parsing and routing", async () => {
  const { contract } = specimen();
  const valid = [
    { token: "1", value: 1 },
    { token: "10", value: 10 },
    { token: "9007199254740991", value: 9007199254740991 },
  ];
  expect(valid).toHaveLength(3);
  for (const { token, value } of valid) {
    expect(
      await contract.parse("sample.check", ["--deadline-ms", token]),
    ).toEqual({ ok: true, value: {}, deadlineMilliseconds: value });
    for (const argv of [
      ["check", "--deadline-ms", token],
      ["--deadline-ms", token, "check"],
      ["--json", "--deadline-ms", token, "check"],
    ]) {
      expect(await contract.resolve(argv)).toMatchObject({
        ok: true,
        value: {
          commandIdentity: "sample.check",
          input: {},
          deadlineMilliseconds: value,
        },
      });
    }
  }
  expect(contract.discoverCommand("sample.check")?.input).toMatchObject({
    deadlineSupported: true,
    options: [],
  });
  expect(contract.help().options).toContainEqual({
    name: "--deadline-ms",
    valueName: "positive-integer",
    summary:
      "Limit supported command work to a positive number of milliseconds.",
  });
  expect(await contract.parse("sample.check", [])).toEqual({
    ok: true,
    value: {},
  });
});

test("invalid or unsupported deadlines refuse before the handler", async () => {
  const { contract, check, observed } = specimen();
  const invalid = [
    [],
    ["0"],
    ["-1"],
    ["01"],
    ["+1"],
    ["1.5"],
    ["1e2"],
    [""],
    [" "],
    ["9007199254740992"],
    ["Infinity"],
  ];
  expect(invalid).toHaveLength(11);
  for (const suffix of invalid) {
    const argv = ["--deadline-ms", ...suffix];
    expect(await contract.resolve(["check", ...argv])).toMatchObject({
      ok: false,
      causeCode: "USAGE_INVALID_INVOCATION",
    });
    expect((await contract.execute("sample.check", argv, "run-1")).ok).toBe(
      false,
    );
    expect((await check.execute(argv, {}, "run-1")).ok).toBe(false);
  }
  for (const argv of [
    ["--deadline-ms=0"],
    ["--deadline-ms", "10", "--deadline-ms", "20"],
    ["--deadline-ms=10", "--deadline-ms=20"],
  ])
    expect((await contract.execute("sample.check", argv, "run-1")).ok).toBe(
      false,
    );
  expect(
    await contract.resolve(["--help", "--deadline-ms", "10"]),
  ).toMatchObject({
    ok: false,
    commandIdentity: "sample.dispatch",
    causeCode: "USAGE_INVALID_INVOCATION",
  });
  expect(observed).toEqual([]);
  const unsupported = specimen(false);
  expect(
    await unsupported.contract.resolve(["check", "--deadline-ms", "10"]),
  ).toMatchObject({ ok: false, causeCode: "USAGE_INVALID_INVOCATION" });
  expect(
    (
      await unsupported.contract.execute(
        "sample.check",
        ["--deadline-ms", "10"],
        "run-2",
      )
    ).ok,
  ).toBe(false);
  expect(unsupported.observed).toEqual([]);
  expect(
    unsupported.contract
      .help()
      .options.some((option) => option.name === "--deadline-ms"),
  ).toBe(false);
  expect(
    await contract.execute("sample.check", ["--deadline-ms", "10"], "run-3"),
  ).toMatchObject({ ok: true, deadlineMilliseconds: 10 });
  expect(observed).toEqual([{}]);
});

test("the delimiter preserves deadline-looking operands without activating a deadline", async () => {
  const string = {
    kind: "string",
    minLength: 1,
    maxLength: 32,
    choices: null,
    pattern: null,
  } as const;
  const literal = command({
    identity: "sample.literal",
    route: ["literal"],
    summary: "Read literals.",
    input: {
      ...empty,
      deadlineSupported: false,
      arguments: [
        { name: "first", summary: "First.", required: true, value: string },
        { name: "second", summary: "Second.", required: true, value: string },
      ],
    },
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: "sample.literal", causeCode: "SUCCESS_UNCHANGED" },
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
  const contract = contractFor({ cli: "sample", commands: [literal] });
  expect(
    await contract.resolve(["literal", "--", "--deadline-ms", "10"]),
  ).toEqual({
    ok: true,
    value: {
      commandIdentity: "sample.literal",
      machine: false,
      input: { first: "--deadline-ms", second: "10" },
    },
  });
});
