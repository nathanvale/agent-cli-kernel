# A complete CLI

`moons` is a CLI with four commands. `list` has one option and no declared
station. `show` has one argument, a success station and a refusal. `visit`
is a [changing command](changing.md), and `pending` is its `ifNoResult`
command.

The kernel repository lays these files out as a repository that depends on
the `agent-cli-kernel` package, then compiles them, runs the kernel's lint
over them and runs their tests. This document is written from those files,
so copy from it freely.

Paths are from the root of your repository.

## `src/commands.ts`

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";

const moons = new Map([
  ["venus", 0],
  ["earth", 1],
  ["mars", 2],
]);

const handoffRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

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
  DOMAIN_MOONS_VISIT_HELD: handoffRow,
  DOMAIN_MOONS_VISIT_UNRESOLVED: handoffRow,
  DOMAIN_MOONS_VISIT_UNAVAILABLE: handoffRow,
  DOMAIN_MOONS_VISIT_UNCONFIRMED: {
    ...handoffRow,
    outcome: "failed",
    transactionState: "unknown",
  },
} as const satisfies CauseTable;

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
      {
        commandIdentity: "moons.list",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
      },
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
      causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
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
      {
        commandIdentity: "moons.show",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
      },
      {
        message: `${input.planet} has ${String(count)} moons.`,
        data: { planet: input.planet, moons: count },
        effects: nothingChanged,
      },
    );
  },
});

const handRepair =
  "Read pending. With no visit running, check the planet by hand, then move its case folder out of state/operations in the moons home and keep it.";

const pendingStep = {
  kind: "command",
  command: "moons.pending",
  args: [],
} as const;

