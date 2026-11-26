import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import {
  causeRow,
  wireResult,
} from "../../kernel/src/kernel/validation/result.ts";
import { testFolder } from "../support/test-folder.ts";
import { emptyInput as input, unchanged } from "./kernel-repair/shapes.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import {
  processWatchdog,
  spawnBounded,
} from "./kernel-repair/swarm-process.ts";
import { probeBatch } from "./locks/lock-probes.ts";

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
    "notes.full-discovery",
    "notes.help",
    "notes.list",
    "notes.version",
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

const invalidCauseRowMessage =
  "Invalid cause row. Repair: declare outcome, transactionState, failureClass, exitCode, retryable and guidance matching Command Contract 3; carriesData: true is allowed only on an unchanged domain refusal.";

const invalidStrictStationMessage =
  "Station is not a strict declared station. Repair: declare a strict station with a cause row matching Command Contract 3; carriesData: true is allowed only on an unchanged domain refusal.";

const carriesDataRow = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
  carriesData: true,
} as const;

const typeProbe = probeBatch("kernel-carries-data-types-");
const kernelEntry = join(
  resolve(import.meta.dir, "../.."),
  "kernel/src/kernel/index.ts",
);
const typeHeader = [
  `import { command, commonCauses, contractFor, station } from ${JSON.stringify(kernelEntry)};`,
  `import type { CauseTable } from ${JSON.stringify(kernelEntry)};`,
  "const empty = { arguments: [], options: [], constraints: [], deadlineSupported: false, additionalArguments: false, additionalOptions: false } as const;",
  "const unchanged = { completed: [], remaining: [], uncertain: [], inventoryComplete: true } as const;",
  'const words = { trigger: "Triggered.", repairAction: "Fix it.", retryDelayPolicy: { kind: "none" }, reachability: "required", unreachableRationale: null, independentObservable: "obs" } as const;',
].join("\n");

const plainRefusalWithDataProbe = typeProbe(
  [
    typeHeader,
    'const plain = station(commonCauses, { ...words, commandIdentity: "notes.check", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "instruction", text: "Fix it." } } });',
    'export const check = command({ identity: "notes.check", route: ["check"], summary: "Check.", input: empty, capabilities: {}, stations: [plain], run: (_input, context) => context.result(plain, { message: "Refused.", data: { findings: ["a"] }, effects: unchanged }) });',
  ].join("\n"),
);

const carriesDataValidProbe = typeProbe(
  [
    typeHeader,
    'const causes = { ...commonCauses, DOMAIN_FINDINGS: { outcome: "refused", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "next", carriesData: true } } as const satisfies CauseTable;',
    'const findings = station(causes, { ...words, commandIdentity: "notes.check", causeCode: "DOMAIN_FINDINGS", guidance: { next: { kind: "instruction", text: "Fix it." } } });',
    'const plain = station(causes, { ...words, commandIdentity: "notes.check", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "instruction", text: "Fix it." } } });',
    'export const check = command({ identity: "notes.check", route: ["check"], summary: "Check.", input: empty, capabilities: {}, stations: [findings, plain], run: (_input, context) => context.result(findings, { message: "Found.", data: { findings: ["a"] }, effects: unchanged }) });',
    'export const contract = contractFor({ cli: "notes", commands: [check], causes });',
    'export const built = contract.build(plain, { runId: "r", message: "Plain.", data: null, effects: unchanged });',
  ].join("\n"),
);

const illegalCauseTableProbes = [
  {
    name: "success",
    row: '{ outcome: "success", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "failed",
    row: '{ outcome: "failed", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "refused-usage",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "refused-schema",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "transient",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true, guidance: "next", carriesData: true }',
  },
].map(({ name, row }) => ({
  name,
  probe: typeProbe(
    `${typeHeader}\nexport const bad = { ...commonCauses, BAD: ${row} } as const satisfies CauseTable;\n`,
  ),
}));

