import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  EffectTransaction,
  StateCapability,
} from "../../../../kernel/src/kernel/index.ts";
import {
  approval,
  grantLocation,
} from "../../../../kernel/src/addons/approval/index.ts";
import { stateAddonWithTestSeams } from "../../../../kernel/src/addons/state/fixture.ts";
import type { Phase } from "../../../../kernel/src/addons/state/fixture.ts";
import type {
  Declaration,
  TransactionResult,
} from "../../../../kernel/src/addons/state/index.ts";
import { layout, readCase } from "../../../../kernel/src/addons/state/store.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../../kernel-repair/shapes.ts";
import { deferred } from "../../lifecycle/recording-host.ts";
import { testFolder } from "../../../support/test-folder.ts";
import { getFsTrace } from "./trace-fs-preload.ts";

const trace = getFsTrace();
const fs = trace.orig;

const causes = {
  DOMAIN_SU_LOCK_HELD: refusedHandoff,
  DOMAIN_SU_UNRESOLVED: refusedHandoff,
  DOMAIN_SU_UNAVAILABLE: refusedHandoff,
  DOMAIN_SU_PARTIAL: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "partially-completed",
  },
  DOMAIN_SU_UNKNOWN: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "unknown",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
type AllCauseCode = keyof typeof allCauses;
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "su.pending", args: [] }],
  },
} as const;
const defaultEffects = ["doc.write", "editor.launch"] as const;
type Effects = (typeof defaultEffects)[number];
type Boundary = ReturnType<typeof contractFor>["boundary"];

function actorStations() {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "SUCCESS_COMPLETED.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "su.open:SUCCESS_COMPLETED",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "DOMAIN_SU_LOCK_HELD",
      trigger: "DOMAIN_SU_LOCK_HELD.",
      repairAction: "Wait.",
      guidance: handoff,
      independentObservable: "su.open:DOMAIN_SU_LOCK_HELD",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "DOMAIN_SU_UNRESOLVED",
      trigger: "DOMAIN_SU_UNRESOLVED.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "su.open:DOMAIN_SU_UNRESOLVED",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "DOMAIN_SU_UNAVAILABLE",
      trigger: "DOMAIN_SU_UNAVAILABLE.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "su.open:DOMAIN_SU_UNAVAILABLE",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "DOMAIN_SU_PARTIAL",
      trigger: "DOMAIN_SU_PARTIAL.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "su.open:DOMAIN_SU_PARTIAL",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "su.open",
      causeCode: "DOMAIN_SU_UNKNOWN",
      trigger: "DOMAIN_SU_UNKNOWN.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "su.open:DOMAIN_SU_UNKNOWN",
    }),
  ] as const;
}

