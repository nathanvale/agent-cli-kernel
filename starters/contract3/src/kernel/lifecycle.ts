import type { RunProcess } from "./capabilities.ts";
import type { TrustedRun } from "./fallback.ts";
import { processHost } from "./process-host.ts";
import type {
  AttachedAddon,
  EmergencyFacts,
  ProcessHost,
  RunAddon,
  RunControl,
  RunSetup,
  StopSignal,
} from "./process-types.ts";
import { runtimeOf } from "./runtime.ts";
import type { ContractRuntime, Resolution } from "./runtime.ts";
import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
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

// LIFE-3, LIFE-6 and LIFE-11 bounds. A first stop request exits within the
// 500 ms bound: owned programs get SIGTERM, then SIGKILL by the settle limit.
const settleLimitMilliseconds = 300;
const stopBoundMilliseconds = 450;
const cancellationMilliseconds = 500;
// DIAG-14 step 2 and DIAG-9: the diagnostics flush takes at most 500 ms.
const flushMilliseconds = 500;
// Provisional reading (coordinator ruling, 16 November 2026, to be judged by
// the T5 reviewer): a status is due only once the handler was reached, so a
// usage or approval refusal and a deadline before start carry no
// `diagnostics` key. Set to true to give every refusal of a command that
// declares a status-reporting add-on a status too (see `refused`).
const statusOnPreHandlerRefusal = false;

