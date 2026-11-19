import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runProcess,
  station,
} from "../../../../kernel/src/kernel/index.ts";
import type {
  EffectTransaction,
  ApprovalCapability,
  ApprovalRequest,
  AuthorityId,
  ResourceId,
  ApprovalRuntime,
  CauseTable,
  JsonValue,
  RunAddon,
} from "../../../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../../../kernel/src/addons/state/index.ts";
import type { Observer } from "../../../../kernel/src/addons/state/index.ts";
import { stateAddonWithTestSeams } from "../../../../kernel/src/addons/state/fixture.ts";
import type { Phase } from "../../../../kernel/src/addons/state/fixture.ts";
import { approval } from "../../../../kernel/src/addons/approval/index.ts";

const root = process.env.SX_ROOT ?? "";
const world = process.env.SX_WORLD ?? "";
const barrierDirectory = process.env.SX_BARRIER_DIR ?? "";
const barriers = new Set(
  (process.env.SX_BARRIER ?? "").split(",").filter(Boolean),
);
const fault = process.env.SX_FAULT ?? "";

export const barrierReached = new EventTarget();
function releaseFile(name: string): string {
  return join(barrierDirectory, `${name}.release`);
}
export function releaseBarrier(name: string): void {
  writeFileSync(releaseFile(name), "go\n");
}
export function closeBarrier(name: string): void {
  rmSync(releaseFile(name), { force: true });
}

