# A complete CLI

`moons` is a read-only CLI with two commands. `list` has one option and no
declared station. `show` has one argument, a success station and a refusal.

The kernel repository builds a repository from these files and its stamped
folders, then compiles them, runs the stamped lint over them and runs their
tests. This document is written from those files, so copy from it freely.

Paths are from the root of your repository.

## `src/commands.ts`

```ts
import { command, commonCauses, contractFor, station } from "./kernel/index.ts";
import type { CauseTable } from "./kernel/index.ts";

const moons = new Map([
  ["venus", 0],
  ["earth", 1],
  ["mars", 2],
]);

const causes = {
  ...commonCauses,
  DOMAIN_MOONS_UNKNOWN_PLANET: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

const success = "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const list = command({
  identity: "moons.list",
  route: ["list"],
  summary: "List the planets this CLI knows.",
  input: {
    ...noInput,
    options: [
      {
        name: "--at-least",
        aliases: [],
        summary: "Only planets with at least this many moons.",
        required: false,
        repeatable: false,
        value: { kind: "integer", minimum: 0, maximum: 1000 },
      },
    ],
  },
  capabilities: {},
  run: (input, context) => {
    const atLeast = input["--at-least"] ?? 0;
    const planets = [...moons]
      .filter(([, count]) => count >= atLeast)
      .map(([planet]) => planet);
    return context.result(
      { commandIdentity: "moons.list", causeCode: success },
      {
        message: `${String(planets.length)} planets.`,
        data: { planets },
        effects: nothingChanged,
      },
    );
  },
});

const show = command({
  identity: "moons.show",
  route: ["show"],
  summary: "Show how many moons one planet has.",
  input: {
    ...noInput,
    arguments: [
      {
        name: "planet",
        summary: "The planet's name, in lower case.",
        required: true,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 64,
          choices: null,
          pattern: null,
        },
      },
    ],
  },
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity: "moons.show",
      causeCode: success,
      trigger: "The planet is one this CLI knows.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "moons.show:known-planet",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: "moons.show",
      causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
      trigger: "The planet is not one this CLI knows.",
      repairAction: "Use a planet that the list command returns.",
      guidance: {
        next: { kind: "command", command: "moons.list", args: [] },
      },
      independentObservable: "moons.show:unknown-planet",
    }),
  ],
  run: (input, context) => {
    const count = moons.get(input.planet);
    if (count === undefined)
      return context.result(
        {
          commandIdentity: "moons.show",
          causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
        },
        {
          message: `No planet named ${input.planet}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    return context.result(
      { commandIdentity: "moons.show", causeCode: success },
      {
        message: `${input.planet} has ${String(count)} moons.`,
        data: { planet: input.planet, moons: count },
        effects: nothingChanged,
      },
    );
  },
});

export const contract = contractFor({
  cli: "moons",
  commands: [list, show],
  causes,
});
```

## `src/cli.ts`

```ts
import { runProcess } from "./kernel/index.ts";
import { contract } from "./commands.ts";

await runProcess(contract)(process.argv.slice(2));
```

## `tests/commands.test.ts`

```ts
import { expect, test } from "bun:test";
import { runInProcess } from "../src/kernel/index.ts";
import { contract } from "../src/commands.ts";

const run = runInProcess(contract);

async function resultOf(argv: readonly string[]) {
  const ran = await run(argv);
  if (ran.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${ran.kind}.`);
  return ran.envelope.result;
}

test("list returns every planet, or only those with enough moons", async () => {
  expect(await resultOf(["list"])).toMatchObject({
    exitCode: 0,
    causeCode: "SUCCESS_UNCHANGED",
    data: { planets: ["venus", "earth", "mars"] },
  });
  expect(await resultOf(["list", "--at-least", "2"])).toMatchObject({
    data: { planets: ["mars"] },
  });
});

test("show returns a known planet's moons", async () => {
  expect(await resultOf(["show", "mars"])).toMatchObject({
    exitCode: 0,
    causeCode: "SUCCESS_UNCHANGED",
    data: { planet: "mars", moons: 2 },
  });
});

test("show refuses a planet it does not know and points at list", async () => {
  expect(await resultOf(["show", "pluto"])).toMatchObject({
    exitCode: 3,
    outcome: "refused",
    causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
    data: null,
    next: { kind: "command", command: "moons.list", args: [] },
  });
});
```

## `tests/cli.test.ts`

```ts
import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

function invoke(...argv: string[]) {
  const ran = Bun.spawnSync([process.execPath, cli, ...argv], {
    timeout: 20_000,
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

test("show --json writes one envelope to stdout and exits 0", () => {
  const ran = invoke("show", "mars", "--json");
  const envelope: unknown = JSON.parse(ran.stdout);
  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(envelope).toMatchObject({
    contractVersion: "3.0.0",
    result: {
      commandIdentity: "moons.show",
      causeCode: "SUCCESS_UNCHANGED",
      data: { planet: "mars", moons: 2 },
    },
  });
});

test("show without --json prints the message, then the data", () => {
  const ran = invoke("show", "mars");
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout).toStartWith("mars has 2 moons.\n");
});

test("a refusal exits with its cause's code and writes one line to stderr", () => {
  const ran = invoke("show", "pluto");
  expect(ran.exitCode).toBe(3);
  expect(ran.stdout).toBe("");
  expect(ran.stderr).toBe(
    "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n",
  );
});

test("list runs through the real entry", () => {
  const ran = invoke("list", "--at-least", "1", "--json");
  const envelope: unknown = JSON.parse(ran.stdout);
  expect(ran.exitCode).toBe(0);
  expect(envelope).toMatchObject({
    result: { data: { planets: ["earth", "mars"] } },
  });
});
```

## Try it

```text
$ bun src/cli.ts show mars
mars has 2 moons.
{
  "planet": "mars",
  "moons": 2
}
$ bun src/cli.ts show pluto
moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]
$ bun src/cli.ts --discover-command moons.show
moons.show (inspect)
Show how many moons one planet has.
Route: show
Possible results:
  success SUCCESS_UNCHANGED  The planet is one this CLI knows.
  refused DOMAIN_MOONS_UNKNOWN_PLANET  The planet is not one this CLI knows.
  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.
  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.
  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.
  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.
```