export function moonsCli(home: string, opener: string) {
  const state = stateAddon({
    root: join(home, "state"),
    report: "moons.pending",
  });

  const visit = changing({
    identity: "moons.visit",
    route: ["visit"],
    summary: "Write a planet's page, then ask the opener to show it.",
    input: {
      ...noInput,
      arguments: [
        {
          name: "planet",
          summary: "A planet that the list command returns.",
          required: true,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 64,
            choices: [...moons.keys()],
            pattern: null,
          },
        },
      ],
    },
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["planet.record", "viewer.open-request"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_MOONS_VISIT_HELD",
    unresolvedCaseCause: "DOMAIN_MOONS_VISIT_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses,
        trigger: "The page was written and the opener took it.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "moons.visit:shown",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
        trigger: "The page or the open request is not confirmed.",
        repairAction: handRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "The visit started and is not confirmed.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:unconfirmed",
      }),
      ...(
        [
          [
            "DOMAIN_MOONS_VISIT_HELD",
            "Another visit to this planet is running.",
            "Wait for that visit to end, then visit again.",
          ],
          [
            "DOMAIN_MOONS_VISIT_UNRESOLVED",
            "An earlier visit to this planet never finished.",
            handRepair,
          ],
          [
            "DOMAIN_MOONS_VISIT_UNAVAILABLE",
            "The visits' state cannot take a change.",
            "Read the message, then repair the state folder in the moons home.",
          ],
        ] as const
      ).map(([causeCode, trigger, repairAction]) =>
        station(causes, {
          ...stationWords,
          commandIdentity: "moons.visit",
          causeCode,
          trigger,
          repairAction,
          guidance: {
            handoff: {
              owner: "human",
              reason: trigger,
              inspect: [pendingStep],
            },
          },
          independentObservable: `moons.visit:${causeCode}`,
        }),
      ),
    ],
    run: async (input, context) => {
      const count = moons.get(input.planet) ?? 0;
      const page = join(home, "visits", `${input.planet}.txt`);
      const text = `${input.planet} has ${String(count)} moons.\n`;
      const outcome = await state.transaction(
        context.state,
        {
          command: "moons.visit",
          scope: { resources: [{ resource: "planet", key: input.planet }] },
          facts: { planet: input.planet },
        },
        async (transaction) => {
          await transaction.record(
            "planet.record",
            async () => {
              await mkdir(join(home, "visits"), { recursive: true });
              await writeFile(page, text);
            },
            async () => (await readFile(page, "utf8")) === text,
          );
          await transaction.record(
            "viewer.open-request",
            (recorded) =>
              context.programs.domain(recorded).start({
                executable: viewer,
                args: [page],
                timeoutMilliseconds: 10_000,
                outputLimitBytes: 4_096,
                shutdownMilliseconds: 1_000,
              }),
            (opened) =>
              Promise.resolve(
                opened.exitCode === 0 && opened.terminationConfirmed,
              ),
          );
        },
      );
      if (outcome.kind !== "ran") {
        const causeCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_MOONS_VISIT_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_MOONS_VISIT_UNRESOLVED"
              : "DOMAIN_MOONS_VISIT_UNAVAILABLE";
        return context.result(
          { commandIdentity: "moons.visit", causeCode },
          {
            message: `Nothing was visited: ${outcome.kind}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      }
      if (outcome.proof.transactionState !== "completed")
        return context.result(
          {
            commandIdentity: "moons.visit",
            causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
          },
          {
            message: `The visit to ${input.planet} is not confirmed.`,
            data: null,
            transaction: outcome.proof,
          },
        );
      return context.result(
        {
          commandIdentity: "moons.visit",
          causeCode: "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses,
        },
        {
          message: `Visited ${input.planet}.`,
          data: { planet: input.planet },
          transaction: outcome.proof,
        },
      );
    },
  });

  const pending = command({
    identity: "moons.pending",
    route: ["pending"],
    summary: "List the visits that never finished.",
    input: noInput,
    capabilities: {},
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.pending",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        trigger: "The visits' state was read.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Check each unfinished visit before that planet is visited again.",
          },
        },
        independentObservable: "moons.pending:read",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.pending",
        causeCode:
          "DOMAIN_PRECONDITION_UNMET" satisfies keyof typeof commonCauses,
        trigger: "The visits' state cannot be read.",
        repairAction: "Repair or move the state folder in the moons home.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the state folder, then run this command again.",
          },
        },
        independentObservable: "moons.pending:unreadable",
      }),
    ],
    run: (_input, context) => {
      const report = state.report();
      if (!report.ok && report.reason !== "missing")
        return context.result(
          {
            commandIdentity: "moons.pending",
            causeCode:
              "DOMAIN_PRECONDITION_UNMET" satisfies keyof typeof commonCauses,
          },
          {
            message: `The visits' state is ${report.reason}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const unfinished = report.ok
        ? report.unfinished.map((entry) => ({
            operationId: entry.operationId,
            effects: entry.effects,
          }))
        : [];
      return context.result(
        {
          commandIdentity: "moons.pending",
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        {
          message: `${String(unfinished.length)} unfinished visits.`,
          data: { unfinished },
          effects: nothingChanged,
        },
      );
    },
  });

  const contract = contractFor({
    cli: "moons",
    commands: [list, show, visit, pending],
    causes,
    state: state.descriptor,
    installedAddons: ["state", "programs"],
  });
  const viewer = contract.boundary.path(opener);
  return {
    contract,
    setup: {
      addons: { programs: programsAddon() },
      emergencyRecord: state.emergencyRecord,
    },
  };
}
```

## `src/cli.ts`

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "agent-cli-kernel";
import { moonsCli } from "./commands.ts";

const { contract, setup } = moonsCli(
  process.env.MOONS_HOME ?? join(homedir(), ".moons"),
  process.env.MOONS_OPENER ?? "/usr/bin/open",
);

await runProcess(contract, setup)(process.argv.slice(2));
```

## `tests/commands.test.ts`

```ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { moonsCli } from "../src/commands.ts";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function moonsIn(home: string, opener: string) {
  const cli = moonsCli(home, opener);
  const run = runInProcess(cli.contract, cli.setup);
  return async (argv: readonly string[]) => {
    const ran = await run(argv);
    if (ran.kind !== "envelope")
      throw new Error(`Expected an envelope, got ${ran.kind}.`);
    return ran.envelope.result;
  };
}

function newHome() {
  const home = mkdtempSync(join(tmpdir(), "moons-"));
  homes.push(home);
  return home;
}

const resultOf = moonsIn(newHome(), "/usr/bin/true");

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

test("visit writes the planet's page and asks the opener to show it", async () => {
  const home = newHome();
  expect(await moonsIn(home, "/usr/bin/true")(["visit", "mars"])).toMatchObject(
    {
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      effects: { completed: ["planet.record", "viewer.open-request"] },
    },
  );
  expect(readFileSync(join(home, "visits", "mars.txt"), "utf8")).toBe(
    "mars has 2 moons.\n",
  );
});

test("a failed open leaves a case that pending lists and that blocks only that planet", async () => {
  const home = newHome();
  const failing = moonsIn(home, "/usr/bin/false");
  expect(await failing(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "failed",
    causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
    effects: {
      completed: ["planet.record"],
      uncertain: ["viewer.open-request"],
    },
  });
  expect(await failing(["pending"])).toMatchObject({
    data: {
      unfinished: [{ effects: ["planet.record", "viewer.open-request"] }],
    },
  });
  const working = moonsIn(home, "/usr/bin/true");
  expect(await working(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "refused",
    causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
  });
  expect(await working(["visit", "mars"])).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
  });
});
```

## `tests/cli.test.ts`

```ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

setDefaultTimeout(30_000);

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
  expect(ran.stdout).toBe(
    [
      "mars has 2 moons.",
      "{",
      '  "planet": "mars",',
      '  "moons": 2',
      "}",
      "",
    ].join("\n"),
  );
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
$ bun src/cli.ts show --help
moons.show (inspect)
Show how many moons one planet has.
Route: show
Arguments:
  planet <string, length 1 to 64>  required  The planet's name, in lower case.
Options:
  (none)
Possible results:
  success SUCCESS_UNCHANGED  The planet is one this CLI knows.
  refused DOMAIN_MOONS_UNKNOWN_PLANET  The planet is not one this CLI knows.
  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.
  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.
  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.
  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.
```
