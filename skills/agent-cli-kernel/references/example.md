# A complete CLI

`moons` is a CLI with four commands. `list` has one option and no declared
station. `show` has one argument, a success station and a refusal. `visit`
is a [changing command](changing.md), and `pending` is its `ifNoResult`
command. Its tests live in [example tests](example-tests.md).

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
import {
  programDetails,
  programsAddon,
} from "agent-cli-kernel/addons/programs";
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
  DOMAIN_MOONS_VISIT_NOT_OPENED: {
    ...handoffRow,
    outcome: "failed",
    transactionState: "completed",
  },
  DOMAIN_MOONS_VISIT_PARTIAL: {
    ...handoffRow,
    outcome: "failed",
    transactionState: "partially-completed",
  },
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

const unresolvedRepair =
  "Run pending to see the planet and operation id, then check that planet's page and viewer by hand. That planet stays blocked until a qualified close exists.";

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
    effects: ["planet.record", "viewer.launch"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_MOONS_VISIT_HELD",
    unresolvedCaseCause: "DOMAIN_MOONS_VISIT_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses,
        trigger: "The page was written and the opener exited 0.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "moons.visit:shown",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_NOT_OPENED",
        trigger: "The page was written and the opener exited non-zero.",
        repairAction:
          "Check the opener and the planet's page, then visit the planet again.",
        guidance: {
          handoff: {
            owner: "human",
            reason: "The opener exited non-zero.",
            inspect: [
              {
                kind: "instruction",
                text: "Check the opener and the planet's page, then visit the planet again.",
              },
            ],
          },
        },
        independentObservable: "moons.visit:not-opened",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_PARTIAL",
        trigger: "The page was written, and the launch did not start.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "The visit stopped before the launch started.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:partial",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
        trigger: "The page or the launch is not confirmed.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "The visit started and is not confirmed.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:unconfirmed",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_HELD",
        trigger: "Another visit to this planet is running.",
        repairAction: "Wait for that visit to end, then visit again.",
        guidance: {
          handoff: {
            owner: "human",
            reason: "Another visit to this planet is running.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:held",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
        trigger: "An earlier visit to this planet never finished.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "An earlier visit to this planet never finished.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:unresolved",
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: "moons.visit",
        causeCode: "DOMAIN_MOONS_VISIT_UNAVAILABLE",
        trigger: "The visits' state cannot take a change.",
        repairAction:
          "Read the message, then repair the state folder in the moons home.",
        guidance: {
          handoff: {
            owner: "human",
            reason: "The visits' state cannot take a change.",
            inspect: [pendingStep],
          },
        },
        independentObservable: "moons.visit:unavailable",
      }),
    ],
    run: async (input, context) => {
      const count = moons.get(input.planet) ?? 0;
      const page = join(home, "visits", `${input.planet}.txt`);
      const text = `${input.planet} has ${String(count)} moons.\n`;
      let exitCode: number | null = null;
      const outcome = await state.transaction(
        context.state,
        {
          command: "moons.visit",
          scope: { resources: [{ resource: "planet", key: input.planet }] },
          facts: { planet: input.planet },
        },
        async (transaction) => {
          let pageConfirmed = false;
          await transaction.record(
            "planet.record",
            async () => {
              await mkdir(join(home, "visits"), { recursive: true });
              await writeFile(page, text);
            },
            async () => {
              pageConfirmed = (await readFile(page, "utf8")) === text;
              return pageConfirmed;
            },
          );
          if (!pageConfirmed) return;
          const launched = await transaction.record(
            "viewer.launch",
            (recorded) =>
              context.programs.domain(recorded).start({
                executable: viewer,
                args: [page],
                timeoutMilliseconds: 10_000,
                outputLimitBytes: 4_096,
                shutdownMilliseconds: 1_000,
              }),
            (result) => {
              const details = programDetails(result);
              return Promise.resolve(
                !context.signal.aborted &&
                  result.exitCode !== null &&
                  result.terminationConfirmed &&
                  details !== undefined &&
                  !details.timedOut,
              );
            },
          );
          exitCode = launched.exitCode;
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
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          {
            commandIdentity: "moons.visit",
            causeCode: "DOMAIN_MOONS_VISIT_UNAVAILABLE",
          },
          {
            message: `Nothing was visited for ${input.planet}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState === "partially-completed")
        return context.result(
          {
            commandIdentity: "moons.visit",
            causeCode: "DOMAIN_MOONS_VISIT_PARTIAL",
          },
          {
            message: `The visit to ${input.planet} wrote the page, then stopped before launch.`,
            data: null,
            transaction: outcome.proof,
          },
        );
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
      if (exitCode !== 0)
        return context.result(
          {
            commandIdentity: "moons.visit",
            causeCode: "DOMAIN_MOONS_VISIT_NOT_OPENED",
          },
          {
            message: `The opener exited ${String(exitCode)} for ${input.planet}.`,
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
        repairAction:
          "Read the message and repair the state folder in the moons home.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the state folder, then run this command again.",
          },
        },
        independentObservable: "moons.pending:unreadable",
      }),
    ],
    run: async (_input, context) => {
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
        ? await Promise.all(
            report.unfinished.map(async (entry) => {
              const record = await state.history(entry.operationId);
              const key = record.ok
                ? record.history.scope.resources.find(
                    (item) => item.resource === "planet",
                  )?.keys[0]
                : undefined;
              return {
                operationId: entry.operationId,
                planet: key?.startsWith("key:") ? key.slice(4) : null,
                effects: entry.effects,
              };
            }),
          )
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