function pendingCommand() {
  return command({
    identity: "su.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "su.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

type HostContext = {
  readonly state: ReturnType<typeof stateAddonWithTestSeams>;
  readonly capability: StateCapability<Effects>;
  readonly boundary: Boundary;
};

type HostRun = {
  readonly root: string;
  readonly phase?: (name: Phase) => Promise<void>;
  readonly argv?: readonly string[];
  readonly handler: (
    ctx: HostContext,
  ) => Promise<TransactionResult<Effects> | undefined>;
};

async function runHost(options: HostRun) {
  const state = stateAddonWithTestSeams(
    { root: options.root, report: "su.pending" },
    options.phase ? { phase: options.phase } : {},
  );
  const holder: { boundary?: Boundary } = {};
  const actor = changing({
    identity: "su.open",
    route: ["open"],
    summary: "Run changing command.",
    input: { ...emptyInput, deadlineSupported: true as const },
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SU_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
    stations: actorStations(),
    run: async (_input, context) => {
      const boundary = holder.boundary;
      if (!boundary) throw new Error("Boundary expected.");
      const outcome = await options.handler({
        state,
        capability: context.state,
        boundary,
      });
      const unavailable = (message: string) =>
        context.result(
          { commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message, data: null, effects: unchanged },
        );
      if (outcome === undefined) return unavailable("early-return");
      if (outcome.kind !== "ran") {
        const refusalCode: AllCauseCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_SU_LOCK_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_SU_UNRESOLVED"
              : "DOMAIN_SU_UNAVAILABLE";
        return context.result(
          { commandIdentity: "su.open", causeCode: refusalCode },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      }
      const stateName = outcome.proof.transactionState;
      if (stateName === "unchanged") return unavailable("unchanged");
      const ranCode: AllCauseCode =
        stateName === "completed"
          ? "SUCCESS_COMPLETED"
          : stateName === "partially-completed"
            ? "DOMAIN_SU_PARTIAL"
            : "DOMAIN_SU_UNKNOWN";
      return context.result(
        { commandIdentity: "su.open", causeCode: ranCode },
        { message: stateName, data: null, transaction: outcome.proof },
      );
    },
  });
  const contract = contractFor({
    cli: "su",
    commands: [pendingCommand(), actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  holder.boundary = contract.boundary;
  const ran = await runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  })([...(options.argv ?? ["open"])]);
  return { state, ran };
}

async function completeWork(
  transaction: EffectTransaction<Effects>,
): Promise<void> {
  for (const effect of defaultEffects)
    await transaction.record(
      effect,
      () => Promise.resolve(),
      () => Promise.resolve(true),
    );
}

async function seed(
  root: string,
  key: string,
  unresolved: boolean,
): Promise<void> {
  const { ran } = await runHost({
    root,
    handler: ({ state, capability }) =>
      state.transaction(
        capability,
        {
          command: "su.open",
          scope: { resources: [{ resource: "doc", key }] },
        },
        unresolved
          ? async (transaction) => {
              await transaction.record(
                "doc.write",
                () => Promise.resolve(),
                () => Promise.resolve(false),
              );
            }
          : completeWork,
      ),
  });
  if (ran.kind !== "envelope") throw new Error(`seed failed: ${ran.kind}`);
}

function kernelFrames(stack: string): string[] {
  return stack.split("\n").flatMap((line) => {
    const match = /kernel\/src\/(.+?):(\d+):\d+\)?$/.exec(line.trim());
    return match ? [`${match[1] ?? ""}:${match[2] ?? ""}`] : [];
  });
}

function site(stack: string): string {
  const frames = kernelFrames(stack);
  return frames.slice(0, 3).join(" <- ") || "(no kernel frame)";
}

type Read = { readonly late: boolean; readonly stack: string };
type Class1Finding = {
  readonly kind: "DOUBLE" | "LATE" | "THENABLE";
  readonly what: string;
  readonly count: number;
  readonly sites: readonly string[];
};

function createWatcher() {
  const reads = new Map<object, Map<string, Read[]>>();
  const labels = new Map<object, string>();
  const tree = new Set<object>();
  const memo = new Map<object, object>();
  const status = { admitted: false };

  function note(proxy: object, key: string): void {
    let table = reads.get(proxy);
    if (!table) {
      table = new Map<string, Read[]>();
      reads.set(proxy, table);
    }
    let list = table.get(key);
    if (!list) {
      list = [];
      table.set(key, list);
    }
    list.push({ late: status.admitted, stack: new Error().stack ?? "" });
  }

  function watch<T extends object>(
    target: T,
    label: string,
    inTree: boolean,
  ): T {
    const proxy: T = new Proxy(target, {
      get(inner, key, receiver) {
        note(proxy, typeof key === "symbol" ? key.toString() : key);
        return Reflect.get(inner, key, receiver);
      },
      ownKeys(inner) {
        note(proxy, "<ownKeys>");
        return Reflect.ownKeys(inner);
      },
    });
    labels.set(proxy, label);
    if (inTree) tree.add(proxy);
    return proxy;
  }

  function deep(value: unknown, label: string, inTree = true): unknown {
    if (typeof value !== "object" || value === null) return value;
    const known = memo.get(value);
    if (known) return known;
    if (labels.has(value)) return value;
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      const proxy = watch(copy, label, inTree);
      memo.set(value, proxy);
      value.forEach((item, index) =>
        copy.push(deep(item, `${label}[${index}]`, inTree)),
      );
      return proxy;
    }
    const copy: Record<string, unknown> = {};
    const proxy = watch(copy, label, inTree);
    memo.set(value, proxy);
    for (const key of Object.keys(value))
      copy[key] = deep(Reflect.get(value, key), `${label}.${key}`, inTree);
    return proxy;
  }

  function findings(): Class1Finding[] {
    const out: Class1Finding[] = [];
    for (const [proxy, table] of reads) {
      const label = labels.get(proxy) ?? "?";
      for (const [key, list] of table) {
        if (list.length > 1)
          out.push({
            kind: key === "then" ? "THENABLE" : "DOUBLE",
            what: `${label} :: ${key}`,
            count: list.length,
            sites: list.map((read) => site(read.stack)),
          });
        const late = list.filter((read) => read.late);
        if (tree.has(proxy) && late.length > 0 && key !== "then")
          out.push({
            kind: "LATE",
            what: `${label} :: ${key}`,
            count: late.length,
            sites: late.map((read) => site(read.stack)),
          });
      }
    }
    return out;
  }

  return { watch, deep, findings, status };
}

type Class1Scenario = {
  readonly name: string;
  readonly targets: 0 | 2;
  readonly flagged: boolean;
  readonly approval: "none" | "resolve" | "reject" | "then";
};

async function runClass1(scenario: Class1Scenario) {
  const folder = testFolder("c94-c1-");
  const root = join(folder, "state");
  await seed(root, "gamma", false);
  if (scenario.targets === 2) {
    await seed(root, "alpha", true);
    await seed(root, "beta", true);
  }
  const watch = createWatcher();
  const { ran } = await runHost({
    root,
    phase: () => {
      watch.status.admitted = true;
      return Promise.resolve();
    },
    handler: ({ state, capability, boundary }) => {
      const itemA = watch.watch(
        { resource: "doc", key: "alpha" },
        "declaration.scope.resources[0]",
        true,
      );
      const itemB = watch.watch(
        { resource: "doc", key: "beta" },
        "declaration.scope.resources[1]",
        true,
      );
      const resources = watch.watch(
        [itemA, itemB, itemA],
        "declaration.scope.resources",
        true,
      );
      const invariants = watch.watch(
        ["shape"],
        "declaration.scope.invariants",
        true,
      );
      const scope = watch.watch(
        { resources, invariants },
        "declaration.scope",
        true,
      );
      const revisions = watch.watch(
        { doc: "v1" },
        "declaration.revisions",
        true,
      );
      const result: { readonly consumed: boolean; readonly then?: null } =
        scenario.approval === "then"
          ? { consumed: true, then: null }
          : { consumed: true };
      const error = new Error("lost");
      Object.defineProperty(error, "consumed", {
        value: true,
        enumerable: true,
      });
      const resultProxy = watch.watch(result, "runtime-result", false);
      const errorProxy = watch.watch(error, "runtime-rejection", false);
      const runtime = watch.watch(
        {
          check: () => Promise.resolve(true),
          revalidateAndConsume: () => {
            if (scenario.approval === "reject")
              return Promise.reject(errorProxy);
            return Promise.resolve(resultProxy);
          },
        },
        "declaration.approval.runtime",
        true,
      );
      const effects = watch.watch(
        [...defaultEffects],
        "declaration.approval.request.effects",
        true,
      );
      const request = watch.watch(
        {
          authority: boundary.authority("operator"),
          resource: boundary.resource("doc"),
          resourceRevision: "v1",
          effects,
          preview: "preview-c1",
        },
        "declaration.approval.request",
        true,
      );
      const approvalPart =
        scenario.approval === "none"
          ? undefined
          : watch.watch({ runtime, request }, "declaration.approval", true);
      const facts = watch.deep(
        {
          note: "x",
          nested: { deep: [1, 2] },
          alias: [
            scope,
            resources,
            itemA,
            itemB,
            invariants,
            revisions,
            ...(approvalPart ? [approvalPart, request, effects, runtime] : []),
            resultProxy,
            errorProxy,
          ],
        },
        "declaration.facts",
        true,
      );
      const declaration: Declaration = watch.watch(
        {
          command: "su.open",
          scope,
          revisions,
          facts,
          ...(scenario.flagged ? { supersedeUnresolved: true } : {}),
          ...(approvalPart ? { approval: approvalPart } : {}),
        },
        "declaration",
        true,
      );
      return state.transaction(capability, declaration, completeWork);
    },
  });
  fs.rmSync(folder, { recursive: true, force: true });
  return {
    name: scenario.name,
    answer: ran.kind === "envelope" ? ran.envelope.result.causeCode : ran.kind,
    findings: watch.findings(),
  };
}

async function runClass1Close() {
  const folder = testFolder("c94-c1-close-");
  const root = join(folder, "state");
  await seed(root, "alpha", true);
  const paths = layout(root);
  const [operationId = ""] = fs.readdirSync(paths.operations);
  const target = readCase(paths, operationId);
  if (typeof target === "string")
    throw new Error(`close seed unreadable: ${target}`);
  const watch = createWatcher();
  const { ran } = await runHost({
    root,
    phase: () => {
      watch.status.admitted = true;
      return Promise.resolve();
    },
    handler: async ({ state, capability }) => {
      const request = watch.watch(
        {
          command: "su.open",
          effect: "doc.write" as const,
          operationId,
          closureId: "c1-close",
          disposition: "completed" as const,
          revision: target.revision,
          reason: "class one close route",
        },
        "close.request",
        true,
      );
      await state.close(capability, request);
      return undefined;
    },
  });
  fs.rmSync(folder, { recursive: true, force: true });
  return {
    name: "close/unresolved-case",
    answer: ran.kind === "envelope" ? ran.envelope.result.causeCode : ran.kind,
    findings: watch.findings(),
  };
}

type WorkStopPoint =
  | "entry"
  | "operation"
  | "readback"
  | "between"
  | "delegate";
type Stop =
  | { readonly kind: "phase"; readonly phase: Phase; readonly nth: number }
  | { readonly kind: "approval" }
  | { readonly kind: "approval-store-open" }
  | { readonly kind: "work"; readonly at: WorkStopPoint };

type Class2Scenario = {
  readonly targets: 0 | 2 | "fresh";
  readonly approval: "custom" | "real" | "none";
  readonly mode: "deadline" | "early-return" | "early-throw";
  readonly stop: Stop;
  readonly unflagged?: true;
};

function stopName(stop: Stop): string {
  if (stop.kind === "phase") return `${stop.phase}#${stop.nth}`;
  if (stop.kind === "approval-store-open")
    return "approval-store-open(stalled)";
  return stop.kind === "approval" ? "approval" : `work:${stop.at}`;
}

function scenarioName(scenario: Class2Scenario): string {
  const prefix = scenario.unflagged ? "UNFLAGGED-" : "";
  const target =
    scenario.targets === "fresh" ? "fresh" : `T${scenario.targets}`;
  return `${prefix}${target}/${scenario.approval}/${scenario.mode}/${stopName(scenario.stop)}`;
}

function snapshotTree(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = fs.lstatSync(path);
      const key = relative(folder, path);
      if (stats.isDirectory()) {
        out.set(key, "dir");
        walk(path);
      } else {
        const hash = createHash("sha256")
          .update(fs.readFileSync(path))
          .digest("hex")
          .slice(0, 12);
        out.set(key, `file:${stats.size}:${hash}`);
      }
    }
  };
  walk(folder);
  return out;
}

function caseEvents(
  root: string,
): Map<string, { readonly runId: string; readonly kinds: readonly string[] }> {
  const paths = layout(root);
  const out = new Map<
    string,
    { readonly runId: string; readonly kinds: readonly string[] }
  >();
  for (const directory of [paths.operations, paths.settled]) {
    if (!fs.existsSync(directory)) continue;
    for (const id of fs.readdirSync(directory)) {
      const read = readCase(paths, id);
      if (typeof read === "string") continue;
      out.set(id, {
        runId: read.intent.runId,
        kinds: read.events.map(
          (event) => `${event.kind}${event.effect ? `:${event.effect}` : ""}`,
        ),
      });
    }
  }
  return out;
}

const deadlineMilliseconds = 250;
const settleKinds: readonly string[] = [
  "effect-confirmed",
  "effect-unconfirmed",
  "completion",
  "not-applied",
  "outcome",
  "emergency",
];

function nextImmediate(): Promise<void> {
  return new Promise((done) => {
    setImmediate(done);
  });
}

function normalizeTracePath(rel: string): string {
  return rel
    .replace(/op-[0-9a-f]{32}/g, "op-*")
    .replace(/[0-9a-f]{64}/g, "*")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "*")
    .replace(/k-[0-9a-f]{32}/g, "k-*");
}

