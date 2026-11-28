import { afterEach, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  EffectTransaction,
} from "../../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../../kernel/src/addons/state/index.ts";
import type {
  Declaration,
  ScopeDeclaration,
  TransactionResult,
} from "../../../kernel/src/addons/state/index.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { supportingTest } from "./harness.ts";

const causes = {
  DOMAIN_AR_LOCK_HELD: refusedHandoff,
  DOMAIN_AR_UNRESOLVED: refusedHandoff,
  DOMAIN_AR_UNAVAILABLE: refusedHandoff,
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "ar.pending", args: [] }],
  },
} as const;

type Effects = "note.write";
const defaultEffects: readonly [Effects, ...Effects[]] = ["note.write"];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function stateRoot(): string {
  const folder = testFolder("c3-ar-");
  folders.push(folder);
  return join(folder, "state");
}

function keyScope(key: string): ScopeDeclaration {
  return { resources: [{ resource: "note", key }] };
}

function actorStations() {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ar.apply",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "ar.apply:done",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ar.apply",
      causeCode: "DOMAIN_AR_LOCK_HELD",
      trigger: "Held.",
      repairAction: "Wait.",
      guidance: handoff,
      independentObservable: "ar.apply:held",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ar.apply",
      causeCode: "DOMAIN_AR_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "ar.apply:unresolved",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ar.apply",
      causeCode: "DOMAIN_AR_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "ar.apply:unavailable",
    }),
  ];
}

