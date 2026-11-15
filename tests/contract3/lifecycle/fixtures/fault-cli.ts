// LABELLED TEST-ONLY FAULT FIXTURE CLI "fx". It is composed from the same
// stamped kernel and programs add-on sources, lives under tests/, is never
// registered as a production command and never ships. Faults are injected only
// by wrapping the kernel's internal contract runtime record or the process
// host port from this file. Its synthetic state installer is not the T3 state
// add-on: it exists only so the writer, fallback and deadline paths can see a
// state-issued transaction proof.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runProcess,
  station,
} from "../../../../starters/contract3/src/kernel/index.ts";
import type {
  CauseTable,
  JsonValue,
  ProcessHost,
  ProgramRequest,
  ProgramsCapability,
  RecordedEffect,
  RunSetup,
  StateAddonDescriptor,
  StateCapability,
  StateIssuer,
  StateObservation,
  StateRegistration,
} from "../../../../starters/contract3/src/kernel/index.ts";
import {
  callerProgramDisclosure,
  programDetails,
  programsAddon,
} from "../../../../starters/contract3/src/addons/programs/index.ts";
import { fallbackMessage } from "../../../../starters/contract3/src/kernel/fallback.ts";
import { processHost } from "../../../../starters/contract3/src/kernel/process-host.ts";
import {
  registerRuntime,
  runtimeOf,
} from "../../../../starters/contract3/src/kernel/runtime.ts";
import type { ContractRuntime } from "../../../../starters/contract3/src/kernel/runtime.ts";
import { path } from "../../../../starters/contract3/src/kernel/validation/brands.ts";
import { record } from "../../../../starters/contract3/src/kernel/validation/primitives.ts";

const ledgerPath = process.env.FX_LEDGER;
const scenario = new Set((process.env.FX_SCENARIO ?? "").split("+"));
const marker = "FX-REJECTED-PAYLOAD";

function ledger(line: string): void {
  if (ledgerPath) appendFileSync(ledgerPath, `${line}\n`);
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function ledgerHas(prefix: string, milliseconds: number) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    if (
      ledgerPath &&
      existsSync(ledgerPath) &&
      readFileSync(ledgerPath, "utf8")
        .split("\n")
        .some((line) => line.startsWith(prefix))
    )
      return true;
    await sleep(5);
  }
  return false;
}

const causes = {
  DOMAIN_FX_READ_FAILED: {
    outcome: "failed",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_FX_CHANGE_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_CHANGE_UNCERTAIN: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_LOCK_HELD: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_UNRESOLVED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
const inspectLedger = {
  owner: "operator",
  reason: "The fixture effect needs inspection.",
  inspect: [{ kind: "command", command: "fx.pending", args: [] }],
} as const;
const integer = <const Name extends string>(
  name: Name,
  minimum: number,
  maximum: number,
) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: { kind: "integer", minimum, maximum },
  }) as const;
const choice = <const Name extends string>(
  name: Name,
  choices: readonly string[],
) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: true,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 64,
      choices: [...choices],
      pattern: null,
    },
  }) as const;
const flag = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: null,
  }) as const;

function program(
  script: string,
  overrides: Partial<Omit<ProgramRequest, "executable" | "args">> = {},
): ProgramRequest {
  return {
    executable: path("/bin/sh"),
    args: ["-c", script],
    timeoutMilliseconds: 30_000,
    outputLimitBytes: 4096,
    shutdownMilliseconds: 2_000,
    ...overrides,
  };
}

const read = command({
  identity: "fx.read",
  route: ["read"],
  summary: "Read fixture data.",
  input: { ...none, options: [integer("--size", 0, 8_388_608)] },
  capabilities: {},
  run: (input, context) =>
    context.result(
      { commandIdentity: "fx.read", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read fixture data.",
        data: { text: "x".repeat(input["--size"] ?? 16) },
        effects: empty,
      },
    ),
});