type ClassifiedChange = {
  readonly label: string;
  readonly op: string;
  readonly path: string;
  readonly to?: string;
  readonly appended?: string;
  readonly site: string;
};

async function runClass2(scenario: Class2Scenario) {
  const name = scenarioName(scenario);
  const folder = testFolder("c94-c2-");
  const root = join(folder, "state");
  const store = {
    grants: join(folder, "approval", "grants"),
    consumed: join(folder, "approval", "consumed"),
  };
  if (scenario.targets !== "fresh") await seed(root, "gamma", false);
  if (scenario.targets === 2) {
    await seed(root, "alpha", true);
    await seed(root, "beta", true);
  }
  if (scenario.approval === "real") {
    fs.mkdirSync(store.grants, { recursive: true, mode: 0o700 });
    fs.mkdirSync(store.consumed, { recursive: true, mode: 0o700 });
    fs.chmodSync(join(folder, "approval"), 0o700);
    fs.writeFileSync(
      grantLocation(store, "preview-c2"),
      JSON.stringify({
        format: "contract3.approval-grant",
        version: 1,
        operation: "su.open",
        preview: "preview-c2",
        authority: "operator",
        resource: "doc",
        resourceRevision: "v1",
        effects: [...defaultEffects],
        expiresAt: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );
  }
  const gate = deferred();
  const reached = deferred();
  const settled = deferred();
  const flags: {
    reachedAt: number | undefined;
    callbackAfterAnswer: boolean;
    workAfterAnswer: boolean;
    answered: boolean;
  } = {
    reachedAt: undefined,
    callbackAfterAnswer: false,
    workAfterAnswer: false,
    answered: false,
  };
  const startedAt = performance.now();
  const hit = async (): Promise<void> => {
    flags.reachedAt ??= performance.now() - startedAt;
    reached.resolve();
    await gate.promise;
  };
  let seen = 0;
  const stop = scenario.stop;
  if (stop.kind === "approval-store-open")
    trace.stalls.set(store.consumed, hit);
  const work = async (
    transaction: EffectTransaction<Effects>,
  ): Promise<void> => {
    if (flags.answered) flags.workAfterAnswer = true;
    const at = stop.kind === "work" ? stop.at : undefined;
    if (at === "entry") await hit();
    await transaction.record(
      "doc.write",
      async (capability) => {
        if (at === "operation") await hit();
        if (at === "delegate") {
          await hit();
          await capability.admitStart(
            capability.runId,
            capability.effect,
            () => {
              if (flags.answered) flags.callbackAfterAnswer = true;
              return Promise.resolve();
            },
          );
        }
      },
      async () => {
        if (at === "readback") await hit();
        return true;
      },
    );
    if (at === "between") await hit();
    await transaction.record(
      "editor.launch",
      () => Promise.resolve(),
      () => Promise.resolve(true),
    );
  };
  const { ran } = await runHost({
    root,
    argv:
      scenario.mode === "deadline"
        ? ["open", "--deadline-ms", String(deadlineMilliseconds)]
        : ["open"],
    phase: async (phase) => {
      if (stop.kind === "phase" && phase === stop.phase) {
        seen += 1;
        if (seen === stop.nth) await hit();
      }
    },
    handler: async ({ state, capability, boundary }) => {
      const approvalSpec =
        scenario.approval === "none"
          ? undefined
          : {
              runtime: {
                check: () => Promise.resolve(true),
                revalidateAndConsume: async (
                  request: Parameters<
                    ReturnType<
                      ReturnType<typeof approval>["runtime"]
                    >["revalidateAndConsume"]
                  >[0],
                  coordination: Parameters<
                    ReturnType<
                      ReturnType<typeof approval>["runtime"]
                    >["revalidateAndConsume"]
                  >[1],
                ) => {
                  if (stop.kind === "approval") await hit();
                  if (scenario.approval === "custom") return { consumed: true };
                  return approval({
                    operation: "su.open",
                    runId: coordination.runId,
                    store,
                  })
                    .runtime(state.descriptor)
                    .revalidateAndConsume(request, coordination);
                },
              },
              request: {
                authority: boundary.authority("operator"),
                resource: boundary.resource("doc"),
                resourceRevision: "v1",
                effects: [...defaultEffects],
                preview: "preview-c2",
              },
            };
      const declaration: Declaration = {
        command: "su.open",
        scope: {
          resources: [
            { resource: "doc", key: "alpha" },
            { resource: "doc", key: "beta" },
          ],
        },
        ...(scenario.unflagged ? {} : { supersedeUnresolved: true }),
        ...(approvalSpec ? { approval: approvalSpec } : {}),
      };
      const running = state
        .transaction(capability, declaration, work)
        .finally(() => settled.resolve());
      if (scenario.mode === "deadline") return running;
      const finished = running.then(
        (outcome) => ({ outcome }),
        () => ({ outcome: undefined }),
      );
      const first = await Promise.race([
        reached.promise.then(() => undefined),
        finished,
      ]);
      if (first !== undefined) return first.outcome;
      if (scenario.mode === "early-throw")
        throw new Error("handler threw with its transaction still open");
      return undefined;
    },
  });
  flags.answered = true;
  const answerSeq = trace.seq();
  const before = snapshotTree(folder);
  const eventsBefore = caseEvents(root);
  const runId = ran.runId;
  const problems: string[] = [];
  const notes: string[] = [];
  if (flags.reachedAt === undefined) {
    if (stop.kind === "approval-store-open")
      notes.push(
        "no asynchronous store open to stall; the run finished normally",
      );
    else problems.push("stop never reached");
  } else if (
    scenario.mode === "deadline" &&
    flags.reachedAt >= deadlineMilliseconds
  )
    problems.push(`stop reached after the deadline (${flags.reachedAt} ms)`);
  gate.resolve();
  await settled.promise;
  for (let quiet = 0, last = trace.seq(); quiet < 5; ) {
    await nextImmediate();
    if (trace.seq() === last) quiet += 1;
    else {
      quiet = 0;
      last = trace.seq();
    }
  }
  const after = snapshotTree(folder);
  const eventsAfter = caseEvents(root);
  const changes = trace.events.filter(
    (event) =>
      event.seq > answerSeq &&
      (event.path.startsWith(folder) || (event.to ?? "").startsWith(folder)),
  );
  const diff: string[] = [];
  for (const [path, value] of after)
    if (before.get(path) !== value) diff.push(path);
  for (const path of before.keys()) if (!after.has(path)) diff.push(path);
  for (const path of diff) {
    const full = join(folder, path);
    const explained = changes.some(
      (event) =>
        event.path === full ||
        event.to === full ||
        full.startsWith(`${event.path}/`) ||
        full.startsWith(`${event.to ?? "\0"}/`),
    );
    if (!explained) problems.push(`tree change with no traced event: ${path}`);
  }
  const writeIndex = new Map<string, number>();
  const classified: ClassifiedChange[] = changes.map((event) => {
    const rel = relative(folder, event.path);
    const to = event.to ? relative(folder, event.to) : undefined;
    let label = "NEW";
    let detail = "";
    const match =
      /^state\/(?:operations|settled)\/(op-[0-9a-f]+)\/events$/.exec(rel);
    if (/^state\/coordination\/[^/]+\.lock$/.test(rel) && event.op === "create")
      label = "LOCK";
    else if (
      event.op === "remove" &&
      /^state\/staging\//.test(rel) &&
      before.has(rel)
    )
      label = "CLEANUP";
    else if (match && event.op === "write") {
      const id = match[1] ?? "";
      const was = eventsBefore.get(id);
      const now = eventsAfter.get(id);
      const added = now ? now.kinds.slice(was ? was.kinds.length : 0) : [];
      const index = writeIndex.get(id) ?? 0;
      writeIndex.set(id, index + 1);
      const entry = added[index] ?? "?";
      detail = entry;
      const [kind = "", effect = ""] = entry.split(":");
      const settles =
        was !== undefined &&
        was.runId === runId &&
        settleKinds.includes(kind) &&
        (kind === "effect-confirmed" || kind === "effect-unconfirmed"
          ? was.kinds.includes(`effect-started:${effect}`)
          : true);
      label = settles ? "SETTLE" : "NEW";
    } else if (
      (event.op === "rename" && /^state\/settled\//.test(to ?? "")) ||
      (event.op === "rename" && to === "state/format") ||
      /^state\/staging\/format-/.test(rel) ||
      rel === "state/settled"
    )
      label = "MAINT";
    return {
      label,
      op: event.op,
      path: normalizeTracePath(rel),
      ...(to ? { to: to.replace(/op-[0-9a-f]{32}/g, "op-*") } : {}),
      ...(detail ? { appended: detail } : {}),
      site: site(event.stack),
    };
  });
  if (flags.callbackAfterAnswer)
    classified.push({
      label: "NEW",
      op: "callback",
      path: "(caller start callback ran after the answer)",
      site: "addons/state/install.ts admitStart",
    });
  if (flags.workAfterAnswer)
    classified.push({
      label: "NEW",
      op: "callback",
      path: "(caller work function entered after the answer)",
      site: "addons/state/install.ts runRecorded",
    });
  const retry = await runHost({
    root,
    handler: ({ state, capability }) =>
      state.transaction(
        capability,
        {
          command: "su.open",
          supersedeUnresolved: true,
          scope: {
            resources: [
              { resource: "doc", key: "alpha" },
              { resource: "doc", key: "beta" },
            ],
          },
        },
        completeWork,
      ),
  });
  const report = retry.state.report();
  const recovered =
    retry.ran.kind === "envelope" &&
    retry.ran.envelope.result.causeCode === "SUCCESS_COMPLETED" &&
    report.ok &&
    report.unfinished.length === 0;
  trace.stalls.delete(store.consumed);
  fs.rmSync(folder, { recursive: true, force: true });
  return {
    name,
    answer: ran.kind === "envelope" ? ran.envelope.result.causeCode : ran.kind,
    problems,
    notes,
    recovered,
    changes: classified,
  };
}

function class2Scenarios(): Class2Scenario[] {
  const phaseStop = (name: Phase, nth: number): Stop => ({
    kind: "phase",
    phase: name,
    nth,
  });
  const workStop = (at: WorkStopPoint): Stop => ({ kind: "work", at });
  const out: Class2Scenario[] = [];
  const t2: Stop[] = [
    phaseStop("admission-wait", 1),
    phaseStop("closure-read", 1),
    phaseStop("closure-read", 2),
    { kind: "approval" },
    phaseStop("staged", 1),
    phaseStop("closure-staged", 1),
    phaseStop("closure-published", 1),
    phaseStop("closure-staged", 2),
    phaseStop("closure-published", 2),
    workStop("entry"),
    workStop("operation"),
    workStop("readback"),
    workStop("between"),
    workStop("delegate"),
  ];
  const t0: Stop[] = [
    phaseStop("admission-wait", 1),
    { kind: "approval" },
    phaseStop("staged", 1),
    workStop("entry"),
    workStop("operation"),
    workStop("delegate"),
  ];
  for (const mode of ["deadline", "early-return"] as const) {
    for (const stop of t2)
      out.push({ targets: 2, approval: "custom", mode, stop });
    for (const stop of t0)
      out.push({ targets: 0, approval: "custom", mode, stop });
    out.push({
      targets: 2,
      approval: "real",
      mode,
      stop: phaseStop("admission-wait", 1),
    });
    out.push({
      targets: 2,
      approval: "real",
      mode,
      stop: phaseStop("closure-read", 1),
    });
    out.push({
      targets: 0,
      approval: "real",
      mode,
      stop: phaseStop("admission-wait", 1),
    });
    for (const stop of [
      phaseStop("admission-wait", 1),
      phaseStop("upgrade-staged", 1),
      phaseStop("upgraded", 1),
      phaseStop("staged", 1),
    ])
      out.push({ targets: "fresh", approval: "custom", mode, stop });
  }
  for (const mode of ["deadline", "early-return"] as const) {
    for (const stop of t2.filter((entry) => entry.kind !== "approval"))
      out.push({ targets: 2, approval: "none", mode, stop });
    for (const stop of t0.filter((entry) => entry.kind !== "approval"))
      out.push({ targets: 0, approval: "none", mode, stop });
  }
  for (const stop of [
    phaseStop("staged", 1),
    phaseStop("closure-staged", 1),
    workStop("entry"),
  ])
    out.push({ targets: 2, approval: "custom", mode: "early-throw", stop });
  for (const mode of ["deadline", "early-return"] as const)
    out.push({
      targets: 2,
      approval: "real",
      mode,
      stop: { kind: "approval-store-open" },
    });
  for (const mode of ["deadline", "early-return"] as const)
    for (const stop of [phaseStop("admission-wait", 1), phaseStop("staged", 1)])
      out.push({ targets: 0, approval: "custom", mode, stop, unflagged: true });
  return out;
}

async function discoverPhases(targets: 0 | 2 | "fresh"): Promise<string[]> {
  const folder = testFolder("c94-disc-");
  const root = join(folder, "state");
  if (targets !== "fresh") await seed(root, "gamma", false);
  if (targets === 2) {
    await seed(root, "alpha", true);
    await seed(root, "beta", true);
  }
  const counts = new Map<string, number>();
  const seen: string[] = [];
  await runHost({
    root,
    phase: (name) => {
      const nth = (counts.get(name) ?? 0) + 1;
      counts.set(name, nth);
      seen.push(
        `${targets === "fresh" ? "fresh" : `T${targets}`}/${name}#${nth}`,
      );
      return Promise.resolve();
    },
    handler: ({ state, capability }) =>
      state.transaction(
        capability,
        {
          command: "su.open",
          supersedeUnresolved: true,
          scope: {
            resources: [
              { resource: "doc", key: "alpha" },
              { resource: "doc", key: "beta" },
            ],
          },
        },
        completeWork,
      ),
  });
  fs.rmSync(folder, { recursive: true, force: true });
  return seen;
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  body: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) out[index] = await body(item);
      }
    }),
  );
  return out;
}

