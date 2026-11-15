import { expect, test } from "bun:test";
import {
  command,
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
    run: () => null,
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
      run: () => null,
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
    run: () => null,
  });
  const contract = contractFor({ cli: "items", commands: [hostile] });
  const start = performance.now();
  expect(
    await contract.parse("items.hostile", [`${"a".repeat(100)}!`]),
  ).toMatchObject({ ok: false, reason: "pattern budget" });
  expect(performance.now() - start).toBeLessThan(2000);
});