const refuse = command({
  identity: "fx.refuse",
  route: ["refuse"],
  summary: "Refuse on a fixture precondition.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.refuse",
      causeCode: "DOMAIN_PRECONDITION_UNMET",
      trigger: "The fixture precondition is unmet.",
      repairAction: "Repair the fixture precondition.",
      guidance: { next: { kind: "instruction", text: "Repair the fixture." } },
      independentObservable: "fx:refuse",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.refuse", causeCode: "DOMAIN_PRECONDITION_UNMET" },
      {
        message: "The fixture precondition is unmet.",
        data: null,
        effects: empty,
      },
    ),
});

const fail = command({
  identity: "fx.fail",
  route: ["fail"],
  summary: "Fail a fixture read.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.fail",
      causeCode: "DOMAIN_FX_READ_FAILED",
      trigger: "The fixture read failed.",
      repairAction: "Inspect the fixture.",
      guidance: { next: { kind: "instruction", text: "Inspect the fixture." } },
      independentObservable: "fx:fail",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.fail", causeCode: "DOMAIN_FX_READ_FAILED" },
      { message: "The fixture read failed.", data: null, effects: empty },
    ),
});

const busy = command({
  identity: "fx.busy",
  route: ["busy"],
  summary: "Report a temporary fixture refusal.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      commandIdentity: "fx.busy",
      causeCode: "TRANSIENT_NOT_STARTED",
      trigger: "The fixture is busy.",
      repairAction: "Retry after the delay.",
      guidance: { next: { kind: "retry" } },
      retryDelayPolicy: {
        kind: "bounded",
        minimumMilliseconds: 10,
        maximumMilliseconds: 20,
      },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "fx:busy",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.busy", causeCode: "TRANSIENT_NOT_STARTED" },
      {
        message: "The fixture is busy.",
        data: null,
        effects: empty,
        retryDelayMilliseconds: 15,
      },
    ),
});

function depthWithin(value: unknown, limit: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  for (let item = stack.pop(); item; item = stack.pop()) {
    if (item.value === null || typeof item.value !== "object") continue;
    if (item.depth > limit) return false;
    for (const child of Object.values(item.value))
      stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

const json = command({
  identity: "fx.json",
  route: ["json"],
  summary: "Accept one fixture JSON payload.",
  input: {
    ...none,
    options: [
      {
        name: "--payload",
        aliases: [],
        summary: "Fixture JSON payload.",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 0,
          maxLength: 65_536,
          choices: null,
          pattern: null,
        },
      },
    ],
  },
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.json",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The payload was accepted.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "fx:json",
    }),
    station(allCauses, {
      ...words,
      commandIdentity: "fx.json",
      causeCode: "SCHEMA_INVALID_INPUT",
      trigger: "The payload is not bounded plain JSON.",
      repairAction: "Correct the payload shape.",
      guidance: {
        next: { kind: "instruction", text: "Correct the payload shape." },
      },
      independentObservable: "fx:json-invalid",
    }),
  ],
  run: (input, context) => {
    let accepted: boolean;
    try {
      const parsed: unknown = JSON.parse(input["--payload"]);
      accepted = depthWithin(parsed, 64);
    } catch {
      accepted = false;
    }
    return accepted
      ? context.result(
          { commandIdentity: "fx.json", causeCode: "SUCCESS_UNCHANGED" },
          { message: "The payload was accepted.", data: null, effects: empty },
        )
      : context.result(
          { commandIdentity: "fx.json", causeCode: "SCHEMA_INVALID_INPUT" },
          {
            message: "The payload is not bounded plain JSON.",
            data: null,
            effects: empty,
          },
        );
  },
});

const badVariants = [
  "cycle",
  "over-depth",
  "undefined",
  "function",
  "function-tojson",
  "bigint",
  "date",
  "nan",
  "infinity",
  "negative-infinity",
  "class-instance",
  "map",
  "depth",
  "throw",
] as const;
class FixtureThing {
  readonly field = marker;
}
function nested(levels: number): JsonValue {
  let value: JsonValue = [];
  for (let level = 1; level < levels; level++) value = [value];
  return value;
}
function badData(variant: string, depth: number): JsonValue {
  const box: Record<string, JsonValue> = { marker };
  const values: Record<string, unknown> = {
    undefined,
    function: () => marker,
    bigint: 10n,
    date: new Date(0),
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    "negative-infinity": Number.NEGATIVE_INFINITY,
    "class-instance": new FixtureThing(),
    map: new Map([[marker, 1]]),
  };
  if (variant === "cycle") box.self = box;
  else if (variant === "over-depth") box.value = nested(70);
  else if (variant === "depth") return nested(depth);
  else if (variant === "function-tojson")
    Reflect.set(box, "toJSON", () => marker);
  else if (variant === "throw") throw new Error(marker);
  else Reflect.set(box, "value", values[variant]);
  return box;
}