const illegalAliasedCauseTableProbes = [
  {
    name: "alias-success-unchanged",
    row: '{ outcome: "success", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "alias-success-completed",
    row: '{ outcome: "success", transactionState: "completed", failureClass: null, exitCode: 0, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "alias-failed-unchanged",
    row: '{ outcome: "failed", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "alias-failed-completed",
    row: '{ outcome: "failed", transactionState: "completed", failureClass: "internal", exitCode: 1, retryable: false, guidance: "handoff", carriesData: true }',
  },
  {
    name: "alias-failed-partially-completed",
    row: '{ outcome: "failed", transactionState: "partially-completed", failureClass: "internal", exitCode: 1, retryable: false, guidance: "handoff", carriesData: true }',
  },
  {
    name: "alias-failed-unknown",
    row: '{ outcome: "failed", transactionState: "unknown", failureClass: "internal", exitCode: 1, retryable: false, guidance: "handoff", carriesData: true }',
  },
  {
    name: "alias-refused-usage",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "alias-refused-schema",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "schema", exitCode: 4, retryable: false, guidance: "next", carriesData: true }',
  },
  {
    name: "alias-transient",
    row: '{ outcome: "refused", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true, guidance: "next", carriesData: true }',
  },
].map(({ name, row }) => ({
  name,
  probe: typeProbe(
    `${typeHeader}\nconst row = ${row} as const;\nexport const bad = { ...commonCauses, BAD: row } as const satisfies CauseTable;\n`,
  ),
}));

const typeProbeTimeout = typeProbe.timeout();

test("causeRow and contractFor accept carriesData: true only on an unchanged domain refusal and refuse every other row kind", () => {
  expect(causeRow(carriesDataRow)).toBe(true);
  expect(causeRow({ ...carriesDataRow, guidance: "handoff" })).toBe(true);

  const illegalRows: readonly Record<string, unknown>[] = [
    { ...commonCauses.SUCCESS_UNCHANGED, carriesData: true },
    { ...commonCauses.SUCCESS_COMPLETED, carriesData: true },
    { ...commonCauses.INTERNAL_RESULT_UNCHANGED, carriesData: true },
    { ...commonCauses.INTERNAL_RESULT_COMPLETED, carriesData: true },
    { ...commonCauses.INTERNAL_RESULT_PARTIAL, carriesData: true },
    { ...commonCauses.INTERNAL_RESULT_UNKNOWN, carriesData: true },
    {
      outcome: "failed",
      transactionState: "unchanged",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      guidance: "next",
      carriesData: true,
    },
    { ...commonCauses.USAGE_INVALID_INVOCATION, carriesData: true },
    { ...commonCauses.SCHEMA_INVALID_INPUT, carriesData: true },
    { ...commonCauses.INTERNAL_PREPARATION, carriesData: true },
    { ...commonCauses.TRANSIENT_NOT_STARTED, carriesData: true },
    {
      outcome: "failed",
      transactionState: "unchanged",
      failureClass: "transient",
      exitCode: 75,
      retryable: true,
      guidance: "next",
      carriesData: true,
    },
    { ...commonCauses.DOMAIN_PRECONDITION_UNMET, carriesData: false },
    { ...commonCauses.DOMAIN_PRECONDITION_UNMET, carriesData: undefined },
  ];
  for (const row of illegalRows) {
    expect(causeRow(row)).toBe(false);
    expect(() => {
      Reflect.apply(contractFor, undefined, [
        { cli: "notes", commands: [], causes: { BAD_ROW: row } },
      ]);
    }).toThrow(invalidCauseRowMessage);
    expect(() => {
      Reflect.apply(station, undefined, [
        { ...commonCauses, BAD_ROW: row },
        {
          commandIdentity: "notes.check",
          causeCode: "BAD_ROW",
          trigger: "Triggered.",
          guidance: { next: { kind: "instruction", text: "Fix it." } },
          repairAction: "Fix it.",
          retryDelayPolicy: { kind: "none" },
          reachability: "required",
          unreachableRationale: null,
          independentObservable: "obs",
        },
      ]);
    }).toThrow(invalidCauseRowMessage);
  }
  const plainRefused = station(commonCauses, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    trigger: "Precondition failed.",
    guidance: { next: { kind: "instruction", text: "Fix it." } },
    repairAction: "Fix it.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "precondition-failed",
  });
  const baseCommand = command({
    capabilities: {},
    identity: "notes.check",
    route: ["check"],
    summary: "Check notes.",
    input,
    stations: [plainRefused],
    run: () => Promise.reject(new Error("The handler never runs here.")),
  });
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "notes",
        commands: [
          {
            ...baseCommand,
            stations: [
              {
                ...plainRefused,
                row: {
                  ...commonCauses.USAGE_INVALID_INVOCATION,
                  carriesData: true,
                },
              },
            ],
          },
        ],
      },
    ]);
  }).toThrow(invalidStrictStationMessage);
});