async function barrier(name: string): Promise<void> {
  if (!barriers.has(name) || barrierDirectory === "") return;
  writeFileSync(join(barrierDirectory, `${name}.reached`), `${process.pid}\n`);
  barrierReached.dispatchEvent(new Event(name));
  if (fault === `abort-at-${name}`) process.abort();
  const release = releaseFile(name);
  const until = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() > until) throw new Error(`Barrier ${name} never released.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const notes = join(world, "notes");
const ledgerFile = join(world, "ledger.log");
const providerLog = join(world, "provider.log");
const outbox = join(world, "outbox");
const labels = join(world, "labels.log");

function ledger(line: string): void {
  appendFileSync(ledgerFile, `${line}\n`);
}
function lines(path: string): readonly string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
}
function factText(facts: unknown, key: string): string {
  const value: unknown =
    typeof facts === "object" && facts !== null
      ? Reflect.get(facts, key)
      : undefined;
  return typeof value === "string" ? value : "";
}

const observers: Readonly<Record<string, Observer>> = {
  "note.write": ({ facts }) => {
    const path = factText(facts, "path");
    const content = factText(facts, "content");
    return Promise.resolve(
      existsSync(path) && readFileSync(path, "utf8") === content
        ? "present"
        : "absent",
    );
  },
  "note.stamp": ({ facts }) => {
    const path = `${factText(facts, "path")}.stamp`;
    return Promise.resolve(existsSync(path) ? "present" : "absent");
  },
  "message.send": ({ facts }) => {
    const id = factText(facts, "message");
    if (existsSync(join(outbox, id))) return Promise.resolve("present");
    return Promise.resolve(
      lines(providerLog).some((line) => line.startsWith(`sent ${id} `))
        ? "absent"
        : "excluded",
    );
  },
  "audit.emit": () => Promise.resolve("unobservable"),
};

const waitBound = Number(process.env.SX_ADMISSION_WAIT ?? "2000");
const phased = { phase: (name: Phase) => barrier(name) };
const labelled =
  process.env.SX_QUALIFICATION === "fixture"
    ? { ...phased, fixtureLabel: "specimen" }
    : phased;
const library = process.env.SX_COORDINATION_LIBRARY;
const seams = library
  ? { ...labelled, coordinationLibrary: library }
  : labelled;
const stateOptions = {
  root,
  report: "sx.pending",
  observers,
  admissionWaitMilliseconds: Number.isFinite(waitBound) ? waitBound : 2000,
};
const productionEntry = process.env.SX_ENTRY === "production";
if (productionEntry) ledger("entry production");
export const state = productionEntry
  ? stateAddon(stateOptions)
  : stateAddonWithTestSeams(stateOptions, seams);

const handoffRefusal = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;
const causes = {
  DOMAIN_SX_LOCK_HELD: handoffRefusal,
  DOMAIN_SX_UNRESOLVED: handoffRefusal,
  DOMAIN_SX_UNAVAILABLE: handoffRefusal,
  DOMAIN_SX_APPROVAL_LOST: handoffRefusal,
  DOMAIN_SX_APPROVAL_STORE: handoffRefusal,
  DOMAIN_SX_CLOSE_OWNER_LIVE: handoffRefusal,
  DOMAIN_SX_CLOSE_EVIDENCE: handoffRefusal,
  DOMAIN_SX_CLOSE_CONFLICT: handoffRefusal,
  DOMAIN_SX_CLOSE_STALE: handoffRefusal,
  DOMAIN_SX_CASE_NOT_FOUND: handoffRefusal,
  DOMAIN_SX_CHANGE_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_SX_CHANGE_UNKNOWN: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  SCHEMA_SX_STATE_UNREADABLE: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "schema",
    exitCode: 4,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };

const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
const retryWords = {
  retryDelayPolicy: {
    kind: "bounded",
    minimumMilliseconds: 50,
    maximumMilliseconds: 2_000,
  },
  reachability: "required",
  unreachableRationale: null,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const historyStep = {
  kind: "command",
  command: "sx.history",
  args: ["{binding.operationId}"],
} as const;
const pendingStep = {
  kind: "command",
  command: "sx.pending",
  args: [],
} as const;

type Changing =
  | "sx.apply"
  | "sx.apply2"
  | "sx.send"
  | "sx.audit"
  | "sx.approved"
  | "sx.close";

function coordinationStations<const Identity extends Changing>(
  identity: Identity,
  options: { readonly unresolved?: false; readonly approval?: true } = {},
) {
  const unresolvedReachable = options.unresolved !== false;
  const approvalWords = options.approval
    ? words
    : ({
        ...words,
        reachability: "declared-unreachable",
        unreachableRationale: "This command declares no approval capability.",
      } as const);
  const unresolvedWords = unresolvedReachable
    ? words
    : ({
        ...words,
        reachability: "declared-unreachable",
        unreachableRationale:
          "Closure is never blocked by another unresolved case (DESIGN.md 7.1 step 4).",
      } as const);
  return [
    station(allCauses, {
      ...approvalWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_AUTHORITY_REQUIRED",
      trigger:
        "The exact-item grant was not valid when revalidated under coordination.",
      repairAction: "Obtain a valid exact-item grant from the authority owner.",
      guidance: {
        handoff: {
          owner: "human",
          reason: "The required authority was not confirmed.",
          inspect: [
            {
              kind: "instruction",
              text: "Ask the authority owner for an exact-item grant.",
            },
          ],
        },
      },
      independentObservable: `${identity}:authority`,
    }),
    station(allCauses, {
      ...approvalWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_APPROVAL_LOST",
      trigger: "The grant was consumed, then coordination was lost.",
      repairAction:
        "Inspect unfinished work; the consumed grant is not refunded.",
      guidance: {
        handoff: {
          owner: "human",
          reason: "A new grant is needed.",
          inspect: [pendingStep],
        },
      },
      independentObservable: `${identity}:approval-lost`,
    }),
    station(allCauses, {
      ...approvalWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_APPROVAL_STORE",
      trigger: "The approval store could not be read or written.",
      repairAction: "Repair the approval store; the grant is preserved.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "The approval store is unavailable.",
          inspect: [
            { kind: "instruction", text: "Inspect the approval store." },
          ],
        },
      },
      independentObservable: `${identity}:approval-store`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_LOCK_HELD",
      trigger: "A live run owns a conflicting scope.",
      repairAction:
        "Inspect the live owner's case and the resource. Wait for it to finish; never delete coordination files.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "A live run still holds this scope.",
          inspect: [historyStep],
        },
      },
      independentObservable: `${identity}:held-lock`,
    }),
    station(allCauses, {
      ...unresolvedWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_UNRESOLVED",
      trigger: "An unfinished operation conflicts with this change.",
      repairAction:
        "Inspect the blocking case and its retained history, then follow its authorised recovery route. Never replay the interrupted operation.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "A conflicting earlier operation remains unresolved.",
          inspect: [historyStep],
        },
      },
      independentObservable: `${identity}:unresolved`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_UNAVAILABLE",
      trigger:
        "Coordination, the state store or a gated capability is unavailable.",
      repairAction:
        "Inspect the state store and the capability report; the qualification gate stays closed until reviewed.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "The state add-on cannot safely admit this change here.",
          inspect: [{ kind: "command", command: "sx.capabilities", args: [] }],
        },
      },
      independentObservable: `${identity}:unavailable`,
    }),
    station(allCauses, {
      ...retryWords,
      commandIdentity: identity,
      causeCode: "TRANSIENT_NOT_STARTED",
      trigger:
        "A temporary condition was confirmed before any intent: the admission coordination lock stayed busy, or a host dependency is down.",
      repairAction: "Retry the same invocation after the delay.",
      guidance: { next: { kind: "retry" } },
      independentObservable: `${identity}:not-started`,
    }),
  ] as const;
}

function changeStations<const Identity extends Changing>(identity: Identity) {
  const inspect = {
    owner: "operator",
    reason: "Some effects are not confirmed complete.",
    inspect: [pendingStep],
  } as const;
  return [
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Every effect was written and independently read back.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: `${identity}:completed`,
    }),
    station(allCauses, {
      ...retryWords,
      commandIdentity: identity,
      causeCode: "TRANSIENT_ATTEMPT_UNCHANGED",
      trigger:
        "The attempt began and failed temporarily before any effect started.",
      repairAction: "Retry the same invocation after the delay.",
      guidance: { next: { kind: "retry" } },
      independentObservable: `${identity}:attempt-unchanged`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_CHANGE_PARTIAL",
      trigger: "A known subset of effects completed.",
      repairAction:
        "Inspect the unfinished case before any separately authorised recovery.",
      guidance: { handoff: inspect },
      independentObservable: `${identity}:partial`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_SX_CHANGE_UNKNOWN",
      trigger: "An effect could not be confirmed.",
      repairAction: "Independently inspect effect state before any retry.",
      guidance: { handoff: inspect },
      independentObservable: `${identity}:unknown`,
    }),
  ] as const;
}

function writeNote(path: string, content: string, runTag: string): string {
  if (fault === "write-fails") throw new Error("Synthetic write failure.");
  if (fault === "silent") return path;
  writeFileSync(path, fault === "wrong-content" ? `${content}!` : content);
  ledger(`note.write ${realpathSync.native(path)} ${runTag}`);
  return path;
}
function readNote(path: string, content: string): Promise<boolean> {
  if (fault === "readback-throws")
    return Promise.reject(new Error("Synthetic read-back failure."));
  return Promise.resolve(
    existsSync(path) && readFileSync(path, "utf8") === content,
  );
}
function delayFor(): number {
  return fault === "delay-low" ? 10 : fault === "delay-high" ? 5_000 : 100;
}

type Proof = Awaited<ReturnType<typeof state.transaction>>["proof"];
type Message = { readonly message: string };
type BoundCause = "DOMAIN_SX_LOCK_HELD" | "DOMAIN_SX_UNRESOLVED";
type CloseCause =
  | "DOMAIN_SX_CLOSE_OWNER_LIVE"
  | "DOMAIN_SX_CLOSE_EVIDENCE"
  | "DOMAIN_SX_CLOSE_CONFLICT"
  | "DOMAIN_SX_CLOSE_STALE"
  | "DOMAIN_SX_CASE_NOT_FOUND";
type Plan =
  | {
      readonly shape: "close";
      readonly cause: CloseCause;
      readonly facts: Message & {
        readonly data: null;
        readonly effects: typeof empty;
        readonly bindings: { readonly operationId: string };
      };
    }
  | {
      readonly shape: "bound";
      readonly cause: BoundCause;
      readonly facts: Message & {
        readonly data: null;
        readonly effects: typeof empty;
        readonly bindings: { readonly operationId: string };
      };
    }
  | {
      readonly shape: "refused";
      readonly cause:
        | "DOMAIN_SX_UNAVAILABLE"
        | "DOMAIN_SX_APPROVAL_LOST"
        | "DOMAIN_SX_APPROVAL_STORE"
        | "DOMAIN_AUTHORITY_REQUIRED";
      readonly facts: Message & {
        readonly data: null;
        readonly effects: typeof empty;
      };
    }
  | {
      readonly shape: "not-started";
      readonly cause: "TRANSIENT_NOT_STARTED";
      readonly facts: Message & {
        readonly data: null;
        readonly effects: typeof empty;
        readonly retryDelayMilliseconds: number;
      };
    }
  | {
      readonly shape: "completed";
      readonly cause: "SUCCESS_COMPLETED";
      readonly facts: Message & {
        readonly data: JsonValue;
        readonly transaction: Proof;
      };
    }
  | {
      readonly shape: "failed";
      readonly cause: "DOMAIN_SX_CHANGE_PARTIAL" | "DOMAIN_SX_CHANGE_UNKNOWN";
      readonly facts: Message & {
        readonly data: null;
        readonly transaction: Proof;
      };
    }
  | {
      readonly shape: "attempt-unchanged";
      readonly cause: "TRANSIENT_ATTEMPT_UNCHANGED";
      readonly facts: Message & {
        readonly data: null;
        readonly transaction: Proof;
        readonly retryDelayMilliseconds: number;
      };
    };

function bound(cause: BoundCause, message: string, operationId: string): Plan {
  return {
    shape: "bound",
    cause,
    facts: { message, data: null, effects: empty, bindings: { operationId } },
  };
}
function closeBound(
  cause: CloseCause,
  message: string,
  operationId: string,
): Plan {
  return {
    shape: "close",
    cause,
    facts: { message, data: null, effects: empty, bindings: { operationId } },
  };
}
function refused(
  cause: Extract<Plan, { readonly shape: "refused" }>["cause"],
  message: string,
): Plan {
  return {
    shape: "refused",
    cause,
    facts: { message, data: null, effects: empty },
  };
}
function notStarted(message: string): Plan {
  return {
    shape: "not-started",
    cause: "TRANSIENT_NOT_STARTED",
    facts: {
      message,
      data: null,
      effects: empty,
      retryDelayMilliseconds: delayFor(),
    },
  };
}

function refusalPlan(outcome: {
  readonly kind: string;
  readonly operationId?: string;
  readonly reason?: string;
  readonly detail?: string;
}): Plan {
  switch (outcome.kind) {
    case "held-lock":
      return bound(
        "DOMAIN_SX_LOCK_HELD",
        "A live run owns a conflicting scope.",
        outcome.operationId ?? "",
      );
    case "unresolved-case":
      return bound(
        "DOMAIN_SX_UNRESOLVED",
        "An unfinished operation conflicts with this change.",
        outcome.operationId ?? "",
      );
    case "busy":
      return notStarted("Admission coordination was busy; nothing started.");
    case "denied":
      return refused(
        "DOMAIN_AUTHORITY_REQUIRED",
        "The required authority was not confirmed.",
      );
    case "approval-lost":
      return refused(
        "DOMAIN_SX_APPROVAL_LOST",
        "The grant was consumed but coordination was lost; nothing started.",
      );
    case "approval-unavailable":
      return refused(
        "DOMAIN_SX_APPROVAL_STORE",
        "The approval store is unavailable; the grant is preserved.",
      );
    default:
      return refused(
        "DOMAIN_SX_UNAVAILABLE",
        `State unavailable: ${outcome.reason ?? outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ""}.`,
      );
  }
}

function changePlan(
  outcome: Awaited<ReturnType<typeof state.transaction>>,
): Plan {
  if (outcome.kind !== "ran") return refusalPlan(outcome);
  const proof = outcome.proof;
  switch (proof.transactionState) {
    case "completed":
      return {
        shape: "completed",
        cause: "SUCCESS_COMPLETED",
        facts: {
          message: "Every effect was written and read back.",
          data: { operationId: outcome.operationId },
          transaction: proof,
        },
      };
    case "partially-completed":
      return {
        shape: "failed",
        cause: "DOMAIN_SX_CHANGE_PARTIAL",
        facts: {
          message: "Some effects completed.",
          data: null,
          transaction: proof,
        },
      };
    case "unknown":
      return {
        shape: "failed",
        cause: "DOMAIN_SX_CHANGE_UNKNOWN",
        facts: {
          message: "An effect is unconfirmed.",
          data: null,
          transaction: proof,
        },
      };
    case "unchanged":
      return {
        shape: "attempt-unchanged",
        cause: "TRANSIENT_ATTEMPT_UNCHANGED",
        facts: {
          message: "The attempt failed temporarily before any effect.",
          data: null,
          transaction: proof,
          retryDelayMilliseconds: delayFor(),
        },
      };
  }
}

const nameArgument = {
  name: "name",
  summary: "Note name.",
  required: true,
  value: {
    kind: "string",
    minLength: 1,
    maxLength: 64,
    choices: null,
    pattern: "^[A-Za-z0-9._-]+$",
  },
} as const;
const textOption = <const Name extends string>(name: Name, required = false) =>
  ({
    name,
    aliases: [],
    summary: `Specimen ${name}.`,
    required,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 512,
      choices: null,
      pattern: null,
    },
  }) as const;
const requiredText = <const Name extends string>(name: Name) =>
  ({ ...textOption(name), required: true }) as const;
const flagOption = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Specimen ${name}.`,
    required: false,
    repeatable: false,
    value: null,
  }) as const;