const bad = command({
  identity: "fx.bad",
  route: ["bad"],
  summary: "Return fixture data that may not be plain JSON.",
  input: {
    ...none,
    options: [choice("--variant", badVariants), integer("--depth", 1, 200)],
  },
  capabilities: {},
  run: (input, context) =>
    context.result(
      { commandIdentity: "fx.bad", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Returned fixture data.",
        data: badData(input["--variant"], input["--depth"] ?? 1),
        effects: empty,
      },
    ),
});

const longChild = (ignoreTerm: boolean) =>
  `${ignoreTerm ? "trap 'echo child-term-received >> \"$FX_LEDGER\"' TERM; " : ""}echo "child-started $$" >> "$FX_LEDGER"; while :; do /bin/sleep 0.05; done`;

async function slowWork(programs: ProgramsCapability, ignoreTerm: boolean) {
  ledger("dispatch-start");
  const hold = Number(process.env.FX_HOLD_MS ?? "0");
  if (hold > 0) await sleep(hold);
  try {
    await programs.inspect(program(longChild(ignoreTerm)));
    ledger("program-returned");
  } catch {
    ledger("start-refused");
  }
  try {
    await programs.inspect(
      program('echo "late-start $$" >> "$FX_LEDGER"', {
        timeoutMilliseconds: 1000,
      }),
    );
  } catch {
    ledger("late-start-refused");
  }
}