const messages = {
  USAGE_UNKNOWN_COMMAND: "No declared command matches this invocation.",
  USAGE_INVALID_INVOCATION:
    "The invocation is not valid for the selected command.",
  INTERNAL_PREPARATION: "The CLI could not prepare this command.",
  DOMAIN_AUTHORITY_REQUIRED: "The required authority was not confirmed.",
  DOMAIN_DEADLINE_BEFORE_START:
    "The deadline passed before the operation started. Nothing was dispatched.",
  deadline: "The deadline passed after the operation started.",
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

// Finding 1 (Nathan, 16 November 2026): every admitted duration is honoured,
// with no cap. A runtime timer holds at most 2,147,483,647 ms and fires a
// longer delay after 1 ms. A longer wait is armed in steps of at most that
// limit and re-measured on the front door's clock after each step, so it
// fires neither early nor a step late. A wait within the limit arms once,
// with its exact delay. The programs add-on keeps its own copy, because an
// add-on imports only the fixed public index (CMD-5, CMD-17).
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

// Races a promise against a timer and always clears the timer, so a host that
// declines to exit is never held open by a stale deadline or stop bound.
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

// Fixed at construction: every declared capability resolves to its add-on,
// or the front door refuses to build.
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

// The process front door (CMD-5, CMD-9). It installs the stream, signal and
// crash hooks before dispatch, routes, refuses, dispatches, enforces the
// deadline, settles owned programs and hands one result to the one writer.
// It owns process termination through the real process adapter.
export function runProcess(contract: object, setup: RunSetup = {}): RunProcess {
  return runProcessOn(contract, setup, processHost);
}

// Kernel-internal entry used by runProcess and by the labelled test-only
// fault fixture, which wraps the process adapter. Not on the public index.
export function runProcessOn(
  contract: object,
  setup: RunSetup,
  host: () => ProcessHost,
): RunProcess {
  const runtime = runtimeOf(contract);
  if (!runtime)
    throw new Error("runProcess needs a contract composed by contractFor.");
  const plans = plansFor(runtime, setup);
  return (argv) => runInvocation(runtime, setup, plans, host(), argv);
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
  // The one attached add-on offering the status seam, if any.
  reporter: AttachedAddon<unknown> | undefined;
  phase: EmergencyFacts["phase"];
  commandIdentity: string | null;
  stopped: StopSignal | undefined;
  emergencyAttempted: boolean;
};
// What the writer receives, or undefined when a stop request owns the exit.
// `statusDue` says whether the frozen result carries a diagnostics status.
type Delivery =
  | {
      readonly candidate: Validation<unknown>;
      readonly trusted: TrustedRun;
      readonly statusDue?: boolean;
    }
  | undefined;
type Resolved = Extract<Resolution, { readonly ok: true }>["value"];

function killAll(run: Run) {
  for (const addon of run.attached)
    try {
      addon.killNow();
    } catch {
      // A failed kill request is still only an attempt.
    }
}

async function settleAll(run: Run, limit?: number, ownedOnly = false) {
  const settled = await Promise.all(
    run.attached
      .filter((addon) => !ownedOnly || addon !== run.reporter)
      .map((addon) => addon.settle(limit).catch(() => false)),
  );
  return settled.every(Boolean);
}

const statusUnavailable = () => ({
  status: "unavailable",
  reason: "status-unavailable",
  trusted: {},
});

// DIAG-14 step 2: the status-reporting add-on freezes its status within the
// flush budget, under the kernel's own bounded wait. Expiry, a throw or a
// missing `freeze` yield the unavailable variant; the writer validates the
// value alone (LIFE-7 step 1).
async function freezeStatus(
  run: Run,
  reporter: AttachedAddon<unknown>,
): Promise<StatusReport> {
  try {
    const freeze = reporter.freeze;
    if (!freeze) return { value: statusUnavailable() };
    const frozen = await within(
      Promise.resolve().then(() => freeze(flushMilliseconds)),
      flushMilliseconds,
      run.host.now,
    );
    return frozen === undefined
      ? { value: statusUnavailable() }
      : { value: frozen };
  } catch {
    return { value: statusUnavailable() };
  }
}

// LIFE-3: hooks are installed before routing or dispatch.
function installHooks(run: Run) {
  run.host.onSignal((signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (run.stopped || run.phase === "drained") {
      // A repeated signal: forced kill attempt, then immediate exit.
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
    killAll(run);
    if (!run.emergencyAttempted) {
      run.emergencyAttempted = true;
      try {
        run.setup.emergencyRecord?.({
          runId: run.runId,
          commandIdentity: run.commandIdentity,
          phase: run.phase,
        });
      } catch {
        // LIFE-6a: one attempt only, no retry and no output.
      }
    }
    run.host.exit(1);
  });
}

function trustedRun(
  run: Run,
  identity: string,
  dispatched: boolean,
  summary?: StateObservation,
): TrustedRun {
  return {
    runId: run.runId,
    commandIdentity: identity,
    dispatched,
    ...(summary ? { summary } : {}),
  };
}

async function kernelResult(
  run: Run,
  identity: string,
  causeCode: string,
  message: string,
  options: {
    readonly dispatched?: boolean;
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
      options.dispatched ?? false,
      options.summary,
    ),
  };
}

// Every kernel refusal of a routed command passes here, so the provisional
// reading above is one constant. Under the other reading the command's
// status-reporting add-on attaches (effect-free) and its status is frozen.
function refused(run: Run, identity: string, delivery: Delivery): Delivery {
  if (!statusOnPreHandlerRefusal || !delivery) return delivery;
  const plan = run.plans.get(identity);
  const entry = plan?.addons.find((item) => item.addon.reportsStatus === true);
  if (plan && entry && !run.reporter)
    run.reporter = attachNow(run, plan.command, entry.addon);
  return { ...delivery, statusDue: run.reporter !== undefined };
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
): AttachedAddon<unknown> {
  const instance = addon.attach(control(run, command));
  run.attached.push(instance);
  return instance;
}

// A capability whose add-on attaches on first use, so any attach-time effect
// happens only inside the handler, after every non-consuming preflight.
function deferred(run: Run, command: CommandDeclaration, plan: Plan) {
  let instance: AttachedAddon<unknown> | undefined;
  const methods = capabilityMethods[plan.name].map((method) => {
    const call = (...args: unknown[]): unknown => {
      instance ??= attachNow(run, command, plan.addon);
      const target = instance.capability;
      const operation: unknown = record(target) ? target[method] : undefined;
      if (typeof operation !== "function")
        throw new Error(`The ${plan.name} add-on lacks ${method}.`);
      const result: unknown = Reflect.apply(operation, target, args);
      return result;
    };
    return [method, call] as const;
  });
  return Object.freeze(Object.fromEntries(methods));
}

// CMD-9 steps 5 and 6: the approval add-on attaches before the handler,
// because its check is the step 5 preflight, and so does a status-reporting
// add-on, whose attach is effect-free, so its status exists even when the
// handler never uses it. Every other declared capability attaches when the
// handler first uses it.
function capabilities(run: Run, plan: CommandPlan): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const entry of plan.addons) {
    if (entry.name !== "approval" && entry.addon.reportsStatus !== true) {
      context[entry.name] = deferred(run, plan.command, entry);
      continue;
    }
    const instance = attachNow(run, plan.command, entry.addon);
    if (entry.addon.reportsStatus === true) run.reporter = instance;
    context[entry.name] = instance.capability;
  }
  return context;
}

// LIFE-6: stop starting work, then wait at most 500 ms for cancellation and
// observation. Unconfirmed effects are unknown.
async function afterDeadline(
  run: Run,
  command: CommandDeclaration,
  execution: Promise<Execution>,
): Promise<Delivery> {
  run.controller.abort();
  const [late] = await Promise.all([
    within(execution, cancellationMilliseconds, run.host.now),
    within(
      settleAll(run, settleLimitMilliseconds),
      cancellationMilliseconds,
      run.host.now,
    ),
  ]);
  const summary =
    late?.kind === "returned" && late.outcome.ok
      ? run.runtime.trustedSummary(late.outcome.value, run.runId)
      : undefined;
  const selected =
    command.effectClass === "inspect"
      ? { causeCode: deadlineCause.unchanged, effects: unchangedEffects }
      : summary
        ? {
            causeCode: deadlineCause[summary.transactionState],
            effects: summary.effects,
          }
        : { causeCode: deadlineCause.unknown, effects: incompleteEffects };
  const delivery = await kernelResult(
    run,
    command.commandIdentity,
    selected.causeCode,
    messages.deadline,
    { dispatched: true, effects: selected.effects, summary },
  );
  return delivery && { ...delivery, statusDue: true };
}