const changeInput = {
  arguments: [nameArgument],
  options: [
    requiredText("--content"),
    textOption("--path"),
    textOption("--id"),
    textOption("--invariant"),
    textOption("--also"),
    flagOption("--unknown-scope"),
  ],
  constraints: [],
  deadlineSupported: true,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const messageInput = {
  arguments: [
    { ...nameArgument, name: "message", summary: "Message identifier." },
  ],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

type NoteInput = {
  readonly name: string;
  readonly "--content": string;
  readonly "--path"?: string;
  readonly "--id"?: string;
  readonly "--invariant"?: string;
  readonly "--also"?: string;
  readonly "--unknown-scope"?: boolean;
};

function resolveId(id: string): string {
  const table: unknown = JSON.parse(
    readFileSync(join(world, "ids.json"), "utf8"),
  );
  const mapped: unknown =
    typeof table === "object" && table !== null
      ? Reflect.get(table, id)
      : undefined;
  return typeof mapped === "string" ? mapped : id;
}

function noteDeclaration(command: string, input: NoteInput) {
  mkdirSync(notes, { recursive: true });
  const name =
    input["--id"] === undefined ? input.name : resolveId(input["--id"]);
  const path = input["--path"] ?? join(notes, name);
  const also = input["--also"];
  const known = {
    resources: [
      { resource: `note:${name}`, path },
      ...(also ? [{ resource: `note:${also}`, path: join(notes, also) }] : []),
    ],
  };
  const invariant = input["--invariant"];
  const scoped = invariant ? { ...known, invariants: [invariant] } : known;
  return {
    path,
    declaration: {
      command,
      scope: input["--unknown-scope"] ? ({ unknown: true } as const) : scoped,
      revisions: { [`note:${name}`]: "observed" },
      facts: { path, content: input["--content"] },
    },
  };
}

function noteWork(path: string, content: string) {
  return async (transaction: EffectTransaction<"note.write">) => {
    await barrier("pre-effect");
    if (fault === "transient-after-intent") return;
    await transaction.record(
      "note.write",
      async (recorded) => {
        if (fault === "admit-delegate")
          await recorded.admitStart(recorded.runId, recorded.effect, () =>
            Promise.resolve(0),
          );
        await barrier("intent");
        return writeNote(path, content, "apply");
      },
      async (written) => {
        await barrier("effect");
        return readNote(written, content);
      },
    );
  };
}

const apply = changing({
  identity: "sx.apply",
  route: ["apply"],
  summary: "Write one synthetic note.",
  input: changeInput,
  capabilities: {},
  effectClass: "repository-local",
  effects: ["note.write"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [
    ...coordinationStations("sx.apply"),
    ...changeStations("sx.apply"),
  ],
  run: async (input, context) => {
    await barrier("pre-admission");
    const { path, declaration } = noteDeclaration("sx.apply", input);
    const plan = existsSync(join(world, "dependency.down"))
      ? notStarted("A host dependency is down; nothing started.")
      : changePlan(
          await state.transaction(
            context.state,
            declaration,
            noteWork(path, input["--content"]),
          ),
        );
    await barrier("complete");
    if (fault === "refuse-after-complete" && plan.shape === "completed")
      return context.result(
        { commandIdentity: "sx.apply", causeCode: "DOMAIN_SX_UNAVAILABLE" },
        {
          message: "Refusing after the change completed.",
          data: null,
          effects: empty,
        },
      );
    switch (plan.shape) {
      case "close":
        throw new Error("Only the closure command selects closure stations.");
      case "bound":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        return context.result(
          { commandIdentity: "sx.apply", causeCode: plan.cause },
          plan.facts,
        );
    }
  },
});

const apply2 = changing({
  identity: "sx.apply2",
  route: ["apply2"],
  summary: "Write a synthetic note and its stamp.",
  input: changeInput,
  capabilities: {},
  effectClass: "repository-local",
  effects: ["note.write", "note.stamp"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [
    ...coordinationStations("sx.apply2"),
    ...changeStations("sx.apply2"),
  ],
  run: async (input, context) => {
    const { path, declaration } = noteDeclaration("sx.apply2", input);
    const content = input["--content"];
    const outcome = await state.transaction(
      context.state,
      declaration,
      async (transaction) => {
        await transaction.record(
          "note.write",
          () => Promise.resolve(writeNote(path, content, "apply2")),
          (written) => readNote(written, content),
        );
        await barrier("first-confirmed");
        await transaction.record(
          "note.stamp",
          async () => {
            await barrier("second-started");
            writeFileSync(`${path}.stamp`, "stamp");
            ledger(`note.stamp ${realpathSync.native(path)}.stamp apply2`);
            return `${path}.stamp`;
          },
          (stamp) => Promise.resolve(existsSync(stamp)),
        );
      },
    );
    const plan = changePlan(outcome);
    switch (plan.shape) {
      case "close":
        throw new Error("Only the closure command selects closure stations.");
      case "bound":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        return context.result(
          { commandIdentity: "sx.apply2", causeCode: plan.cause },
          plan.facts,
        );
    }
  },
});

const send = changing({
  identity: "sx.send",
  route: ["send"],
  summary: "Send one synthetic message.",
  input: messageInput,
  capabilities: {},
  effectClass: "external",
  effects: ["message.send"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [...coordinationStations("sx.send"), ...changeStations("sx.send")],
  run: async (input, context) => {
    mkdirSync(outbox, { recursive: true });
    const id = input.message;
    const outcome = await state.transaction(
      context.state,
      {
        command: "sx.send",
        scope: {
          resources: [{ resource: `message:${id}`, key: `message:${id}` }],
        },
        facts: { message: id },
      },
      async (transaction, published) => {
        await transaction.record(
          "message.send",
          async () => {
            appendFileSync(labels, `${published.operationId} ${id}\n`);
            await barrier("intent");
            appendFileSync(providerLog, `sent ${id} send\n`);
            writeFileSync(join(outbox, id), "message");
            ledger(`message.send ${id} send`);
            await barrier("effect");
            return id;
          },
          (sent) => Promise.resolve(existsSync(join(outbox, sent))),
        );
      },
    );
    const plan = changePlan(outcome);
    switch (plan.shape) {
      case "close":
        throw new Error("Only the closure command selects closure stations.");
      case "bound":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        return context.result(
          { commandIdentity: "sx.send", causeCode: plan.cause },
          plan.facts,
        );
    }
  },
});

const audit = changing({
  identity: "sx.audit",
  route: ["audit"],
  summary: "Emit one unobservable synthetic audit event.",
  input: messageInput,
  capabilities: {},
  effectClass: "external",
  effects: ["audit.emit"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [
    ...coordinationStations("sx.audit"),
    ...changeStations("sx.audit"),
  ],
  run: async (input, context) => {
    const outcome = await state.transaction(
      context.state,
      {
        command: "sx.audit",
        scope: {
          resources: [
            {
              resource: `audit:${input.message}`,
              key: `audit:${input.message}`,
            },
          ],
        },
        facts: { message: input.message },
      },
      async (transaction) => {
        await transaction.record(
          "audit.emit",
          async () => {
            ledger(`audit.emit ${input.message} audit`);
            await barrier("effect");
            return input.message;
          },
          () => Promise.resolve(true),
        );
      },
    );
    const plan = changePlan(outcome);
    switch (plan.shape) {
      case "close":
        throw new Error("Only the closure command selects closure stations.");
      case "bound":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        return context.result(
          { commandIdentity: "sx.audit", causeCode: plan.cause },
          plan.facts,
        );
    }
  },
});

const approvalStore = {
  grants: join(world, "approval", "grants"),
  consumed: join(world, "approval", "consumed"),
};
let approvalRuntime: ApprovalRuntime | undefined;
export const approvalAddon: RunAddon<ApprovalCapability> = {
  attach(run) {
    const instance = approval({
      operation: "sx.approved",
      runId: run.runId,
      store: approvalStore,
    });
    approvalRuntime = instance.runtime(state.descriptor);
    return {
      capability: instance.capability,
      settle: () => Promise.resolve(true),
      killNow: () => {},
    };
  },
};
const approvedInput = {
  ...changeInput,
  options: [...changeInput.options, requiredText("--preview")],
} as const;
const composed: {
  boundary?: {
    readonly authority: (value: unknown) => AuthorityId;
    readonly resource: (value: unknown) => ResourceId;
  };
} = {};
function approvalRequest(input: {
  readonly name: string;
  readonly "--preview": string;
}): ApprovalRequest {
  const boundary = composed.boundary;
  if (!boundary) throw new Error("Contract not composed.");
  return {
    authority: boundary.authority("sx-owner"),
    resource: boundary.resource(`note:${input.name}`),
    resourceRevision: "observed",
    effects: ["note.write"],
    preview: input["--preview"],
  };
}
const approved = changing({
  identity: "sx.approved",
  route: ["approved"],
  summary: "Write one synthetic note under an exact-item approval.",
  input: approvedInput,
  capabilities: { approval: true },
  approval: approvalRequest,
  effectClass: "repository-local",
  effects: ["note.write"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [
    ...coordinationStations("sx.approved", { approval: true }),
    ...changeStations("sx.approved"),
  ],
  run: async (input, context) => {
    const runtime = approvalRuntime;
    if (!runtime) throw new Error("Approval runtime was not attached.");
    await barrier("pre-admission");
    const { path, declaration } = noteDeclaration("sx.approved", input);
    const plan = changePlan(
      await state.transaction(
        context.state,
        {
          ...declaration,
          approval: { runtime, request: approvalRequest(input) },
        },
        noteWork(path, input["--content"]),
      ),
    );
    switch (plan.shape) {
      case "close":
        throw new Error("Only the closure command selects closure stations.");
      case "bound":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        return context.result(
          { commandIdentity: "sx.approved", causeCode: plan.cause },
          plan.facts,
        );
    }
  },
});
const pattern = <const Name extends string>(
  name: Name,
  summary: string,
  regex: string,
) =>
  ({
    name,
    aliases: [],
    summary,
    required: true,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 128,
      choices: null,
      pattern: regex,
    },
  }) as const;
const operationArgument = {
  name: "operationId",
  summary: "Durable operation identity.",
  required: true,
  value: {
    kind: "string",
    minLength: 35,
    maxLength: 35,
    choices: null,
    pattern: "^op-[0-9a-f]{32}$",
  },
} as const;
const closeInput = {
  arguments: [operationArgument],
  options: [
    {
      name: "--disposition",
      aliases: [],
      summary: "Proposed closure disposition.",
      required: true,
      repeatable: false,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 32,
        choices: ["completed", "not-applied", "outcome-unknown"],
        pattern: null,
      },
    },
    pattern("--closure-id", "Closure identity.", "^[a-z0-9][a-z0-9-]{0,63}$"),
    pattern("--revision", "Journal revision being closed.", "^r-[0-9a-f]{64}$"),
    requiredText("--reason"),
    textOption("--attestation"),
    textOption("--grant"),
    flagOption("--human-approved"),
  ],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const closeHandoff = (reason: string) =>
  ({ owner: "operator", reason, inspect: [historyStep] }) as const;
const closeRefusal = (
  causeCode:
    | "DOMAIN_SX_CLOSE_OWNER_LIVE"
    | "DOMAIN_SX_CLOSE_EVIDENCE"
    | "DOMAIN_SX_CLOSE_CONFLICT"
    | "DOMAIN_SX_CLOSE_STALE"
    | "DOMAIN_SX_CASE_NOT_FOUND",
  trigger: string,
  repairAction: string,
) =>
  station(allCauses, {
    ...words,
    commandIdentity: "sx.close",
    causeCode,
    trigger,
    repairAction,
    guidance: { handoff: closeHandoff(trigger) },
    independentObservable: `sx.close:${causeCode}`,
  });

function closePlan(
  outcome: Awaited<ReturnType<typeof state.close>>,
  operationId: string,
): Plan {
  switch (outcome.kind) {
    case "closed":
      return {
        shape: "completed",
        cause: "SUCCESS_COMPLETED",
        facts: {
          message:
            "The closure was recorded. The original operation's effects are unchanged.",
          data: {
            operationId,
            closureId: outcome.closure.closureId,
            disposition: outcome.closure.disposition,
            recoveryOperationId: outcome.recoveryOperationId,
          },
          transaction: outcome.proof,
        },
      };
    case "recovery-failed":
      return {
        shape: "failed",
        cause: "DOMAIN_SX_CHANGE_UNKNOWN",
        facts: {
          message: "The closure record is unconfirmed.",
          data: null,
          transaction: outcome.proof,
        },
      };
    case "owner-live":
      return closeBound(
        "DOMAIN_SX_CLOSE_OWNER_LIVE",
        "The case's owner is still live.",
        operationId,
      );
    case "evidence-insufficient":
      return closeBound(
        "DOMAIN_SX_CLOSE_EVIDENCE",
        `Independent evidence does not support this disposition: ${JSON.stringify(outcome.classes)}.`,
        operationId,
      );
    case "conflict":
    case "not-unresolved":
      return closeBound(
        "DOMAIN_SX_CLOSE_CONFLICT",
        "The case already has a different closure.",
        operationId,
      );
    case "stale-revision":
      return closeBound(
        "DOMAIN_SX_CLOSE_STALE",
        "The journal revision changed.",
        operationId,
      );
    case "not-found":
      return closeBound(
        "DOMAIN_SX_CASE_NOT_FOUND",
        "No such operation.",
        operationId,
      );
    case "already-closed":
      return refused("DOMAIN_SX_UNAVAILABLE", "unreachable");
    case "held-lock":
    case "unresolved-case":
    case "busy":
    case "denied":
    case "approval-lost":
    case "approval-unavailable":
    case "unavailable":
      return refusalPlan(outcome);
  }
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry: unknown) => toJson(entry));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value))
      if (entry !== undefined) out[key] = toJson(entry);
    return out;
  }
  return null;
}

const close = changing({
  identity: "sx.close",
  route: ["close"],
  summary: "Record one closure for an unresolved operation. Never replays it.",
  input: closeInput,
  capabilities: {},
  effectClass: "repository-local",
  effects: ["state.closure"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_SX_LOCK_HELD",
  unresolvedCaseCause: "DOMAIN_SX_UNRESOLVED",
  stations: [
    ...coordinationStations("sx.close", { unresolved: false }),
    station(allCauses, {
      ...words,
      commandIdentity: "sx.close",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "The closure record was published and read back.",
      repairAction: null,
      guidance: { next: pendingStep },
      independentObservable: "sx.close:completed",
    }),
    station(allCauses, {
      ...words,
      commandIdentity: "sx.close",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The same closure was already recorded.",
      repairAction: null,
      guidance: { next: pendingStep },
      independentObservable: "sx.close:unchanged",
    }),
    station(allCauses, {
      ...words,
      commandIdentity: "sx.close",
      causeCode: "DOMAIN_SX_CHANGE_UNKNOWN",
      trigger: "The closure record could not be confirmed.",
      repairAction: "Inspect the case history before another closure attempt.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "Closure unconfirmed.",
          inspect: [pendingStep],
        },
      },
      independentObservable: "sx.close:unknown",
    }),
    closeRefusal(
      "DOMAIN_SX_CLOSE_OWNER_LIVE",
      "The case's owner is still live.",
      "Wait for the live owner; closure never releases a live writer.",
    ),
    closeRefusal(
      "DOMAIN_SX_CLOSE_EVIDENCE",
      "Independent evidence does not support this disposition.",
      "Inspect the resource; absence alone never proves not-applied.",
    ),
    closeRefusal(
      "DOMAIN_SX_CLOSE_CONFLICT",
      "The case already has a different closure.",
      "Inspect the retained closure; closures are never rewritten.",
    ),
    closeRefusal(
      "DOMAIN_SX_CLOSE_STALE",
      "The journal revision changed.",
      "Read the case history again and decide under its current revision.",
    ),
    closeRefusal(
      "DOMAIN_SX_CASE_NOT_FOUND",
      "No such operation.",
      "Read the unfinished report for valid operation identities.",
    ),
  ],
  run: async (input, context) => {
    const closure = {
      command: "sx.close",
      effect: "state.closure",
      operationId: input.operationId,
      closureId: input["--closure-id"],
      disposition:
        input["--disposition"] === "completed"
          ? "completed"
          : input["--disposition"] === "not-applied"
            ? "not-applied"
            : "outcome-unknown",
      revision: input["--revision"],
      reason: input["--reason"],
    } as const;
    const outcome = await state.close(
      context.state,
      input["--attestation"] === undefined
        ? closure
        : { ...closure, attestation: true },
    );
    if (outcome.kind === "already-closed")
      return context.result(
        { commandIdentity: "sx.close", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "This closure was already recorded; nothing changed.",
          data: {
            operationId: input.operationId,
            closureId: outcome.closure.closureId,
            disposition: outcome.closure.disposition,
          },
          transaction: outcome.proof,
        },
      );
    const plan = closePlan(outcome, input.operationId);
    switch (plan.shape) {
      case "close":
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "bound":
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "refused":
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "not-started":
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "completed":
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "failed":
        if (plan.cause !== "DOMAIN_SX_CHANGE_UNKNOWN")
          throw new Error("Closure is a single effect: never partial.");
        return context.result(
          { commandIdentity: "sx.close", causeCode: plan.cause },
          plan.facts,
        );
      case "attempt-unchanged":
        throw new Error("Closure has no attempt-unchanged station.");
    }
  },
});