function pendingCommand() {
  return command({
    identity: "ar.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "ar.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "ar.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "ar.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

function actorCommand(
  state: ReturnType<typeof stateAddon>,
  declaration: Declaration,
  record: { outcome?: TransactionResult<Effects>; threw?: string },
) {
  return changing({
    identity: "ar.apply",
    route: ["apply"],
    summary: "Apply.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_AR_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_AR_UNRESOLVED",
    stations: actorStations(),
    run: async (_input, context) => {
      try {
        record.outcome = await state.transaction(
          context.state,
          declaration,
          async (transaction: EffectTransaction<Effects>) => {
            await transaction.record(
              "note.write",
              () => Promise.resolve(),
              () => Promise.resolve(true),
            );
          },
        );
      } catch (error) {
        record.threw = error instanceof Error ? error.message : String(error);
        return context.result(
          { commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_UNAVAILABLE" },
          { message: "threw", data: null, effects: unchanged },
        );
      }
      if (record.outcome.kind !== "ran")
        return context.result(
          { commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_UNAVAILABLE" },
          { message: record.outcome.kind, data: null, effects: unchanged },
        );
      return context.result(
        { commandIdentity: "ar.apply", causeCode: "SUCCESS_COMPLETED" },
        { message: "ran", data: null, transaction: record.outcome.proof },
      );
    },
  });
}

async function runInHost(
  root: string,
  declaration: Declaration,
): Promise<{
  readonly kind: TransactionResult<Effects>["kind"] | undefined;
  readonly threw: string | undefined;
}> {
  const state = stateAddon({
    root,
    report: "ar.pending",
    admissionWaitMilliseconds: 300,
  });
  const record: { outcome?: TransactionResult<Effects>; threw?: string } = {};
  const contract = contractFor({
    cli: "ar",
    commands: [pendingCommand(), actorCommand(state, declaration, record)],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  await runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  })(["apply"]);
  return { kind: record.outcome?.kind, threw: record.threw };
}

const secondProcessScript = `
import { changing, command, commonCauses, contractFor, runInProcess, station } from "./kernel/src/kernel/index.ts";
import { stateAddon } from "./kernel/src/addons/state/index.ts";
import { emptyInput, refusedHandoff, stationWords, unchanged } from "./tests/kernel/kernel-repair/shapes.ts";
const [root, key] = process.argv.slice(1);
const causes = {
  ...commonCauses,
  DOMAIN_AR_LOCK_HELD: refusedHandoff,
  DOMAIN_AR_UNRESOLVED: refusedHandoff,
  DOMAIN_AR_UNAVAILABLE: refusedHandoff,
};
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "ar.pending", args: [] }],
  },
};
const state = stateAddon({ root, report: "ar.pending", admissionWaitMilliseconds: 300 });
const pending = command({
  identity: "ar.pending",
  route: ["pending"],
  summary: "Pending.",
  input: emptyInput,
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity: "ar.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Read.",
      repairAction: null,
      guidance: { next: { kind: "instruction", text: "Inspect." } },
      independentObservable: "ar.pending:read",
    }),
  ],
  run: (_i, ctx) =>
    ctx.result(
      { commandIdentity: "ar.pending", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read.", data: null, effects: unchanged },
    ),
});
let outcomeKind = "none";
const actor = changing({
  identity: "ar.apply",
  route: ["apply"],
  summary: "Apply.",
  input: emptyInput,
  capabilities: {},
  effectClass: "repository-local",
  effects: ["note.write"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_AR_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_AR_UNRESOLVED",
  stations: [
    station(causes, { ...stationWords, commandIdentity: "ar.apply", causeCode: "SUCCESS_COMPLETED", trigger: "Done.", repairAction: null, guidance: { next: { kind: "done" } }, independentObservable: "ar.apply:done" }),
    station(causes, { ...stationWords, commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_LOCK_HELD", trigger: "Held.", repairAction: "Wait.", guidance: handoff, independentObservable: "ar.apply:held" }),
    station(causes, { ...stationWords, commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_UNRESOLVED", trigger: "Unresolved.", repairAction: "Inspect.", guidance: handoff, independentObservable: "ar.apply:unresolved" }),
    station(causes, { ...stationWords, commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_UNAVAILABLE", trigger: "Unavailable.", repairAction: "Inspect.", guidance: handoff, independentObservable: "ar.apply:unavailable" }),
  ],
  run: async (_i, ctx) => {
    const outcome = await state.transaction(
      ctx.state,
      { command: "ar.apply", scope: { resources: [{ resource: "note", key }] } },
      async (tx) => {
        await tx.record("note.write", () => Promise.resolve(), () => Promise.resolve(true));
      },
    );
    outcomeKind = outcome.kind;
    if (outcome.kind !== "ran")
      return ctx.result({ commandIdentity: "ar.apply", causeCode: "DOMAIN_AR_UNAVAILABLE" }, { message: outcome.kind, data: null, effects: unchanged });
    return ctx.result({ commandIdentity: "ar.apply", causeCode: "SUCCESS_COMPLETED" }, { message: "ran", data: null, transaction: outcome.proof });
  },
});
const contract = contractFor({ cli: "ar", commands: [pending, actor], causes, state: state.descriptor, installedAddons: ["state"] });
await runInProcess(contract, { emergencyRecord: state.emergencyRecord })(["apply"]);
console.log(JSON.stringify({ kind: outcomeKind }));
`;

async function runInSecondProcess(root: string, key: string): Promise<string> {
  const child = await spawnBounded(
    [process.execPath, "--no-install", "-e", secondProcessScript, root, key],
    { cwd: process.cwd(), boundMilliseconds: 10_000 },
  );
  if (child.exit !== 0)
    throw new Error(
      `Second process exited ${child.exit}: ${child.stderr.trim()}`,
    );
  const parsed: unknown = JSON.parse(child.stdout.trim());
  const kind: unknown =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "kind")
      : undefined;
  return typeof kind === "string" ? kind : "missing";
}

function throwingApprovalDeclaration(): Declaration {
  const declaration: Declaration = {
    command: "ar.apply",
    scope: keyScope("alpha"),
  };
  Object.defineProperty(declaration, "approval", {
    enumerable: true,
    get() {
      throw new Error("approval-boom");
    },
  });
  return declaration;
}

function throwingRevisionsDeclaration(): Declaration {
  const revisions: Readonly<Record<string, string>> = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("revisions-boom");
      },
    },
  );
  return {
    command: "ar.apply",
    scope: keyScope("alpha"),
    revisions,
  };
}

function throwingFactsDeclaration(): Declaration {
  const declaration: Declaration = {
    command: "ar.apply",
    scope: keyScope("alpha"),
  };
  Object.defineProperty(declaration, "facts", {
    enumerable: true,
    get() {
      throw new Error("facts-boom");
    },
  });
  return declaration;
}

async function assertReleasedAfterThrow(
  declaration: Declaration,
  expectedError: string,
): Promise<void> {
  const root = stateRoot();
  const failed = await runInHost(root, declaration);
  expect(failed).toEqual({ kind: undefined, threw: expectedError });

  const otherProcess = await runInSecondProcess(root, "gamma");
  expect(otherProcess).toBe("ran");

  const sameKey = await runInHost(root, {
    command: "ar.apply",
    scope: keyScope("alpha"),
  });
  expect(sameKey).toEqual({ kind: "ran", threw: undefined });

  const unrelatedKey = await runInHost(root, {
    command: "ar.apply",
    scope: keyScope("beta"),
  });
  expect(unrelatedKey).toEqual({ kind: "ran", threw: undefined });
}

supportingTest(
  "AR01.unflagged-approval-throw-releases-admission: throwing approval read frees admission and key locks for same and other processes",
  () =>
    assertReleasedAfterThrow(throwingApprovalDeclaration(), "approval-boom"),
  30_000,
);

supportingTest(
  "AR02.unflagged-revisions-throw-releases-admission: throwing revisions key enumeration frees admission and key locks for same and other processes",
  () =>
    assertReleasedAfterThrow(throwingRevisionsDeclaration(), "revisions-boom"),
  30_000,
);

supportingTest(
  "AR03.unflagged-facts-throw-releases-admission: throwing facts read frees admission and key locks for same and other processes",
  () => assertReleasedAfterThrow(throwingFactsDeclaration(), "facts-boom"),
  30_000,
);
