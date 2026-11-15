import type { RunProcess } from "./capabilities.ts";
import type { TrustedRun } from "./fallback.ts";
import { processHost } from "./process-host.ts";
import type {
  AttachedAddon,
  EmergencyFacts,
  ProcessHost,
  RunControl,
  RunSetup,
  StopSignal,
} from "./process-types.ts";
import { runtimeOf } from "./runtime.ts";
import type { ContractRuntime, Resolution } from "./runtime.ts";
import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { StateObservation } from "./state-seam.ts";
import type { Effects, JsonValue, Validation } from "./types.ts";
import { createWriter } from "./writer.ts";

// LIFE-3, LIFE-6 and LIFE-11 bounds. A first stop request exits within the
// 500 ms bound: owned programs get SIGTERM, then SIGKILL by the settle limit.
const settleLimitMilliseconds = 300;
const stopBoundMilliseconds = 450;
const cancellationMilliseconds = 500;

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

const unchanged: Effects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
};
const incomplete: Effects = { ...unchanged, inventoryComplete: false };
const deadlineCause = {
  unchanged: "DOMAIN_DEADLINE_UNCHANGED",
  completed: "DOMAIN_DEADLINE_COMPLETED",
  "partially-completed": "DOMAIN_DEADLINE_PARTIAL",
  unknown: "DOMAIN_DEADLINE_UNKNOWN",
} as const;

type Execution =
  | {
      readonly kind: "returned";
      readonly outcome: Validation<CommandResult>;
    }
  | { readonly kind: "threw" };

function delay(milliseconds: number): Promise<undefined> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(undefined), Math.max(0, milliseconds)),
  );
}

function addonFor(setup: RunSetup, name: string) {
  switch (name) {
    case "programs":
      return setup.addons?.programs;
    case "approval":
      return setup.addons?.approval;
    case "diagnostics":
      return setup.addons?.diagnostics;
    default:
      return undefined;
  }
}

// The process front door (CMD-5, CMD-9). It installs the stream, signal and
// crash hooks before dispatch, routes, refuses, dispatches, enforces the
// deadline, settles owned programs and hands one result to the one writer.
// It owns process termination: the returned promise settles only when a
// wrapped host declines to exit.
export function runProcess(contract: object, setup: RunSetup = {}): RunProcess {
  const runtime = runtimeOf(contract);
  if (!runtime)
    throw new Error("runProcess needs a contract composed by contractFor.");
  for (const command of runtime.commands)
    for (const name of Object.keys(command.capabilities))
      if (!addonFor(setup, name))
        throw new Error(
          `${command.commandIdentity} declares ${name}; supply its add-on.`,
        );
  return (argv) => runInvocation(runtime, setup, argv);
}

type Run = {
  readonly runtime: ContractRuntime;
  readonly setup: RunSetup;
  readonly host: ProcessHost;
  readonly runId: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly attached: AttachedAddon<unknown>[];
  phase: EmergencyFacts["phase"];
  commandIdentity: string | null;
  stopped: StopSignal | undefined;
  emergencyAttempted: boolean;
};
// What the writer receives, or undefined when a stop request owns the exit.
type Delivery =
  | { readonly candidate: Validation<unknown>; readonly trusted: TrustedRun }
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