const unreadable = <const Identity extends "sx.pending" | "sx.history">(
  identity: Identity,
) =>
  station(allCauses, {
    ...words,
    commandIdentity: identity,
    causeCode: "SCHEMA_SX_STATE_UNREADABLE",
    trigger: "The journal is missing, unreadable or corrupt.",
    repairAction:
      "Inspect the state store. An unreadable report never proves nothing is unfinished.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "Unfinished work cannot be established.",
        inspect: [
          {
            kind: "instruction",
            text: "Inspect the state store directory and its records.",
          },
        ],
      },
    },
    independentObservable: `${identity}:unreadable`,
  });

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const pending = command({
  identity: "sx.pending",
  route: ["pending"],
  summary: "Report unfinished operations. Read-only.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "sx.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The journal was read completely.",
      repairAction: null,
      guidance: {
        next: {
          kind: "instruction",
          text: "Inspect each listed case with sx history before deciding more affected work. An empty list does not prove the lost run never happened.",
        },
      },
      independentObservable: "sx.pending:read",
    }),
    unreadable("sx.pending"),
  ],
  run: (_input, context) => {
    const report = state.report();
    return report.ok
      ? context.result(
          { commandIdentity: "sx.pending", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Unfinished operations.",
            data: {
              unfinished: report.unfinished.map((entry) => ({
                ...entry,
                effects: [...entry.effects],
              })),
            },
            effects: empty,
          },
        )
      : context.result(
          {
            commandIdentity: "sx.pending",
            causeCode: "SCHEMA_SX_STATE_UNREADABLE",
          },
          {
            message: `The journal is ${report.reason}.`,
            data: null,
            effects: empty,
          },
        );
  },
});

