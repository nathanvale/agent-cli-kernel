import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stateAddon } from "../../kernel/src/addons/state/index.ts";
import { renderHuman } from "../../kernel/src/kernel/human.ts";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { CauseTable, Envelope } from "../../kernel/src/kernel/index.ts";
import { testFolder } from "../support/test-folder.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput } from "./kernel-repair/shapes.ts";

const stateRoot = testFolder("discover-all-state-");
afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

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
  TRANSIENT_CATALOG_BUSY: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "transient",
    exitCode: 75,
    retryable: true,
    guidance: "next",
  },
  DOMAIN_CATALOG_IMPOSSIBLE: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_CATALOG_HELD: handoffRow,
  DOMAIN_CATALOG_UNRESOLVED: handoffRow,
} as const satisfies CauseTable;

const state = stateAddon({
  root: join(stateRoot, "state"),
  report: "catalog.pending",
});

const showCommand = command({
  identity: "catalog.show",
  route: ["show"],
  summary: "Show one catalog item.",
  input: {
    ...emptyInput,
    arguments: [
      {
        name: "item",
        summary: "Item name.",
        required: true,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 32,
          choices: null,
          pattern: null,
        },
      },
    ],
  },
  capabilities: {},
  stations: [
    station(causes, {
      commandIdentity: "catalog.show",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Item found.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.show:ok",
    }),
    station(causes, {
      commandIdentity: "catalog.show",
      causeCode: "TRANSIENT_CATALOG_BUSY",
      trigger: "Catalog index is temporarily busy.",
      guidance: { next: { kind: "retry" } },
      repairAction: "Retry after the bounded delay.",
      retryDelayPolicy: {
        kind: "bounded",
        minimumMilliseconds: 100,
        maximumMilliseconds: 1000,
      },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.show:busy",
    }),
    station(causes, {
      commandIdentity: "catalog.show",
      causeCode: "DOMAIN_CATALOG_IMPOSSIBLE",
      trigger: "Impossible state in read-only mode.",
      guidance: {
        next: { kind: "instruction", text: "Check the catalog configuration." },
      },
      repairAction: "Verify the catalog mode.",
      retryDelayPolicy: { kind: "none" },
      reachability: "declared-unreachable",
      unreachableRationale: "Read-only catalog mode cannot enter this branch.",
      independentObservable: "catalog.show:impossible",
    }),
  ],
  run: readsUnchanged("catalog.show"),
});

const pendingCommand = command({
  identity: "catalog.pending",
  route: ["pending"],
  summary: "List unfinished catalog changes.",
  input: emptyInput,
  capabilities: {},
  stations: [
    station(causes, {
      commandIdentity: "catalog.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Listed unfinished changes.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Inspect each unfinished change before retrying.",
        },
      },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.pending:ok",
    }),
  ],
  run: readsUnchanged("catalog.pending"),
});

const writeCommand = changing({
  identity: "catalog.write",
  route: ["write"],
  summary: "Write one catalog item.",
  effectClass: "repository-local",
  effects: ["catalog.entry"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_CATALOG_HELD",
  unresolvedCaseCause: "DOMAIN_CATALOG_UNRESOLVED",
  input: emptyInput,
  capabilities: {},
  stations: [
    station(causes, {
      commandIdentity: "catalog.write",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Catalog item written.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.write:ok",
    }),
    station(causes, {
      commandIdentity: "catalog.write",
      causeCode: "DOMAIN_CATALOG_HELD",
      trigger: "Another catalog write holds the coordination lock.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "Another write is active.",
          inspect: [{ kind: "command", command: "catalog.pending", args: [] }],
        },
      },
      repairAction: "Wait for the active write to finish.",
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.write:held",
    }),
    station(causes, {
      commandIdentity: "catalog.write",
      causeCode: "DOMAIN_CATALOG_UNRESOLVED",
      trigger: "An earlier catalog write did not finish.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "An earlier write is unresolved.",
          inspect: [{ kind: "command", command: "catalog.pending", args: [] }],
        },
      },
      repairAction: "Inspect unfinished writes before retrying.",
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "catalog.write:unresolved",
    }),
  ],
  run: async (_input, context) =>
    Promise.resolve(
      context.result(
        {
          commandIdentity: "catalog.write",
          causeCode: "DOMAIN_CATALOG_HELD",
        },
        {
          message: "Another write holds the coordination lock.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
    ),
});

const contract = contractFor({
  cli: "catalog",
  causes,
  installedAddons: ["state"],
  state: state.descriptor,
  commands: [showCommand, pendingCommand, writeCommand],
});

async function runEnvelope(argv: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly envelope: Envelope;
}> {
  const ran = await runInProcess(contract)(argv);
  expect(ran.kind).toBe("envelope");
  if (ran.kind !== "envelope") throw new Error("Expected an envelope.");
  return { exitCode: ran.exitCode, envelope: ran.envelope };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object record.");
  return Object.fromEntries(Object.entries(value));
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an array.");
  return value.map(asRecord);
}