test("contractFor refuses replacing a common cause row with carriesData", () => {
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "notes",
        commands: [],
        causes: {
          DOMAIN_PRECONDITION_UNMET: carriesDataRow,
        },
      },
    ]);
  }).toThrow("Common cause rows cannot be replaced.");
});

test("contractFor refuses a station whose row disagrees with the CLI cause owner on carriesData", () => {
  const plainRefused = station(commonCauses, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    trigger: "Precondition failed.",
    guidance: { next: { kind: "instruction", text: "Fix it." } },
    repairAction: "Fix it.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "precondition-failed",
  });
  const baseCommand = command({
    capabilities: {},
    identity: "notes.check",
    route: ["check"],
    summary: "Check notes.",
    input,
    stations: [plainRefused],
    run: () => Promise.reject(new Error("The handler never runs here.")),
  });
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "notes",
        commands: [
          {
            ...baseCommand,
            stations: [{ ...plainRefused, row: carriesDataRow }],
          },
        ],
      },
    ]);
  }).toThrow("Station disagrees with the CLI cause owner.");

  const causes = {
    ...commonCauses,
    DOMAIN_FINDINGS: carriesDataRow,
  } as const;
  const findingsRefused = station(causes, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_FINDINGS",
    trigger: "Findings detected.",
    guidance: { next: { kind: "instruction", text: "Fix it." } },
    repairAction: "Fix it.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "findings-detected",
  });
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "notes",
        causes,
        commands: [
          {
            ...baseCommand,
            stations: [
              {
                ...findingsRefused,
                row: commonCauses.DOMAIN_PRECONDITION_UNMET,
              },
            ],
          },
        ],
      },
    ]);
  }).toThrow("Station disagrees with the CLI cause owner.");
});