export type DetectorSummary = {
  readonly class1RedFindings: number;
  readonly class2RedScenarios: number;
  readonly class2Scenarios: number;
  readonly class2RedDistinctChanges: number;
  readonly class2SoftChanges: number;
  readonly detectorErrors: number;
};

export type DetectorOutput = {
  readonly summary: DetectorSummary;
  readonly report: string;
};

async function main(): Promise<void> {
  const only = process.env.DETECTOR_ONLY;
  const class1Scenarios: Class1Scenario[] = [
    {
      name: "flagged/T2/no-approval",
      targets: 2,
      flagged: true,
      approval: "none",
    },
    {
      name: "flagged/T2/approval-resolves",
      targets: 2,
      flagged: true,
      approval: "resolve",
    },
    {
      name: "flagged/T2/approval-rejects",
      targets: 2,
      flagged: true,
      approval: "reject",
    },
    {
      name: "flagged/T0/approval-resolves",
      targets: 0,
      flagged: true,
      approval: "resolve",
    },
    {
      name: "flagged/T2/approval-own-then-key",
      targets: 2,
      flagged: true,
      approval: "then",
    },
  ];
  const class1: Awaited<ReturnType<typeof runClass1>>[] = [];
  for (const scenario of class1Scenarios)
    class1.push(await runClass1(scenario));
  class1.push(await runClass1Close());
  const unflagged = await runClass1({
    name: "unflagged/T0/approval-resolves (information only)",
    targets: 0,
    flagged: false,
    approval: "resolve",
  });
  const allScenarios = class2Scenarios();
  const scenarios = allScenarios.filter(
    (scenario) => !only || scenarioName(scenario).includes(only),
  );
  const covered = new Set(
    allScenarios
      .filter(
        (scenario) => !scenario.unflagged && scenario.stop.kind === "phase",
      )
      .map(
        (scenario) =>
          `${scenario.targets === "fresh" ? "fresh" : `T${scenario.targets}`}/${stopName(scenario.stop)}`,
      ),
  );
  const uncovered: string[] = [];
  for (const targets of [0, 2, "fresh"] as const)
    for (const point of await discoverPhases(targets))
      if (!covered.has(point)) uncovered.push(point);
  const all2 = await pool(scenarios, 10, runClass2);
  const class2 = all2.filter((result) => !result.name.startsWith("UNFLAGGED"));
  const info2 = all2.filter((result) => result.name.startsWith("UNFLAGGED"));

  const lines: string[] = [];
  const class1Red = new Map<string, Set<string>>();
  const class1Then = new Set<string>();
  for (const result of class1)
    for (const finding of result.findings) {
      const readSites = [
        ...new Set(finding.sites.map((entry) => entry.split(" <- ")[0] ?? "")),
      ].join(" , ");
      const key = `${finding.kind} ${finding.what.replace(/^declaration\.facts\.alias\[\d+\]/, "alias")}  reads at: ${readSites}`;
      if (finding.kind === "THENABLE") class1Then.add(key);
      else {
        let where = class1Red.get(key);
        if (!where) {
          where = new Set<string>();
          class1Red.set(key, where);
        }
        where.add(result.name);
      }
    }
  lines.push(
    "== CLASS 1: caller object read twice, or read after admission started ==",
  );
  for (const result of class1)
    lines.push(
      `  scenario ${result.name}: answer ${result.answer}, ${result.findings.filter((finding) => finding.kind !== "THENABLE").length} red`,
    );
  for (const [key, where] of [...class1Red].sort())
    lines.push(`  RED ${key}   [${[...where].join("; ")}]`);
  for (const key of [...class1Then].sort())
    lines.push(`  info (engine thenable check, not counted) ${key}`);
  lines.push(
    `  info: unflagged path, pinned to main: ${unflagged.findings.filter((finding) => finding.kind === "DOUBLE").length} double reads, ${unflagged.findings.filter((finding) => finding.kind === "LATE").length} late reads (not counted)`,
  );

  lines.push("== CLASS 2: durable change after the run's answer ==");
  const sites = new Map<string, { label: string; scenarios: Set<string> }>();
  const errors: string[] = uncovered.map(
    (point) => `pause point with no scenario: ${point}`,
  );
  let strictOnly = 0;
  for (const result of class2) {
    const red = result.changes.filter(
      (change) => change.label === "NEW" || change.label === "MAINT",
    );
    const soft = result.changes.length - red.length;
    strictOnly += soft;
    lines.push(
      `  ${red.length > 0 ? "RED  " : "green"} ${result.name}: answer ${result.answer}; after answer: ${red.length} red, ${soft} lock-or-settle; next run ${result.recovered ? "heals" : "DOES NOT HEAL"}`,
    );
    for (const problem of result.problems)
      errors.push(`${result.name}: ${problem}`);
    for (const note of result.notes) lines.push(`        note: ${note}`);
    if (!result.recovered)
      errors.push(`${result.name}: next flagged run did not complete cleanly`);
    for (const change of result.changes) {
      const toPart = change.to ? ` -> ${change.to}` : "";
      const appendedPart = change.appended ? ` [${change.appended}]` : "";
      const key = `${change.label} ${change.op} ${change.path}${toPart}${appendedPart}  at ${change.site}`;
      let entry = sites.get(key);
      if (!entry) {
        entry = { label: change.label, scenarios: new Set<string>() };
        sites.set(key, entry);
      }
      entry.scenarios.add(result.name);
    }
  }
  lines.push(
    "  -- distinct after-answer changes (label, operation, path, kernel site) --",
  );
  for (const [key, value] of [...sites].sort()) {
    const firstScenario = [...value.scenarios][0] ?? "";
    const tag =
      value.label === "NEW" || value.label === "MAINT" ? "RED " : "soft";
    lines.push(
      `  ${tag} ${key}   [${value.scenarios.size} scenario(s), e.g. ${firstScenario}]`,
    );
  }
  for (const error of errors) lines.push(`  DETECTOR ERROR ${error}`);
  lines.push(
    "  -- information only: the unflagged path (pinned to main's behaviour), not counted --",
  );
  for (const result of info2)
    lines.push(
      `  info ${result.name}: answer ${result.answer}; after answer: ${
        result.changes
          .filter(
            (change) => change.label === "NEW" || change.label === "MAINT",
          )
          .map((change) => `${change.op} ${change.path}`)
          .join(", ") || "nothing"
      }`,
    );

  const redSites2 = [...sites].filter(
    ([, value]) => value.label === "NEW" || value.label === "MAINT",
  );
  const summary: DetectorSummary = {
    class1RedFindings: class1Red.size,
    class2RedScenarios: class2.filter((result) =>
      result.changes.some(
        (change) => change.label === "NEW" || change.label === "MAINT",
      ),
    ).length,
    class2Scenarios: class2.length,
    class2RedDistinctChanges: redSites2.length,
    class2SoftChanges: strictOnly,
    detectorErrors: errors.length,
  };
  lines.push(`== SUMMARY ${JSON.stringify(summary)} ==`);
  const report = lines.join("\n");
  if (process.env.DETECTOR_OUT)
    fs.writeFileSync(process.env.DETECTOR_OUT, `${report}\n`);
  const output: DetectorOutput = { summary, report };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