async function settleAll(run: Run, limit?: number) {
  const settled = await Promise.all(
    run.attached.map((addon) => addon.settle(limit).catch(() => false)),
  );
  return settled.every(Boolean);
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
    void Promise.race([
      settleAll(run, settleLimitMilliseconds),
      delay(stopBoundMilliseconds),
    ]).then(() => run.host.exit(code));
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
  const candidate = await run.runtime.build(
    { commandIdentity: identity, causeCode },
    { runId: run.runId, message, data: options.data ?? null },
    options.effects ?? unchanged,
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

// CMD-9 step 6: attach only the declared capabilities.
function attach(run: Run, command: CommandDeclaration) {
  const control: RunControl = {
    runId: run.runId,
    commandIdentity: command.commandIdentity,
    summary: command.summary,
    signal: run.controller.signal,
  };
  const context: Record<string, unknown> = {};
  for (const name of Object.keys(command.capabilities)) {
    const addon = addonFor(run.setup, name);
    if (!addon) return undefined;
    const instance: AttachedAddon<unknown> = addon.attach(control);
    run.attached.push(instance);
    context[name] = instance.capability;
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
    Promise.race([execution, delay(cancellationMilliseconds)]),
    Promise.race([
      settleAll(run, settleLimitMilliseconds),
      delay(cancellationMilliseconds),
    ]),
  ]);
  const summary =
    late?.kind === "returned" && late.outcome.ok
      ? run.runtime.trustedSummary(late.outcome.value, run.runId)
      : undefined;
  const selected =
    command.effectClass === "inspect"
      ? { causeCode: deadlineCause.unchanged, effects: unchanged }
      : summary
        ? {
            causeCode: deadlineCause[summary.transactionState],
            effects: summary.effects,
          }
        : { causeCode: deadlineCause.unknown, effects: incomplete };
  return kernelResult(
    run,
    command.commandIdentity,
    selected.causeCode,
    messages.deadline,
    { dispatched: true, effects: selected.effects, summary },
  );
}

// LIFE-11 normal completion: owned programs are observed or stopped within
// their declared budgets before the result is frozen.
async function afterHandler(
  run: Run,
  identity: string,
  execution: Execution,
): Promise<Delivery> {
  const clean = await settleAll(run);
  if (execution.kind === "threw")
    return {
      candidate: { ok: false, path: "handler", reason: "handler threw" },
      trusted: trustedRun(run, identity, true),
    };
  const outcome = execution.outcome;
  if (!outcome.ok && outcome.path !== "result") {
    const causeCode =
      outcome.path === "approval"
        ? "DOMAIN_AUTHORITY_REQUIRED"
        : outcome.path === "capabilities"
          ? "INTERNAL_PREPARATION"
          : "USAGE_INVALID_INVOCATION";
    return kernelResult(run, identity, causeCode, messages[causeCode]);
  }
  if (!outcome.ok)
    return { candidate: outcome, trusted: trustedRun(run, identity, true) };
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
    };
  return { candidate: await run.runtime.buildResult(outcome.value), trusted };
}

async function dispatch(run: Run, value: Resolved): Promise<Delivery> {
  const identity = value.commandIdentity;
  const command = run.runtime.commands.find(
    (item) => item.commandIdentity === identity,
  );
  if (!command)
    return kernelResult(
      run,
      identity,
      "INTERNAL_PREPARATION",
      messages.INTERNAL_PREPARATION,
    );
  const deadline = value.deadlineMilliseconds;
  // CMD-9 step 4.
  if (deadline !== undefined && run.host.now() - run.startedAt >= deadline)
    return kernelResult(
      run,
      identity,
      "DOMAIN_DEADLINE_BEFORE_START",
      messages.DOMAIN_DEADLINE_BEFORE_START,
    );
  if (run.stopped) return undefined;
  const context = attach(run, command);
  if (!context)
    return kernelResult(
      run,
      identity,
      "INTERNAL_PREPARATION",
      messages.INTERNAL_PREPARATION,
    );
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
      : await Promise.race([
          execution,
          delay(run.startedAt + deadline - run.host.now()).then(
            () => "deadline" as const,
          ),
        ]);
  return first === "deadline"
    ? afterDeadline(run, command, execution)
    : afterHandler(run, identity, first);
}

async function route(run: Run, resolution: Resolution): Promise<Delivery> {
  if (!resolution.ok) {
    run.commandIdentity = resolution.commandIdentity;
    return kernelResult(
      run,
      resolution.commandIdentity,
      resolution.causeCode,
      messages[resolution.causeCode],
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
  argv: unknown,
): Promise<number> {
  const host = setup.host ?? processHost();
  const run: Run = {
    runtime,
    setup,
    host,
    runId: crypto.randomUUID(),
    startedAt: host.now(),
    controller: new AbortController(),
    attached: [],
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
  run.phase = "emitting";
  const code = await writer.emit(delivery.candidate, delivery.trusted);
  if (code === undefined || run.stopped) return code ?? 1;
  run.phase = "drained";
  host.exit(code);
  return code;
}
