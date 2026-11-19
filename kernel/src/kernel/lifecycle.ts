import type { RunProcess } from "./capabilities.ts";
import { unavailableStatus } from "./fallback.ts";
import type { TrustedRun } from "./fallback.ts";
import { processHost } from "./process-host.ts";
import type {
  AttachedAddon,
  EmergencyFacts,
  InProcessResult,
  InProcessSetup,
  ProcessHost,
  RunAddon,
  RunControl,
  RunInProcess,
  RunSetup,
  StopSignal,
} from "./process-types.ts";
import { runtimeOf } from "./runtime.ts";
import type { ContractKey } from "./runtime.ts";
import type { Attach, ContractRuntime, Enter, Resolution } from "./runtime.ts";
import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { programStopOf } from "./program-stop.ts";
import type { StateObservation } from "./state-seam.ts";
import {
  deadlineCause,
  incompleteEffects,
  unchangedEffects,
} from "./state-causes.ts";
import type { Effects, JsonValue, Validation } from "./types.ts";
import { addonNames, capabilityMethods } from "./validation/context.ts";
import type { CapabilityAddonName } from "./validation/context.ts";
import { record } from "./validation/primitives.ts";
import { createWriter } from "./writer.ts";
import type { StatusReport } from "./writer.ts";

const settleLimitMilliseconds = 300;
const stopBoundMilliseconds = 450;
const cancellationMilliseconds = 500;
const flushMilliseconds = 500;
// Accepted decision (Nathan, 16 November 2026, 14:19; DIAG-1): a status is
// due only after handler entry, so a usage or approval refusal and a deadline
// before
// start carry no `diagnostics` key. Set to true to give every refusal of a
// command that declares a status-reporting add-on a status too (see
// `reporterFor`).
const statusOnPreHandlerRefusal = false;

const messages = {
  USAGE_UNKNOWN_COMMAND: "No declared command matches this invocation.",
  USAGE_INVALID_INVOCATION:
    "The invocation is not valid for the selected command.",
  INTERNAL_PREPARATION: "The CLI could not prepare this command.",
  DOMAIN_AUTHORITY_REQUIRED: "The required authority was not confirmed.",
  DOMAIN_DEADLINE_BEFORE_START:
    "The deadline passed before the operation started. Its handler never ran.",
  deadline: "The deadline passed after the operation started.",
  programStop:
    "The deadline passed. Nothing changed, but a program this command started was not confirmed stopped.",
  help: "Help for this CLI.",
  discovery: "Discovery data for this CLI.",
  commandDiscovery: "Discovery data for one command.",
} as const;

type Execution =
  | {
      readonly kind: "returned";
      readonly outcome: Validation<CommandResult>;
    }
  | { readonly kind: "threw" };