function stripProse(stationItem: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(stationItem).filter(
      ([key]) =>
        key !== "trigger" && key !== "guidance" && key !== "repairAction",
    ),
  );
}

describe("--discover-all full discovery route", () => {
  test("returns every command and matches --discover-command with only trigger, guidance and repairAction removed", async () => {
    const all = await runEnvelope(["--discover-all", "--json"]);
    expect(all.exitCode).toBe(0);
    expect(all.envelope.result.commandIdentity).toBe("catalog.full-discovery");
    expect(all.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    const data = asRecord(all.envelope.result.data);
    expect(data.contractVersion).toBe("3.0.0");
    expect(data.stationProseSource).toBe(
      "Run --discover-command <identity> for trigger, guidance and repairAction.",
    );
    const commands = asRecords(data.commands);
    const listedIdentities = commands.map(
      (entry) => asRecord(entry.command).commandIdentity,
    );
    expect(listedIdentities).toEqual([
      "catalog.command-discovery",
      "catalog.discovery",
      "catalog.dispatch",
      "catalog.full-discovery",
      "catalog.help",
      "catalog.pending",
      "catalog.show",
      "catalog.version",
      "catalog.write",
    ]);

    const one = await runEnvelope([
      "--discover-command",
      "catalog.show",
      "--json",
    ]);
    expect(one.exitCode).toBe(0);
    const oneData = asRecord(one.envelope.result.data);
    const expectedFromOne = {
      ...oneData,
      stations: asRecords(oneData.stations).map(stripProse),
    };
    const showFromAll = commands.find(
      (entry) => asRecord(entry.command).commandIdentity === "catalog.show",
    );
    expect(showFromAll).toEqual(expectedFromOne);
  });

  test("keeps retryDelayPolicy bounds, reachability, unreachableRationale and ifNoResult", async () => {
    const all = await runEnvelope(["--discover-all", "--json"]);
    const data = asRecord(all.envelope.result.data);
    const commands = asRecords(data.commands);

    const showEntry = commands.find(
      (entry) => asRecord(entry.command).commandIdentity === "catalog.show",
    );
    if (!showEntry) throw new Error("Expected catalog.show entry.");
    const showStations = asRecords(showEntry.stations);
    const busy = showStations.find(
      (item) => item.causeCode === "TRANSIENT_CATALOG_BUSY",
    );
    expect(busy).toEqual({
      commandIdentity: "catalog.show",
      causeCode: "TRANSIENT_CATALOG_BUSY",
      outcome: "refused",
      transactionState: "unchanged",
      failureClass: "transient",
      exitCode: 75,
      retryable: true,
      retryDelayPolicy: {
        kind: "bounded",
        minimumMilliseconds: 100,
        maximumMilliseconds: 1000,
      },
      reachability: "required",
      unreachableRationale: null,
      effectClass: "inspect",
    });

    const impossible = showStations.find(
      (item) => item.causeCode === "DOMAIN_CATALOG_IMPOSSIBLE",
    );
    expect(impossible).toEqual({
      commandIdentity: "catalog.show",
      causeCode: "DOMAIN_CATALOG_IMPOSSIBLE",
      outcome: "refused",
      transactionState: "unchanged",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      retryDelayPolicy: { kind: "none" },
      reachability: "declared-unreachable",
      unreachableRationale: "Read-only catalog mode cannot enter this branch.",
      effectClass: "inspect",
    });

    const writeEntry = commands.find(
      (entry) => asRecord(entry.command).commandIdentity === "catalog.write",
    );
    if (!writeEntry) throw new Error("Expected catalog.write entry.");
    expect(writeEntry.ifNoResult).toEqual({
      kind: "command",
      command: "catalog.pending",
      args: [],
    });
  });

  test("validator accepts any order of commands and stations and declines prose fields or missing station fields", async () => {
    const all = await runEnvelope(["--discover-all", "--json"]);
    const baseData = asRecord(all.envelope.result.data);
    const baseCommands = asRecords(baseData.commands);

    const reordered = {
      ...all.envelope,
      result: {
        ...all.envelope.result,
        data: {
          ...baseData,
          commands: [...baseCommands].reverse().map((entry) => ({
            ...entry,
            stations: [...asRecords(entry.stations)].reverse(),
          })),
        },
      },
    };
    expect(await contract.validate(reordered)).toMatchObject({ ok: true });

    for (const [proseKey, proseValue] of [
      ["trigger", "Item found."],
      ["guidance", { next: { kind: "done" } }],
      ["repairAction", null],
    ] as const) {
      const withProse = {
        ...all.envelope,
        result: {
          ...all.envelope.result,
          data: {
            ...baseData,
            commands: baseCommands.map((entry) =>
              asRecord(entry.command).commandIdentity === "catalog.show"
                ? {
                    ...entry,
                    stations: asRecords(entry.stations).map((item) =>
                      item.causeCode === "SUCCESS_UNCHANGED"
                        ? { ...item, [proseKey]: proseValue }
                        : item,
                    ),
                  }
                : entry,
            ),
          },
        },
      };
      expect(await contract.validate(withProse)).toEqual({
        ok: false,
        path: "result.data",
        reason: "invalid navigation data",
      });
    }

    for (const droppedKey of [
      "retryDelayPolicy",
      "reachability",
      "unreachableRationale",
      "transactionState",
      "failureClass",
      "commandIdentity",
      "effectClass",
    ] as const) {
      const missingField = {
        ...all.envelope,
        result: {
          ...all.envelope.result,
          data: {
            ...baseData,
            commands: baseCommands.map((entry) =>
              asRecord(entry.command).commandIdentity === "catalog.show"
                ? {
                    ...entry,
                    stations: asRecords(entry.stations).map((item) =>
                      item.causeCode === "TRANSIENT_CATALOG_BUSY"
                        ? Object.fromEntries(
                            Object.entries(item).filter(
                              ([key]) => key !== droppedKey,
                            ),
                          )
                        : item,
                    ),
                  }
                : entry,
            ),
          },
        },
      };
      expect(await contract.validate(missingField)).toEqual({
        ok: false,
        path: "result.data",
        reason: "invalid navigation data",
      });
    }
  });

  test("--discover and --discover-command stay unchanged except for listing catalog.full-discovery", async () => {
    const index = await runEnvelope(["--discover", "--json"]);
    expect(index.exitCode).toBe(0);
    expect(index.envelope.result.commandIdentity).toBe("catalog.discovery");
    const indexData = asRecord(index.envelope.result.data);
    expect(indexData.contractVersion).toBe("3.0.0");
    expect(asRecords(indexData.commands)).toEqual([
      {
        commandIdentity: "catalog.command-discovery",
        route: ["--discover-command"],
        summary: "Discover one command.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.discovery",
        route: ["--discover"],
        summary: "Discover commands.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.dispatch",
        route: [],
        summary: "Resolve an invocation.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.full-discovery",
        route: ["--discover-all"],
        summary: "Discover all commands.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.help",
        route: ["--help"],
        summary: "Show help.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.pending",
        route: ["pending"],
        summary: "List unfinished catalog changes.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.show",
        route: ["show"],
        summary: "Show one catalog item.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.version",
        route: ["--version"],
        summary: "Show the version.",
        effectClass: "inspect",
      },
      {
        commandIdentity: "catalog.write",
        route: ["write"],
        summary: "Write one catalog item.",
        effectClass: "repository-local",
      },
    ]);

    const one = await runEnvelope([
      "--discover-command",
      "catalog.show",
      "--json",
    ]);
    expect(one.exitCode).toBe(0);
    expect(one.envelope.result.commandIdentity).toBe(
      "catalog.command-discovery",
    );
    const showStations = asRecords(asRecord(one.envelope.result.data).stations);
    const okStation = showStations.find(
      (item) => item.causeCode === "SUCCESS_UNCHANGED",
    );
    expect(okStation).toMatchObject({
      trigger: "Item found.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
    });
  });

  test("--discover-all with an extra argument is a usage refusal like --discover", async () => {
    const extra = await runEnvelope([
      "--discover-all",
      "catalog.show",
      "--json",
    ]);
    expect(extra.exitCode).toBe(2);
    expect(extra.envelope.result.commandIdentity).toBe("catalog.dispatch");
    expect(extra.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(extra.envelope.message).toBe(
      "Give --help, -h, --version, --discover or --discover-all alone, or --discover-command with one command identity.",
    );

    const afterRoute = await runEnvelope(["show", "--discover-all", "--json"]);
    expect(afterRoute.exitCode).toBe(2);
    expect(afterRoute.envelope.result.commandIdentity).toBe("catalog.dispatch");
    expect(afterRoute.envelope.result.causeCode).toBe(
      "USAGE_INVALID_INVOCATION",
    );
    expect(afterRoute.envelope.message).toBe(
      "Give --help, -h, --version, --discover or --discover-all alone, or --discover-command with one command identity.",
    );

    const conflict = await runEnvelope([
      "--discover",
      "--discover-all",
      "--json",
    ]);
    expect(conflict.exitCode).toBe(2);
    expect(conflict.envelope.result.commandIdentity).toBe("catalog.dispatch");
    expect(conflict.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(conflict.envelope.message).toBe(
      "Use only one of --help, -h, --version, --discover, --discover-all and --discover-command.",
    );
  });

  test("human output for --discover-all matches --discover one line per command", async () => {
    const index = await runEnvelope(["--discover", "--json"]);
    const all = await runEnvelope(["--discover-all", "--json"]);
    expect(renderHuman("catalog", all.envelope)).toEqual(
      renderHuman("catalog", index.envelope),
    );
  });
});