test("runtime result builder refuses non-null data on a refused row without carriesData and accepts it when carriesData is true", async () => {
  const causes = {
    ...commonCauses,
    DOMAIN_FINDINGS: carriesDataRow,
  } as const;
  const plainRefused = station(causes, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    trigger: "Precondition failed.",
    guidance: { next: { kind: "instruction", text: "Fix precondition." } },
    repairAction: "Fix precondition.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "precondition-failed",
  });
  const findingsRefused = station(causes, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_FINDINGS",
    trigger: "Check reported findings.",
    guidance: {
      next: { kind: "instruction", text: "Fix each reported finding." },
    },
    repairAction: "Fix each reported finding.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "findings-reported",
  });
  const check = command({
    capabilities: {},
    identity: "notes.check",
    route: ["check"],
    summary: "Check notes.",
    input,
    stations: [plainRefused, findingsRefused],
    run: (_input, context) =>
      context.result(findingsRefused, {
        message: "Two findings.",
        data: { findings: ["a", "b"] },
        effects: unchanged,
      }),
  });
  const contract = contractFor({ cli: "notes", commands: [check], causes });

  const untypedRejected: unknown = await Reflect.apply(
    contract.build.bind(contract),
    contract,
    [
      plainRefused,
      {
        runId: "run-1",
        message: "Refused with leaked data.",
        data: { leaked: true },
        effects: unchanged,
      },
    ],
  );
  expect(untypedRejected).toEqual({
    ok: false,
    path: "facts.data",
    reason: "non-null data requires a success row or carriesData: true",
  });

  const plainOk = await contract.build(plainRefused, {
    runId: "run-2",
    message: "Plain refusal.",
    data: null,
    effects: unchanged,
  });
  expect(plainOk).toMatchObject({
    ok: true,
    value: { result: { outcome: "refused", exitCode: 3, data: null } },
  });

  const carriedOk = await contract.build(findingsRefused, {
    runId: "run-3",
    message: "Two findings.",
    data: { findings: ["a", "b"] },
    effects: unchanged,
  });
  expect(carriedOk).toMatchObject({
    ok: true,
    value: {
      result: {
        outcome: "refused",
        exitCode: 3,
        causeCode: "DOMAIN_FINDINGS",
        repairAction: "Fix each reported finding.",
        data: { findings: ["a", "b"] },
      },
    },
  });
  if (!carriedOk.ok) throw new Error("Expected carriesData refusal.");
  expect(Object.hasOwn(carriedOk.value.result, "carriesData")).toBe(false);
});