const slow = command({
  identity: "fx.slow",
  route: ["slow"],
  summary: "Run one long fixture program.",
  input: { ...none, deadlineSupported: true, options: [flag("--ignore-term")] },
  capabilities: { programs: true },
  run: async (input, context) => {
    await slowWork(context.programs, input["--ignore-term"] === true);
    return context.result(
      { commandIdentity: "fx.slow", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The fixture program finished.", data: null, effects: empty },
    );
  },
});

const programModes = {
  isolation: program(
    'bytes=$(/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " "); echo "child-stdin-bytes $bytes" >> "$FX_LEDGER"; /usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000; /usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000 >&2',
    { timeoutMilliseconds: 10_000 },
  ),
  capture: program(
    "/usr/bin/yes FX | /usr/bin/head -c 268435456; /usr/bin/yes FX | /usr/bin/head -c 268435456 >&2",
    { timeoutMilliseconds: 20_000 },
  ),
  timeout: program(
    'echo "child-pgid $(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d " ")" >> "$FX_LEDGER"; /bin/sleep 1000 & echo "grandchild $!" >> "$FX_LEDGER"; wait',
    { timeoutMilliseconds: 300, shutdownMilliseconds: 1000 },
  ),
  "timeout-ignore-term": program(
    'trap "" TERM; echo "child-pgid $(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d " ")" >> "$FX_LEDGER"; /bin/sleep 1000 & echo "grandchild $!" >> "$FX_LEDGER"; wait',
    { timeoutMilliseconds: 300, shutdownMilliseconds: 300 },
  ),
  orphan: program(longChild(true), { shutdownMilliseconds: 300 }),
  escape: program(
    `/usr/bin/perl -e 'use POSIX qw(setsid); my $p = fork(); if ($p == 0) { setsid(); open(my $f, ">>", $ENV{FX_LEDGER}); print $f "escaped $$\\n"; close $f; close STDOUT; close STDERR; sleep 1000; exit 0 } waitpid(-1, 1); exit 0'; /bin/sleep 0.2`,
    { timeoutMilliseconds: 5_000, shutdownMilliseconds: 500 },
  ),
} as const;

const programCommand = command({
  identity: "fx.program",
  route: ["program"],
  summary: "Run one fixture inspection program.",
  input: { ...none, options: [choice("--mode", Object.keys(programModes))] },
  capabilities: { programs: true },
  run: async (input, context) => {
    const mode = input["--mode"];
    const request = Object.entries(programModes).find(
      ([name]) => name === mode,
    )?.[1];
    if (!request) throw new Error("Unknown fixture mode.");
    if (mode === "orphan") {
      void context.programs.inspect(request).catch(() => undefined);
      await ledgerHas("child-started", 5_000);
      return context.result(
        { commandIdentity: "fx.program", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Started an orphan program.", data: null, effects: empty },
      );
    }
    const result = await context.programs.inspect(request);
    const detail = programDetails(result);
    return context.result(
      { commandIdentity: "fx.program", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The fixture program finished.",
        data: {
          stdoutBytes: new TextEncoder().encode(result.stdout).byteLength,
          stderrBytes: new TextEncoder().encode(result.stderr).byteLength,
          markerSeen: result.stdout.includes("FX-CHILD-STREAM-MARKER"),
          exitCode: result.exitCode,
          terminationConfirmed: result.terminationConfirmed,
          timedOut: detail?.timedOut ?? null,
          stdoutTruncated: detail?.stdoutTruncated ?? null,
          stderrTruncated: detail?.stderrTruncated ?? null,
          attempts: detail?.attempts.map((attempt) => attempt.signal) ?? [],
          pid: detail?.pid ?? null,
        },
        effects: empty,
      },
    );
  },
});

const supplied = command({
  identity: "fx.supplied",
  route: ["supplied"],
  summary: `Run one fixture program. ${callerProgramDisclosure}`,
  input: {
    ...none,
    arguments: [
      {
        name: "program",
        summary: "Absolute path of the caller's program.",
        required: true,
        value: {
          kind: "string",
          minLength: 2,
          maxLength: 1024,
          choices: null,
          pattern: "/[A-Za-z0-9._/-]+",
        },
      },
    ],
  },
  capabilities: { programs: true },
  run: async (input, context) => {
    const result = await context.programs.supplied({
      executable: path(input.program),
      args: [],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4096,
      shutdownMilliseconds: 1000,
    });
    return context.result(
      { commandIdentity: "fx.supplied", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The caller program finished.",
        data: {
          markerSeen: result.stdout.includes("FX-CHILD-STREAM-MARKER"),
          exitCode: result.exitCode,
        },
        effects: empty,
      },
    );
  },
});

const crash = command({
  identity: "fx.crash",
  route: ["crash"],
  summary: "Crash after starting a fixture program.",
  input: {
    ...none,
    options: [choice("--kind", ["uncaught-exception", "unhandled-rejection"])],
  },
  capabilities: { programs: true },
  run: async (input, context) => {
    void context.programs
      .inspect(program(longChild(true)))
      .catch(() => undefined);
    await ledgerHas("child-started", 5_000);
    if (input["--kind"] === "uncaught-exception")
      setTimeout(() => {
        throw new Error(`${marker} crash`);
      }, 1);
    else void Promise.reject(new Error(`${marker} rejection`));
    await new Promise(() => undefined);
    return context.result(
      { commandIdentity: "fx.crash", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Unreachable.", data: null, effects: empty },
    );
  },
});

const pending = command({
  identity: "fx.pending",
  route: ["pending"],
  summary: "Report unfinished fixture changes.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Unfinished fixture changes were read.",
      repairAction: null,
      guidance: {
        next: { kind: "instruction", text: "Inspect the fixture ledger." },
      },
      independentObservable: "fx:pending",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.pending", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read unfinished fixture changes.",
        data: null,
        effects: empty,
      },
    ),
});

// Synthetic state: intent for the next transaction is set by the handler.
let intended: readonly string[] | undefined;

function observe<Effect extends string>(
  declared: readonly Effect[],
  completed: ReadonlySet<Effect>,
  uncertain: ReadonlySet<Effect>,
): StateObservation<Effect> {
  const done = [...completed].sort();
  const unsure = [...uncertain].sort();
  const remaining = declared
    .filter(
      (effect) =>
        (intended ?? declared).includes(effect) &&
        !completed.has(effect) &&
        !uncertain.has(effect),
    )
    .sort();
  const [firstUnsure, ...moreUnsure] = unsure;
  if (firstUnsure !== undefined)
    return {
      transactionState: "unknown",
      effects: {
        completed: done,
        remaining,
        uncertain: [firstUnsure, ...moreUnsure],
        inventoryComplete: true,
      },
    };
  const [firstDone, ...moreDone] = done;
  if (firstDone === undefined)
    return {
      transactionState: "unchanged",
      effects: {
        completed: [],
        remaining,
        uncertain: [],
        inventoryComplete: true,
      },
    };
  const [firstRemaining, ...moreRemaining] = remaining;
  return firstRemaining === undefined
    ? {
        transactionState: "completed",
        effects: {
          completed: [firstDone, ...moreDone],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        },
      }
    : {
        transactionState: "partially-completed",
        effects: {
          completed: [firstDone, ...moreDone],
          remaining: [firstRemaining, ...moreRemaining],
          uncertain: [],
          inventoryComplete: true,
        },
      };
}

export function syntheticState(issuer: StateIssuer): StateRegistration {
  return {
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: "fx.pending",
      args: [],
    }),
    attach<Effect extends string>(
      runId: string,
      effects: readonly Effect[],
    ): StateCapability<Effect> {
      return {
        async transaction(work) {
          const completed = new Set<Effect>();
          const uncertain = new Set<Effect>();
          let active = true;
          await work({
            async record<T>(
              effect: Effect,
              operation: (capability: RecordedEffect<Effect>) => Promise<T>,
              readBack: (result: T) => Promise<boolean>,
            ) {
              if (!active || !effects.includes(effect))
                throw new Error("Inactive or undeclared fixture effect.");
              const capability = issuer.recordedEffect(
                runId,
                effect,
                async <S>(
                  owner: string,
                  name: Effect,
                  start: () => Promise<S>,
                ) => {
                  if (!active || owner !== runId || name !== effect)
                    throw new Error("The fixture effect is not active.");
                  return start();
                },
              );
              ledger(`effect-start ${effect}`);
              const value = await operation(capability);
              let confirmed: boolean;
              try {
                confirmed = await readBack(value);
              } catch {
                confirmed = false;
              }
              (confirmed ? completed : uncertain).add(effect);
              ledger(
                `effect-${confirmed ? "confirmed" : "uncertain"} ${effect}`,
              );
              return value;
            },
          });
          active = false;
          return issuer.transactionProof(
            runId,
            observe(effects, completed, uncertain),
          );
        },
      };
    },
  };
}