// LIFE-11 normal completion: owned programs are observed or stopped within
// their declared budgets before the result is frozen.
async function afterHandler(
  run: Run,
  identity: string,
  execution: Execution,
): Promise<Delivery> {
  // The status-reporting add-on is not an owned program: `freeze` replaces
  // its settle on this path, after the result is frozen.
  const clean = await settleAll(run, undefined, true);
  if (execution.kind === "threw")
    return {
      candidate: { ok: false, path: "handler", reason: "handler threw" },
      trusted: trustedRun(run, identity, true),
      statusDue: true,
    };
  const outcome = execution.outcome;
  if (!outcome.ok && outcome.path !== "result") {
    const causeCode =
      outcome.path === "approval"
        ? "DOMAIN_AUTHORITY_REQUIRED"
        : outcome.path === "capabilities"
          ? "INTERNAL_PREPARATION"
          : "USAGE_INVALID_INVOCATION";
    return refused(
      run,
      identity,
      await kernelResult(run, identity, causeCode, messages[causeCode]),
    );
  }
  if (!outcome.ok)
    return {
      candidate: outcome,
      trusted: trustedRun(run, identity, true),
      statusDue: true,
    };
  const summary = run.runtime.trustedSummary(outcome.value, run.runId);
  const trusted = trustedRun(run, identity, true, summary);
  if (!clean)
    return {
      candidate: {
        ok: false,
        path: "programs",
        reason: "owned program survived",
      },
      trusted,
      statusDue: true,
    };
  return {
    candidate: await run.runtime.buildResult(outcome.value),
    trusted,
    statusDue: true,
  };
}

async function dispatch(run: Run, value: Resolved): Promise<Delivery> {
  const identity = value.commandIdentity;
  const plan = run.plans.get(identity);
  // Type-forced guard: routing resolves only declared commands.
  if (!plan)
    return kernelResult(
      run,
      identity,
      "INTERNAL_PREPARATION",
      messages.INTERNAL_PREPARATION,
    );
  const deadline = value.deadlineMilliseconds;
  // CMD-9 step 4.
  if (deadline !== undefined && run.host.now() - run.startedAt >= deadline)
    return refused(
      run,
      identity,
      await kernelResult(
        run,
        identity,
        "DOMAIN_DEADLINE_BEFORE_START",
        messages.DOMAIN_DEADLINE_BEFORE_START,
      ),
    );
  if (run.stopped) return undefined;
  const context = capabilities(run, plan);
  run.phase = "dispatched";
  const execution: Promise<Execution> = run.runtime
    .execute(identity, value.args, run.runId, context)
    .then(
      (outcome) => ({ kind: "returned", outcome }) as const,
      () => ({ kind: "threw" }) as const,
    );
  const first =
    deadline === undefined
      ? await execution
      : await within(
          execution,
          run.startedAt + deadline - run.host.now(),
          run.host.now,
        );
  return first === undefined
    ? afterDeadline(run, plan.command, execution)
    : afterHandler(run, identity, first);
}

async function route(run: Run, resolution: Resolution): Promise<Delivery> {
  if (!resolution.ok) {
    run.commandIdentity = resolution.commandIdentity;
    return refused(
      run,
      resolution.commandIdentity,
      await kernelResult(
        run,
        resolution.commandIdentity,
        resolution.causeCode,
        messages[resolution.causeCode],
      ),
    );
  }
  const value = resolution.value;
  run.commandIdentity = value.commandIdentity;
  const navigation = builtin(run, value);
  if (!navigation) return dispatch(run, value);
  run.phase = "dispatched";
  return kernelResult(
    run,
    value.commandIdentity,
    "SUCCESS_UNCHANGED",
    navigation.message,
    { dispatched: true, data: navigation.data },
  );
}

async function runInvocation(
  runtime: ContractRuntime,
  setup: RunSetup,
  plans: ReadonlyMap<string, CommandPlan>,
  host: ProcessHost,
  argv: unknown,
): Promise<number> {
  const run: Run = {
    runtime,
    setup,
    plans,
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
  };
  installHooks(run);
  const resolution = await runtime.resolve(argv);
  const writer = createWriter({
    host,
    runtime,
    machine: resolution.ok ? resolution.value.machine : resolution.machine,
    stopping: () => run.stopped !== undefined,
  });
  const delivery = await route(run, resolution);
  if (!delivery) return 1;
  // DIAG-14: the domain result and recovery are frozen in `delivery`; only
  // now does the status-reporting add-on flush and freeze its status.
  const report =
    delivery.statusDue === true && run.reporter && !run.stopped
      ? await freezeStatus(run, run.reporter)
      : undefined;
  run.phase = "emitting";
  const code = await writer.emit(delivery.candidate, delivery.trusted, report);
  if (code === undefined || run.stopped) return code ?? 1;
  run.phase = "drained";
  host.exit(code);
  return code;
}