test("wire result validation admits non-null data only on success or unchanged domain refusal and rejects failed or non-domain refusals", async () => {
  const base = {
    runId: "run-1",
    commandIdentity: "notes.check",
    effectClass: "inspect",
    transactionState: "unchanged",
    retryable: false,
    repairAction: "Fix it.",
    effects: unchanged,
    next: { kind: "instruction", text: "Fix it." },
  } as const;

  const domainRefusedWithData = {
    ...base,
    outcome: "refused",
    causeCode: "DOMAIN_FINDINGS",
    failureClass: "domain",
    exitCode: 3,
    data: { findings: ["a"] },
  };
  expect(wireResult(domainRefusedWithData)).toBe(true);
  expect(wireResult({ ...domainRefusedWithData, repairAction: null })).toBe(
    false,
  );
  expect(wireResult({ ...domainRefusedWithData, repairAction: "" })).toBe(
    false,
  );

  const rejectedWireResults: readonly Record<string, unknown>[] = [
    {
      ...base,
      outcome: "failed",
      causeCode: "DOMAIN_FAILED",
      failureClass: "domain",
      exitCode: 3,
      data: { findings: ["a"] },
    },
    {
      ...base,
      outcome: "failed",
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      failureClass: "internal",
      exitCode: 1,
      data: { findings: ["a"] },
    },
    {
      ...base,
      outcome: "refused",
      causeCode: "USAGE_INVALID_INVOCATION",
      failureClass: "usage",
      exitCode: 2,
      data: { findings: ["a"] },
    },
    {
      ...base,
      outcome: "refused",
      causeCode: "SCHEMA_INVALID_INPUT",
      failureClass: "schema",
      exitCode: 4,
      data: { findings: ["a"] },
    },
    {
      ...base,
      outcome: "refused",
      causeCode: "INTERNAL_PREPARATION",
      failureClass: "internal",
      exitCode: 1,
      data: { findings: ["a"] },
    },
    {
      ...base,
      outcome: "refused",
      causeCode: "TRANSIENT_NOT_STARTED",
      failureClass: "transient",
      exitCode: 75,
      retryable: true,
      retryDelayMilliseconds: 10,
      next: { kind: "retry" },
      data: { findings: ["a"] },
    },
  ];
  for (const candidate of rejectedWireResults)
    expect(wireResult(candidate)).toBe(false);

  const causes = {
    ...commonCauses,
    DOMAIN_FINDINGS: carriesDataRow,
  } as const;
  const plainRefused = station(causes, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    trigger: "Precondition failed.",
    guidance: { next: { kind: "instruction", text: "Fix it." } },
    repairAction: "Fix it.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "precondition-failed",
  });
  const findingsRefused = station(causes, {
    commandIdentity: "notes.check",
    causeCode: "DOMAIN_FINDINGS",
    trigger: "Findings reported.",
    guidance: { next: { kind: "instruction", text: "Fix it." } },
    repairAction: "Fix it.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "findings-reported",
  });
  const check = command({
    capabilities: {},
    identity: "notes.check",
    route: ["check"],
    summary: "Check notes.",
    input,
    stations: [plainRefused, findingsRefused],
    run: (_input, context) =>
      context.result(findingsRefused, {
        message: "Found.",
        data: { findings: ["a"] },
        effects: unchanged,
      }),
  });
  const contract = contractFor({ cli: "notes", commands: [check], causes });
  const built = await contract.build(findingsRefused, {
    runId: "run-1",
    message: "Found.",
    data: { findings: ["a"] },
    effects: unchanged,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("Expected valid carriesData envelope.");
  expect((await contract.validate(built.value)).ok).toBe(true);
  expect(
    await contract.validate({
      ...built.value,
      result: {
        ...built.value.result,
        causeCode: "DOMAIN_PRECONDITION_UNMET",
      },
    }),
  ).toEqual({
    ok: false,
    path: "$",
    reason: "invalid envelope shape or correlation",
  });
});

test(
  "carriesData refusal returns its data with exit 3 through runProcess and appears in --discover-command",
  async () => {
    const folder = testFolder("kernel-carries-data-cli-");
    const script = join(folder, "cli.ts");
    try {
      await writeFile(
        script,
        [
          `import { command, commonCauses, contractFor, runProcess, station } from ${JSON.stringify(kernelEntry)};`,
          `import type { CauseTable } from ${JSON.stringify(kernelEntry)};`,
          'const causes = { ...commonCauses, DOMAIN_CHECK_FINDINGS: { outcome: "refused", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "next", carriesData: true } } as const satisfies CauseTable;',
          "const unchanged = { completed: [], remaining: [], uncertain: [], inventoryComplete: true } as const;",
          'const baseWords = { retryDelayPolicy: { kind: "none" }, reachability: "required", unreachableRationale: null } as const;',
          'const ok = station(causes, { ...baseWords, commandIdentity: "notes.check", causeCode: "SUCCESS_UNCHANGED", trigger: "No findings.", guidance: { next: { kind: "done" } }, repairAction: null, independentObservable: "clean" });',
          'const plain = station(causes, { ...baseWords, commandIdentity: "notes.check", causeCode: "DOMAIN_PRECONDITION_UNMET", trigger: "Missing target.", guidance: { next: { kind: "instruction", text: "Provide target." } }, repairAction: "Provide target.", independentObservable: "missing" });',
          'const findings = station(causes, { ...baseWords, commandIdentity: "notes.check", causeCode: "DOMAIN_CHECK_FINDINGS", trigger: "Findings detected.", guidance: { next: { kind: "instruction", text: "Fix the reported findings." } }, repairAction: "Fix the reported findings.", independentObservable: "findings" });',
          'const check = command({ identity: "notes.check", route: ["check"], summary: "Check notes.", capabilities: {}, input: { arguments: [], options: [{ name: "--mode", aliases: [], summary: "Mode.", required: true, repeatable: false, value: { kind: "string", minLength: 1, maxLength: 16, choices: ["ok", "plain", "findings"], pattern: null } }], constraints: [], deadlineSupported: false, additionalArguments: false, additionalOptions: false }, stations: [ok, plain, findings], run: (parsed, context) => {',
          '  if (parsed["--mode"] === "ok") return context.result(ok, { message: "Clean.", data: { checked: true }, effects: unchanged });',
          '  if (parsed["--mode"] === "plain") return context.result(plain, { message: "Missing target.", data: null, effects: unchanged });',
          '  return context.result(findings, { message: "1 finding.", data: { findings: ["missing-header"] }, effects: unchanged });',
          "} });",
          'await runProcess(contractFor({ cli: "notes", commands: [check], causes }))(process.argv.slice(2));',
          "",
        ].join("\n"),
      );

      const run = (...argv: string[]) =>
        spawnBounded([process.execPath, script, ...argv], { cwd: folder });

      const findingsRun = await run("check", "--mode", "findings", "--json");
      expect({ exit: findingsRun.exit, stderr: findingsRun.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      expect(JSON.parse(findingsRun.stdout)).toMatchObject({
        result: {
          outcome: "refused",
          exitCode: 3,
          causeCode: "DOMAIN_CHECK_FINDINGS",
          repairAction: "Fix the reported findings.",
          data: { findings: ["missing-header"] },
        },
      });

      const discoveryRun = await run(
        "--discover-command",
        "notes.check",
        "--json",
      );
      expect({ exit: discoveryRun.exit, stderr: discoveryRun.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const discoveryEnvelope: unknown = JSON.parse(discoveryRun.stdout);
      const discoveryResult: unknown = Reflect.get(
        Object(discoveryEnvelope),
        "result",
      );
      const discoveryData: unknown = Reflect.get(
        Object(discoveryResult),
        "data",
      );
      const discoveredStations: unknown = Reflect.get(
        Object(discoveryData),
        "stations",
      );
      expect(Array.isArray(discoveredStations)).toBe(true);
      if (!Array.isArray(discoveredStations))
        throw new Error("Expected discovered stations array.");
      const byCause = new Map<string, object>(
        discoveredStations.flatMap((entry: unknown) =>
          typeof entry === "object" && entry !== null
            ? [[String(Reflect.get(entry, "causeCode")), entry]]
            : [],
        ),
      );
      expect(byCause.get("DOMAIN_CHECK_FINDINGS")).toMatchObject({
        carriesData: true,
      });
      const plainStation = byCause.get("DOMAIN_PRECONDITION_UNMET");
      expect(plainStation).toBeDefined();
      if (!plainStation)
        throw new Error("Expected DOMAIN_PRECONDITION_UNMET station.");
      expect(Object.hasOwn(plainStation, "carriesData")).toBe(false);

      const okStation = byCause.get("SUCCESS_UNCHANGED");
      expect(okStation).toBeDefined();
      if (!okStation) throw new Error("Expected SUCCESS_UNCHANGED station.");
      expect(Object.hasOwn(okStation, "carriesData")).toBe(false);

      const okRun = await run("check", "--mode", "ok", "--json");
      expect({ exit: okRun.exit, stderr: okRun.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(JSON.parse(okRun.stdout)).toMatchObject({
        result: { outcome: "success", exitCode: 0, data: { checked: true } },
      });

      const plainRun = await run("check", "--mode", "plain", "--json");
      expect({ exit: plainRun.exit, stderr: plainRun.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      expect(JSON.parse(plainRun.stdout)).toMatchObject({
        result: { outcome: "refused", exitCode: 3, data: null },
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  processWatchdog(4),
);

test(
  "type checks reject non-null data on a plain refusal and illegal carriesData rows while accepting carriesData domain refusals",
  async () => {
    for (const compiler of ["native", "lint-view"] as const) {
      const rejectedPlain = await plainRefusalWithDataProbe.compile(compiler);
      expect(rejectedPlain.exit).not.toBe(0);
      expect(rejectedPlain.stderr).toBe("");
      expect(rejectedPlain.diagnostics.map((d) => d.code)).toContain(2322);

      expect(await carriesDataValidProbe.compile(compiler)).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });

      for (const item of [
        ...illegalCauseTableProbes,
        ...illegalAliasedCauseTableProbes,
      ]) {
        const rejected = await item.probe.compile(compiler);
        expect(rejected.exit).not.toBe(0);
        expect(rejected.stderr).toBe("");
        expect(rejected.diagnostics.length).toBeGreaterThan(0);
      }
    }
  },
  typeProbeTimeout,
);