const changeModes = [
  "complete",
  "partial",
  "unknown",
  "unchanged",
  "throw",
  "deadline-none",
  "deadline-complete",
  "deadline-partial",
  "deadline-stall",
] as const;
const coordination = <const Identity extends "fx.change" | "fx.wide">(
  identity: Identity,
) =>
  [
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_FX_LOCK_HELD",
      trigger: "The fixture lock is held.",
      repairAction: "Inspect the fixture lock owner.",
      guidance: { handoff: inspectLedger },
      independentObservable: `${identity}:lock`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_FX_UNRESOLVED",
      trigger: "An unfinished fixture change conflicts.",
      repairAction: "Inspect the unfinished fixture change.",
      guidance: { handoff: inspectLedger },
      independentObservable: `${identity}:unresolved`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Every fixture effect was confirmed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: `${identity}:completed`,
    }),
  ] as const;

function makeChange(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.change",
    route: ["change"],
    summary: "Apply fixture effects.",
    input: {
      ...none,
      deadlineSupported: true,
      options: [choice("--mode", changeModes)],
    },
    capabilities: { programs: true },
    effectClass: "repository-local",
    effects: ["fx.alpha", "fx.beta"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [
      ...coordination("fx.change"),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Nothing needed changing.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "fx.change:noop",
      }),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "DOMAIN_FX_CHANGE_PARTIAL",
        trigger: "A known subset of fixture effects completed.",
        repairAction: "Inspect the fixture effects.",
        guidance: { handoff: inspectLedger },
        independentObservable: "fx.change:partial",
      }),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "DOMAIN_FX_CHANGE_UNCERTAIN",
        trigger: "A fixture effect could not be confirmed.",
        repairAction: "Inspect the fixture effects.",
        guidance: { handoff: inspectLedger },
        independentObservable: "fx.change:uncertain",
      }),
    ],
    run: async (input, context) => {
      const mode = input["--mode"];
      intended = mode === "unchanged" ? [] : undefined;
      const apply =
        (effect: "fx.alpha" | "fx.beta", confirmed = true) =>
        (transaction: {
          readonly record: <T>(
            effect: "fx.alpha" | "fx.beta",
            operation: () => Promise<T>,
            readBack: (result: T) => Promise<boolean>,
          ) => Promise<T>;
        }) =>
          transaction.record(
            effect,
            () => Promise.resolve(ledger(`applied ${effect}`)),
            () => Promise.resolve(confirmed),
          );
      const waitForDeadline = async () => {
        try {
          await context.programs.inspect(program(longChild(false)));
        } catch {
          ledger("start-refused");
        }
      };
      const proof = await context.state.transaction(async (transaction) => {
        if (mode === "throw") throw new Error(marker);
        if (mode === "deadline-none") return waitForDeadline();
        if (mode === "unchanged") return;
        await apply("fx.alpha")(transaction);
        if (mode === "deadline-stall") {
          await sleep(5_000);
          return;
        }
        if (mode === "partial") return;
        if (mode === "deadline-partial") return waitForDeadline();
        await apply("fx.beta", mode !== "unknown")(transaction);
        if (mode === "deadline-complete") await waitForDeadline();
      });
      const selected =
        proof.transactionState === "completed"
          ? "SUCCESS_COMPLETED"
          : proof.transactionState === "partially-completed"
            ? "DOMAIN_FX_CHANGE_PARTIAL"
            : proof.transactionState === "unknown"
              ? "DOMAIN_FX_CHANGE_UNCERTAIN"
              : "SUCCESS_UNCHANGED";
      return context.result(
        { commandIdentity: "fx.change", causeCode: selected },
        {
          message: "Applied fixture effects.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

const wideEffects = Array.from(
  { length: 40 },
  (_unused, index) =>
    `fx.wide.${String(index).padStart(2, "0")}.${"w".repeat(480)}`,
);

function makeWide(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.wide",
    route: ["wide"],
    summary: "Apply many fixture effects.",
    input: { ...none, options: [flag("--go")] },
    capabilities: {},
    effectClass: "repository-local",
    effects: [wideEffects[0] ?? "fx.wide", ...wideEffects.slice(1)],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [...coordination("fx.wide")],
    run: async (_input, context) => {
      intended = undefined;
      const proof = await context.state.transaction(async (transaction) => {
        for (const effect of wideEffects)
          await transaction.record(
            effect,
            () => Promise.resolve(undefined),
            () => Promise.resolve(true),
          );
      });
      return context.result(
        { commandIdentity: "fx.wide", causeCode: "SUCCESS_COMPLETED" },
        {
          message: "Applied many fixture effects.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

function corrupt(kind: string, value: unknown): unknown {
  if (!record(value) || !record(value.result)) return value;
  const envelope = structuredClone(value);
  const result = envelope.result;
  if (!record(result)) return value;
  const effects = record(result.effects) ? result.effects : {};
  switch (kind) {
    case "wrong-exit":
      result.exitCode = 1;
      break;
    case "undeclared-cause":
      result.causeCode = "DOMAIN_FX_NEVER_DECLARED";
      break;
    case "fixed-field":
      result.repairAction = "Different repair words.";
      break;
    case "pair":
      result.transactionState = "partially-completed";
      break;
    case "unsorted":
      if (Array.isArray(effects.completed)) effects.completed.reverse();
      break;
    case "overlap":
      if (
        Array.isArray(effects.completed) &&
        Array.isArray(effects.uncertain)
      ) {
        const done: readonly unknown[] = effects.completed;
        const unsure: readonly unknown[] = effects.uncertain;
        effects.completed = [...done, ...unsure];
      }
      break;
    case "delay":
      result.retryDelayMilliseconds = 5;
      break;
    case "both-arms":
      result.handoff = inspectLedger;
      break;
    default:
      envelope.message = "";
  }
  return envelope;
}

function faultRuntime(runtime: ContractRuntime): ContractRuntime {
  const kind = [...scenario]
    .find((entry) => entry.startsWith("corrupt:"))
    ?.slice("corrupt:".length);
  const stations = scenario.has("fallback-stations-missing")
    ? new Map(
        [...runtime.stations].map(([identity, entries]) => [
          identity,
          entries.filter((entry) => !entry.causeCode.startsWith("INTERNAL_")),
        ]),
      )
    : runtime.stations;
  const tamper = (built: Awaited<ReturnType<ContractRuntime["build"]>>) =>
    kind && built.ok
      ? ({ ok: true, value: corrupt(kind, built.value) } as const)
      : built;
  return {
    ...runtime,
    stations,
    build: async (selected, facts, trusted) =>
      tamper(await runtime.build(selected, facts, trusted)),
    buildResult: async (result) => tamper(await runtime.buildResult(result)),
    validate: scenario.has("validation-always-fails")
      ? () =>
          Promise.resolve({
            ok: false,
            path: "$",
            reason: "fixture fault",
          } as const)
      : runtime.validate,
  };
}

function faultHost(host: ProcessHost): ProcessHost {
  const clockStart = host.now();
  let clockCalls = 0;
  let held = false;
  return {
    async write(stream, bytes) {
      if (stream !== "stdout") return host.write(stream, bytes);
      const fallback = new TextDecoder()
        .decode(bytes.subarray(0, 512))
        .includes(`"message":${JSON.stringify(fallbackMessage)}`);
      ledger(`stdout-write ${fallback ? "fallback" : "result"}`);
      if (scenario.has("fallback-write-fails") && fallback) return false;
      if (scenario.has("output-began-fails")) {
        await host.write(
          stream,
          bytes.subarray(0, Math.floor(bytes.byteLength / 2)),
        );
        return false;
      }
      return host.write(stream, bytes);
    },
    exit(code) {
      const holding =
        scenario.has("hold-after-drain") ||
        scenario.has("hold-after-drain-until-release");
      if (!holding || held || code === 130 || code === 143) {
        host.exit(code);
        return;
      }
      held = true;
      ledger(`drained ${code}`);
      const release = `${ledgerPath ?? ""}.release`;
      setInterval(() => {
        if (
          scenario.has("hold-after-drain-until-release") &&
          existsSync(release)
        )
          host.exit(code);
      }, 5);
    },
    onSignal: (listener) => host.onSignal(listener),
    onCrash: (listener) => host.onCrash(listener),
    now() {
      clockCalls += 1;
      const real = host.now();
      return scenario.has("clock-jump") && clockCalls > 1
        ? clockStart + 1_000_000_000 + (real - clockStart)
        : real;
    },
  };
}

export async function main(state?: StateAddonDescriptor): Promise<number> {
  const inspectCommands = [
    read,
    refuse,
    fail,
    busy,
    json,
    bad,
    slow,
    programCommand,
    supplied,
    crash,
    pending,
  ] as const;
  const contract = state
    ? contractFor({
        cli: "fx",
        commands: [...inspectCommands, makeChange(state), makeWide(state)],
        causes,
        state,
        installedAddons: ["state", "programs"],
      })
    : contractFor({
        cli: "fx",
        commands: inspectCommands,
        causes,
        installedAddons: ["programs"],
      });
  const runtime = runtimeOf(contract);
  if (!runtime) throw new Error("Fixture contract has no runtime.");
  const faulted = {};
  registerRuntime(faulted, faultRuntime(runtime));
  const setup: RunSetup = {
    host: faultHost(processHost()),
    addons: { programs: programsAddon() },
    ...(scenario.has("emergency-recorder")
      ? {
          emergencyRecord: (facts) =>
            ledger(
              `emergency ${facts.phase} ${facts.commandIdentity ?? "none"}`,
            ),
        }
      : {}),
  };
  return runProcess(faulted, setup)(process.argv.slice(2));
}

if (import.meta.main) await main();