// Platform: A runtime timer holds at most 2,147,483,647 ms and fires a longer delay
// after 1 ms.
const timerLimit = 2_147_483_647;
function afterDelay(
  milliseconds: number,
  fire: () => void,
  now: () => number,
): () => void {
  const due = now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (delay: number) => {
    const stepped = delay > timerLimit;
    timer = setTimeout(
      () => {
        const left = due - now();
        if (stepped && left > 0) arm(left);
        else fire();
      },
      Math.min(delay, timerLimit),
    );
  };
  arm(Math.max(0, milliseconds));
  return () => clearTimeout(timer);
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  now: () => number,
): Promise<T | undefined> {
  let cancel: () => void = () => undefined;
  const expiry = new Promise<undefined>((resolve) => {
    cancel = afterDelay(milliseconds, () => resolve(undefined), now);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    cancel();
  }
}

type Plan = {
  readonly name: CapabilityAddonName;
  readonly addon: RunAddon<unknown>;
};
type CommandPlan = {
  readonly command: CommandDeclaration;
  readonly addons: readonly Plan[];
};

function plansFor(
  runtime: ContractRuntime,
  setup: RunSetup,
): ReadonlyMap<string, CommandPlan> {
  const plans = new Map<string, CommandPlan>();
  for (const command of runtime.commands) {
    const addons: Plan[] = [];
    for (const name of addonNames) {
      if (command.capabilities[name] !== true) continue;
      const addon: RunAddon<unknown> | undefined = setup.addons?.[name];
      if (!addon)
        throw new Error(
          `${command.commandIdentity} declares ${name}; supply its add-on.`,
        );
      addons.push({ name, addon });
    }
    if (addons.length !== Object.keys(command.capabilities).length)
      throw new Error(`${command.commandIdentity} declares an unknown add-on.`);
    if (addons.filter((plan) => plan.addon.reportsStatus === true).length > 1)
      throw new Error(
        `${command.commandIdentity} has more than one status-reporting add-on.`,
      );
    plans.set(command.commandIdentity, { command, addons });
  }
  return plans;
}

export function runProcess(
  contract: ContractKey,
  setup: RunSetup = {},
): RunProcess {
  return runProcessOn(contract, setup, processHost);
}

type Prepared = {
  readonly runtime: ContractRuntime;
  readonly setup: RunSetup;
  readonly plans: ReadonlyMap<string, CommandPlan>;
};

function prepare(
  contract: ContractKey,
  setup: RunSetup,
  entry: "runProcess" | "runInProcess",
): Prepared {
  const runtime = runtimeOf(contract);
  if (!runtime)
    throw new Error(`${entry} needs a contract built by contractFor.`);
  return { runtime, setup, plans: plansFor(runtime, setup) };
}

export function runProcessOn(
  contract: ContractKey,
  setup: RunSetup,
  host: () => ProcessHost,
): RunProcess {
  const prepared = prepare(contract, setup, "runProcess");
  return (argv) => runInvocation(newRun(prepared, host()), argv);
}

let sharedHost: ProcessHost | undefined;
function processWideHost(): ProcessHost {
  sharedHost ??= processHost();
  return sharedHost;
}

export function runInProcess(
  contract: ContractKey,
  setup: InProcessSetup = {},
): RunInProcess {
  return runInProcessOn(contract, setup, processWideHost);
}

export function runInProcessOn(
  contract: ContractKey,
  setup: InProcessSetup,
  host: () => ProcessHost,
): RunInProcess {
  const prepared = prepare(contract, setup, "runInProcess");
  const listener = setup.onCrash;
  return (argv) => runAndReturn(newRun(prepared, host()), argv, listener);
}

type Run = {
  readonly runtime: ContractRuntime;
  readonly setup: RunSetup;
  readonly plans: ReadonlyMap<string, CommandPlan>;
  readonly host: ProcessHost;
  readonly runId: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly attached: AttachedAddon<unknown>[];
  reporter: AttachedAddon<unknown> | undefined;
  phase: EmergencyFacts["phase"];
  commandIdentity: string | null;
  stopped: StopSignal | undefined;
  emergencyAttempted: boolean;
  handler: Handler | undefined;
};
type Handler = { returned: boolean; readonly returning: Promise<void> };
type Delivery =
  | { readonly candidate: Validation<unknown>; readonly trusted: TrustedRun }
  | undefined;
type Resolved = Extract<Resolution, { readonly ok: true }>["value"];

function killAll(run: Run) {
  for (const addon of run.attached)
    try {
      addon.killNow();
    } catch {
      continue;
    }
}

function crashRun(run: Run): void {
  killAll(run);
  attemptEmergencyRecord(run);
}

function attemptEmergencyRecord(run: Run): void {
  if (run.emergencyAttempted) return;
  run.emergencyAttempted = true;
  try {
    run.setup.emergencyRecord?.({
      runId: run.runId,
      commandIdentity: run.commandIdentity,
      phase: run.phase,
    });
  } catch {
    return;
  }
}

function settleOne(addon: AttachedAddon<unknown>, limit?: number) {
  try {
    return addon.settle(limit).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function settleEach(
  addons: readonly AttachedAddon<unknown>[],
  limit?: number,
) {
  const settled = await Promise.all(
    addons.map((addon) => settleOne(addon, limit)),
  );
  return settled.every(Boolean);
}

async function settleAll(run: Run, limit?: number) {
  const settled = await Promise.all(
    run.attached.map(async (addon) => ({
      owned: addon !== run.reporter,
      stopped: await settleOne(addon, limit),
    })),
  );
  return settled.every((item) => !item.owned || item.stopped);
}

// Accepted decision N9: no transaction started before the deadline,
// and the closed capability refuses every later one, so nothing changed and
// every declared effect remains. The kernel's own observation, used on the
// deadline path only; it does not widen the trusted summary elsewhere.
function noneStarted(command: CommandDeclaration): StateObservation {
  return {
    transactionState: "unchanged",
    effects: {
      completed: [],
      remaining: [...(command.effects ?? [])],
      uncertain: [],
      inventoryComplete: true,
    },
  };
}

// Accepted decisions (contract question 5 of 8; N2, N3):
// with an owned program not confirmed stopped the run claims no certainty.
// The proof's completed and remaining effects are kept, nothing moves to
// uncertain, and the inventory is incomplete; without a proof, nothing is
// known.
function unconfirmedSummary(
  summary: StateObservation | undefined,
): StateObservation {
  if (!summary)
    return {
      transactionState: "unknown",
      effects: {
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: false,
      },
    };
  return {
    transactionState: "unknown",
    effects: { ...summary.effects, inventoryComplete: false },
  };
}

function settleOwned(run: Run, deadlineAt: number | undefined) {
  const settling = settleEach(
    run.attached.filter((addon) => addon !== run.reporter),
  );
  return deadlineAt === undefined
    ? settling
    : within(settling, deadlineAt - run.host.now(), run.host.now);
}

async function freezeStatus(
  run: Run,
  reporter: AttachedAddon<unknown>,
): Promise<StatusReport> {
  try {
    const freeze = reporter.freeze;
    if (!freeze) return { value: unavailableStatus("status-unavailable") };
    const frozen = await within(
      Promise.resolve().then(() => freeze(flushMilliseconds)),
      flushMilliseconds,
      run.host.now,
    );
    return frozen === undefined
      ? { value: unavailableStatus("status-unavailable") }
      : { value: frozen };
  } catch {
    return { value: unavailableStatus("status-unavailable") };
  }
}

function stopCode(signal: StopSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function installHooks(run: Run) {
  run.host.onSignal((signal) => {
    const code = stopCode(signal);
    if (run.stopped || run.phase === "drained") {
      killAll(run);
      run.host.exit(code);
      return;
    }
    run.stopped = signal;
    run.controller.abort();
    void within(
      settleAll(run, settleLimitMilliseconds),
      stopBoundMilliseconds,
      run.host.now,
    ).then(() => run.host.exit(code));
  });
  run.host.onCrash(() => {
    crashRun(run);
    run.host.exit(1);
  });
}

function trustedRun(
  run: Run,
  identity: string,
  handlerEntered: boolean,
  summary?: StateObservation,
): TrustedRun {
  const trusted: TrustedRun = {
    runId: run.runId,
    commandIdentity: identity,
    handlerEntered,
  };
  return summary ? { ...trusted, summary } : trusted;
}

async function kernelResult(
  run: Run,
  identity: string,
  causeCode: string,
  message: string,
  options: {
    readonly handlerEntered?: boolean;
    readonly effects?: Effects;
    readonly data?: JsonValue;
    readonly summary?: StateObservation | undefined;
  } = {},
): Promise<Delivery> {
  const candidate = await run.runtime.buildKernelStation(
    { commandIdentity: identity, causeCode },
    { runId: run.runId, message, data: options.data ?? null },
    options.effects ?? unchangedEffects,
  );
  return {
    candidate,
    trusted: trustedRun(
      run,
      identity,
      options.handlerEntered ?? false,
      options.summary,
    ),
  };
}

async function reporterFor(run: Run, trusted: TrustedRun) {
  if (trusted.handlerEntered) return run.reporter;
  if (!statusOnPreHandlerRefusal) return undefined;
  const plan = run.plans.get(trusted.commandIdentity);
  const entry = plan?.addons.find((item) => item.addon.reportsStatus === true);
  if (plan && entry && !run.reporter)
    run.reporter = await attachReporter(run, plan.command, entry);
  return run.reporter;
}

function builtin(run: Run, value: Resolved) {
  const { cli, navigation } = run.runtime;
  switch (value.commandIdentity) {
    case `${cli}.help`:
      return { message: messages.help, data: navigation.help() };
    case `${cli}.discovery`:
      return { message: messages.discovery, data: navigation.discover() };
    case `${cli}.command-discovery`:
      return {
        message: messages.commandDiscovery,
        data:
          navigation.discoverCommand(String(value.input.commandIdentity)) ??
          null,
      };
    default:
      return undefined;
  }
}

function control(run: Run, command: CommandDeclaration): RunControl {
  return {
    runId: run.runId,
    commandIdentity: command.commandIdentity,
    summary: command.summary,
    signal: run.controller.signal,
  };
}

function attachNow(
  run: Run,
  command: CommandDeclaration,
  addon: RunAddon<unknown>,
): AttachedAddon<unknown> | Promise<AttachedAddon<unknown>> {
  const value: AttachedAddon<unknown> | Promise<AttachedAddon<unknown>> =
    addon.attach(control(run, command));
  const keep = (instance: AttachedAddon<unknown>) => {
    run.attached.push(instance);
    return instance;
  };
  return value instanceof Promise ? value.then(keep) : keep(value);
}

function attachEarly(
  run: Run,
  command: CommandDeclaration,
  addon: RunAddon<unknown>,
): Promise<AttachedAddon<unknown>> {
  return Promise.resolve().then(() => attachNow(run, command, addon));
}

async function attachReporter(
  run: Run,
  command: CommandDeclaration,
  plan: Plan,
): Promise<AttachedAddon<unknown>> {
  try {
    return await attachEarly(run, command, plan.addon);
  } catch {
    const inert = Object.fromEntries(
      capabilityMethods[plan.name].map((method) => [method, () => undefined]),
    );
    return {
      capability: Object.freeze(inert),
      settle: () => Promise.resolve(true),
      killNow: () => undefined,
    };
  }
}

function invoke(
  plan: Plan,
  instance: AttachedAddon<unknown>,
  method: string,
  args: readonly unknown[],
): unknown {
  const target = instance.capability;
  const operation: unknown = record(target) ? target[method] : undefined;
  if (typeof operation !== "function")
    throw new Error(`The ${plan.name} add-on lacks ${method}.`);
  const result: unknown = Reflect.apply(operation, target, args);
  return result;
}

function deferred(run: Run, command: CommandDeclaration, plan: Plan) {
  let instance:
    | AttachedAddon<unknown>
    | Promise<AttachedAddon<unknown>>
    | undefined;
  const methods = capabilityMethods[plan.name].map((method) => {
    const call = (...args: unknown[]): unknown => {
      instance ??= attachNow(run, command, plan.addon);
      return instance instanceof Promise
        ? instance.then((attached) => invoke(plan, attached, method, args))
        : invoke(plan, instance, method, args);
    };
    return [method, call] as const;
  });
  return Object.freeze(Object.fromEntries(methods));
}

// CMD-9 steps 5 and 6: the approval add-on attaches before the handler,
// because its check is the step 5 preflight, and so does a status-reporting
// add-on, whose attach is effect-free, so its status exists even when the
// handler never uses it. Every other declared capability attaches when the
// handler first uses it. Undefined when an approval attach throws or
// rejects: a preparation fault before handler entry (accepted decision,
// contract question 3 of 8).
async function capabilities(
  run: Run,
  plan: CommandPlan,
): Promise<Record<string, unknown> | undefined> {
  const context: Record<string, unknown> = { signal: run.controller.signal };
  for (const entry of plan.addons) {
    if (entry.name !== "approval" && entry.addon.reportsStatus !== true) {
      context[entry.name] = deferred(run, plan.command, entry);
      continue;
    }
    if (entry.addon.reportsStatus === true) {
      run.reporter = await attachReporter(run, plan.command, entry);
      context[entry.name] = run.reporter.capability;
      continue;
    }
    try {
      context[entry.name] = (
        await attachEarly(run, plan.command, entry.addon)
      ).capability;
    } catch {
      return undefined;
    }
  }
  return context;
}

async function afterDeadline(
  run: Run,
  command: CommandDeclaration,
  execution: Promise<Execution>,
): Promise<Delivery> {
  run.controller.abort();
  const started = run.runtime.closeStateAtDeadline(run.runId);
  const [, stopped] = await Promise.all([
    within(execution, cancellationMilliseconds, run.host.now),
    within(
      settleAll(run, settleLimitMilliseconds),
      cancellationMilliseconds,
      run.host.now,
    ),
  ]);
  const issued =
    run.runtime.trustedSummary(run.runId) ??
    (started === false ? noneStarted(command) : undefined);
  const summary = stopped === true ? issued : unconfirmedSummary(issued);
  // Accepted decisions (contract question 5 of 8; form H): an inspect
  // command with an owned program not confirmed stopped gets its declared
  // program-stop station.
  const programStop =
    command.effectClass === "inspect" && stopped !== true
      ? programStopOf(command)
      : undefined;
  const selected =
    command.effectClass === "inspect"
      ? {
          causeCode: programStop ?? deadlineCause.unchanged,
          effects: unchangedEffects,
        }
      : summary
        ? {
            causeCode: deadlineCause[summary.transactionState],
            effects: summary.effects,
          }
        : { causeCode: deadlineCause.unknown, effects: incompleteEffects };
  return kernelResult(
    run,
    command.commandIdentity,
    selected.causeCode,
    programStop ? messages.programStop : messages.deadline,
    { handlerEntered: true, effects: selected.effects, summary },
  );
}

async function afterHandler(
  run: Run,
  command: CommandDeclaration,
  execution: Execution,
  deadlineAt: number | undefined,
): Promise<Delivery> {
  const identity = command.commandIdentity;
  const clean = await settleOwned(run, deadlineAt);
  if (clean === undefined)
    return afterDeadline(run, command, Promise.resolve(execution));
  const issued = run.runtime.trustedSummary(run.runId);
  const trusted = trustedRun(
    run,
    identity,
    true,
    clean ? issued : unconfirmedSummary(issued),
  );
  if (execution.kind === "threw")
    return {
      candidate: { ok: false, path: "handler", reason: "handler threw" },
      trusted,
    };
  const outcome = execution.outcome;
  if (!outcome.ok && outcome.path !== "result")
    return refusal(run, identity, outcome.path);
  if (!outcome.ok) return { candidate: outcome, trusted };
  if (!clean)
    return {
      candidate: {
        ok: false,
        path: "programs",
        reason: "owned program survived",
      },
      trusted,
    };
  return {
    candidate: await run.runtime.buildResult(outcome.value),
    trusted,
  };
}

async function runDeclaredCommand(
  run: Run,
  value: Resolved,
): Promise<Delivery> {
  const identity = value.commandIdentity;
  const plan = run.plans.get(identity);
  if (!plan) return preparationFault(run, identity);
  const deadline = value.deadlineMilliseconds;
  if (deadline !== undefined && run.host.now() - run.startedAt >= deadline)
    return await kernelResult(
      run,
      identity,
      "DOMAIN_DEADLINE_BEFORE_START",
      messages.DOMAIN_DEADLINE_BEFORE_START,
    );
  if (run.stopped) return undefined;
  const context = await capabilities(run, plan);
  if (!context) return preparationFault(run, identity);
  const deadlineAt =
    deadline === undefined ? undefined : run.startedAt + deadline;
  const checked = await checkPhase(run, value, context, deadlineAt);
  if (run.stopped) return undefined;
  if (checked.kind === "deadline" || expired(run, deadlineAt))
    return beforeStart(run, identity);
  if (checked.kind === "refused") return checked.delivery;
  const attached = await attachState(run, identity, checked.attach);
  if ("delivery" in attached) return attached.delivery;
  if (run.stopped) return undefined;
  if (expired(run, deadlineAt)) return beforeStart(run, identity);
  run.phase = "handler-entered";
  const execution: Promise<Execution> = attached.enter().then(
    (outcome) => ({ kind: "returned", outcome }) as const,
    () => ({ kind: "threw" }) as const,
  );
  run.handler = handlerOf(execution);
  const first =
    deadlineAt === undefined
      ? await execution
      : await within(execution, deadlineAt - run.host.now(), run.host.now);
  return first === undefined
    ? afterDeadline(run, plan.command, execution)
    : afterHandler(run, plan.command, first, deadlineAt);
}

type CheckPhase =
  | { readonly kind: "deadline" }
  | { readonly kind: "refused"; readonly delivery: Delivery }
  | { readonly kind: "entry"; readonly attach: Attach };
// Runs the runtime's check phase raced against the deadline. Every refusal
// here keeps the handler-entry fact false (`handlerEntered` unset), so it never
// carries a status (accepted decision DIAG-1; DS05).
async function checkPhase(
  run: Run,
  value: Resolved,
  context: Record<string, unknown>,
  deadlineAt: number | undefined,
): Promise<CheckPhase> {
  const identity = value.commandIdentity;
  const prepared = run.runtime
    .prepare(identity, value.args, run.runId, context)
    .then(
      (outcome) => ({ kind: "returned", outcome }) as const,
      () => ({ kind: "threw" }) as const,
    );
  const settled =
    deadlineAt === undefined
      ? await prepared
      : await within(prepared, deadlineAt - run.host.now(), run.host.now);
  if (settled === undefined) return { kind: "deadline" };
  if (settled.kind === "threw")
    return { kind: "refused", delivery: await preparationFault(run, identity) };
  const outcome = settled.outcome;
  if (outcome.ok) return { kind: "entry", attach: outcome.value };
  return {
    kind: "refused",
    delivery: await refusal(run, identity, outcome.path),
  };
}

function handlerOf(execution: Promise<Execution>): Handler {
  const handler: Handler = {
    returned: false,
    returning: execution.then(() => {
      handler.returned = true;
    }),
  };
  return handler;
}

function expired(run: Run, deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && run.host.now() >= deadlineAt;
}

function beforeStart(run: Run, identity: string): Promise<Delivery> {
  run.controller.abort();
  return kernelResult(
    run,
    identity,
    "DOMAIN_DEADLINE_BEFORE_START",
    messages.DOMAIN_DEADLINE_BEFORE_START,
  );
}

function refusal(run: Run, identity: string, path: string): Promise<Delivery> {
  const causeCode =
    path === "approval"
      ? "DOMAIN_AUTHORITY_REQUIRED"
      : path === "capabilities"
        ? "INTERNAL_PREPARATION"
        : "USAGE_INVALID_INVOCATION";
  return kernelResult(run, identity, causeCode, messages[causeCode]);
}

function preparationFault(run: Run, identity: string): Promise<Delivery> {
  return kernelResult(
    run,
    identity,
    "INTERNAL_PREPARATION",
    messages.INTERNAL_PREPARATION,
  );
}

async function attachState(
  run: Run,
  identity: string,
  attach: Attach,
): Promise<{ readonly enter: Enter } | { readonly delivery: Delivery }> {
  let entry: Validation<Enter>;
  try {
    entry = attach();
  } catch {
    return { delivery: await preparationFault(run, identity) };
  }
  return entry.ok
    ? { enter: entry.value }
    : { delivery: await refusal(run, identity, entry.path) };
}

async function route(run: Run, resolution: Resolution): Promise<Delivery> {
  if (!resolution.ok) {
    run.commandIdentity = resolution.commandIdentity;
    return await kernelResult(
      run,
      resolution.commandIdentity,
      resolution.causeCode,
      messages[resolution.causeCode],
    );
  }
  const value = resolution.value;
  run.commandIdentity = value.commandIdentity;
  const navigation = builtin(run, value);
  if (!navigation) return runDeclaredCommand(run, value);
  run.phase = "handler-entered";
  return kernelResult(
    run,
    value.commandIdentity,
    "SUCCESS_UNCHANGED",
    navigation.message,
    { handlerEntered: true, data: navigation.data },
  );
}

function newRun(prepared: Prepared, host: ProcessHost): Run {
  return {
    ...prepared,
    host,
    runId: crypto.randomUUID(),
    startedAt: host.now(),
    controller: new AbortController(),
    attached: [],
    reporter: undefined,
    phase: "preparing",
    commandIdentity: null,
    stopped: undefined,
    emergencyAttempted: false,
    handler: undefined,
  };
}

type Output = {
  readonly host: ProcessHost;
  readonly machine: "always" | "as-asked";
};

async function deliver(
  run: Run,
  argv: unknown,
  output: Output,
): Promise<number | undefined> {
  const resolution = await run.runtime.resolve(argv);
  const asked = resolution.ok ? resolution.value.machine : resolution.machine;
  const writer = createWriter({
    host: output.host,
    runtime: run.runtime,
    machine: output.machine === "always" || asked,
    stopping: () => run.stopped !== undefined,
  });
  const delivery = await route(run, resolution);
  if (!delivery) return 1;
  const reporter = await reporterFor(run, delivery.trusted);
  const report =
    reporter && !run.stopped ? await freezeStatus(run, reporter) : undefined;
  run.phase = "emitting";
  return writer.emit(delivery.candidate, delivery.trusted, report);
}

async function runInvocation(run: Run, argv: unknown): Promise<number> {
  installHooks(run);
  const code = await deliver(run, argv, {
    host: run.host,
    machine: "as-asked",
  });
  if (code === undefined || run.stopped) return code ?? 1;
  run.phase = "drained";
  run.host.exit(code);
  return code;
}

type CrashListener = NonNullable<InProcessSetup["onCrash"]>;
type InFlight = {
  readonly runs: Set<Run>;
  readonly listeners: Set<CrashListener>;
  stopped: StopSignal | undefined;
  crash: "none" | "listening" | "exited";
};
const inFlightByHost = new WeakMap<ProcessHost, InFlight>();

function stopEvery(inFlight: InFlight, host: ProcessHost, signal: StopSignal) {
  const code = stopCode(signal);
  const runs = [...inFlight.runs];
  if (inFlight.stopped) {
    for (const run of runs) killAll(run);
    host.exit(code);
    return;
  }
  inFlight.stopped = signal;
  for (const run of runs) {
    run.stopped = signal;
    run.controller.abort();
  }
  void within(
    Promise.all(runs.map((run) => settleAll(run, settleLimitMilliseconds))),
    stopBoundMilliseconds,
    host.now,
  ).then(() => host.exit(code));
}

function inFlightOn(host: ProcessHost): InFlight {
  const known = inFlightByHost.get(host);
  if (known) return known;
  const inFlight: InFlight = {
    runs: new Set(),
    listeners: new Set(),
    stopped: undefined,
    crash: "none",
  };
  inFlightByHost.set(host, inFlight);
  host.onSignal((signal) => stopEvery(inFlight, host, signal));
  host.onCrash((error) => crashEvery(inFlight, host, error));
  return inFlight;
}

function heard(listener: CrashListener, error: unknown): Promise<void> {
  try {
    return Promise.resolve(listener(error));
  } catch {
    return Promise.resolve();
  }
}

function crashEvery(inFlight: InFlight, host: ProcessHost, error: unknown) {
  for (const run of inFlight.runs) crashRun(run);
  if (inFlight.crash !== "none" || inFlight.listeners.size === 0) {
    inFlight.crash = "exited";
    host.exit(1);
    return;
  }
  inFlight.crash = "listening";
  const listening = [...inFlight.listeners].map((each) => heard(each, error));
  void within(
    Promise.allSettled(listening),
    stopBoundMilliseconds,
    host.now,
  ).then(() => {
    if (inFlight.crash !== "listening") return;
    inFlight.crash = "exited";
    host.exit(1);
  });
}

const decoder = new TextDecoder();

async function returnedResult(
  run: Run,
  code: number,
  chunks: readonly Uint8Array[],
): Promise<InProcessResult> {
  const text = chunks.map((chunk) => decoder.decode(chunk)).join("");
  const checked =
    text === "" ? undefined : await run.runtime.validate(JSON.parse(text));
  return checked?.ok
    ? {
        kind: "envelope",
        runId: run.runId,
        exitCode: code,
        envelope: checked.value,
      }
    : { kind: "no-envelope", runId: run.runId, exitCode: 1 };
}

// Accepted decision (Nathan, 19 November 2026, 12:08 AEDT): the state seam
// forgets an in-process run's identity once the run has finished. A handler
// can outlive its run's deadline, so the run stays live until its handler,
// if entered, has returned.
function forgetWhenReturned(run: Run): void {
  const forget = () => run.runtime.forgetState(run.runId);
  if (!run.handler || run.handler.returned) forget();
  else void run.handler.returning.then(forget);
}

async function runAndReturn(
  run: Run,
  argv: unknown,
  listener: CrashListener | undefined,
): Promise<InProcessResult> {
  const inFlight = inFlightOn(run.host);
  if (listener) inFlight.listeners.add(listener);
  run.stopped = inFlight.stopped;
  inFlight.runs.add(run);
  const chunks: Uint8Array[] = [];
  const capture: ProcessHost = {
    ...run.host,
    write(stream, bytes) {
      if (stream === "stdout") chunks.push(bytes);
      return Promise.resolve(true);
    },
  };
  try {
    const code = run.stopped
      ? undefined
      : await deliver(run, argv, { host: capture, machine: "always" });
    const signal = run.stopped;
    if (signal) return { kind: "stopped", runId: run.runId, signal };
    return await returnedResult(run, code ?? 1, chunks);
  } catch (error) {
    run.controller.abort();
    crashRun(run);
    throw error;
  } finally {
    if (!run.stopped) inFlight.runs.delete(run);
    forgetWhenReturned(run);
  }
}