const history = command({
  identity: "sx.history",
  route: ["history"],
  summary: "Read one operation's retained evidence. Read-only.",
  input: { ...none, arguments: [operationArgument] },
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "sx.history",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The case history was read.",
      repairAction: null,
      guidance: {
        next: {
          kind: "instruction",
          text: "Decide closure only through sx close under current authority. Never replay the operation.",
        },
      },
      independentObservable: "sx.history:read",
    }),
    unreadable("sx.history"),
    station(allCauses, {
      ...words,
      commandIdentity: "sx.history",
      causeCode: "DOMAIN_SX_CASE_NOT_FOUND",
      trigger: "No such operation.",
      repairAction:
        "Read the unfinished report for valid operation identities.",
      guidance: {
        handoff: {
          owner: "operator",
          reason: "Unknown operation.",
          inspect: [pendingStep],
        },
      },
      independentObservable: "sx.history:not-found",
    }),
  ],
  run: async (input, context) => {
    const found = await state.history(input.operationId);
    if (found.ok)
      return context.result(
        { commandIdentity: "sx.history", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Case history.",
          data: toJson(found.history),
          effects: empty,
        },
      );
    return found.reason === "not-found"
      ? context.result(
          {
            commandIdentity: "sx.history",
            causeCode: "DOMAIN_SX_CASE_NOT_FOUND",
          },
          { message: "No such operation.", data: null, effects: empty },
        )
      : context.result(
          {
            commandIdentity: "sx.history",
            causeCode: "SCHEMA_SX_STATE_UNREADABLE",
          },
          {
            message: `The journal is ${found.reason}.`,
            data: null,
            effects: empty,
          },
        );
  },
});

const capabilitiesCommand = command({
  identity: "sx.capabilities",
  route: ["capabilities"],
  summary: "Report gated state capabilities. Read-only.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "sx.capabilities",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Capabilities were read.",
      repairAction: null,
      guidance: {
        next: {
          kind: "instruction",
          text: "Treat unavailable capabilities as a handoff.",
        },
      },
      independentObservable: "sx.capabilities:read",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "sx.capabilities", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "State capabilities.",
        data: toJson(state.capabilities()),
        effects: empty,
      },
    ),
});

function compose() {
  return contractFor({
    cli: "sx",
    commands: [
      apply,
      apply2,
      send,
      audit,
      approved,
      close,
      pending,
      history,
      capabilitiesCommand,
    ],
    state: state.descriptor,
    causes,
    installedAddons: ["state", "approval"],
  });
}
export const contract = compose();
composed.boundary = contract.boundary;

if (import.meta.main) {
  const code = await runProcess(contract, {
    addons: { approval: approvalAddon },
    emergencyRecord: state.emergencyRecord,
  })(process.argv.slice(2));
  process.exitCode = code;
}
