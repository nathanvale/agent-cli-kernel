import { appendFileSync } from "node:fs";
import { jest } from "bun:test";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  ProgramRequest,
  ProgramsCapability,
} from "../../../kernel/src/kernel/index.ts";
import type {
  ProcessHost,
  StopSignal,
} from "../../../kernel/src/kernel/process-types.ts";
import { path } from "../../../kernel/src/kernel/validation/brands.ts";
import { stateAddon } from "../../../kernel/src/addons/state/index.ts";
import { readsUnchanged } from "../kernel-repair/handlers.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
} from "../kernel-repair/shapes.ts";
import { timerLimit, unchangedEffects } from "./oracle.ts";
import { programStopRow, programStopStation } from "./program-stop.ts";
import { signalGroupIfPresent } from "../../support/signal.ts";

type Recorded = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly at: number;
};

export function recordingHost() {
  const writes: Recorded[] = [];
  const exits: number[] = [];
  const exitedAt: number[] = [];
  const installs = { signal: 0, crash: 0 };
  let listener: ((signal: StopSignal) => void) | undefined;
  let crashListener: ((error: unknown) => void) | undefined;
  const decoder = new TextDecoder();
  const host: ProcessHost = {
    write(stream, bytes) {
      writes.push({
        stream,
        text: decoder.decode(bytes),
        at: performance.now(),
      });
      return Promise.resolve(true);
    },
    exit(code) {
      exits.push(code);
      exitedAt.push(performance.now());
    },
    onSignal(next) {
      installs.signal += 1;
      listener = next;
    },
    onCrash(next) {
      installs.crash += 1;
      crashListener = next;
    },
    now: () => performance.now(),
  };
  return {
    host,
    writes,
    exits,
    exitedAt,
    installs,
    signal(name: StopSignal) {
      if (!listener)
        throw new Error("The front door installed no signal hook.");
      listener(name);
    },
    crash(error: unknown = new Error("Planted crash.")) {
      if (!crashListener)
        throw new Error("The kernel installed no crash hook.");
      crashListener(error);
    },
  };
}

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Platform: Event-loop turns. setImmediate is not faked by Bun's fake timers.
export async function turns(count = 20): Promise<void> {
  for (let index = 0; index < count; index++)
    await new Promise((done) => setImmediate(done));
}

// Platform: A real pause that fake timers cannot shorten: Bun fakes setTimeout,
// Bun.sleep, Date.now, performance.now and Bun.nanoseconds.
export function realPause(seconds: number): void {
  Bun.spawnSync(["/bin/sleep", String(seconds)]);
}

export async function until(
  condition: () => boolean,
  seconds = 5,
): Promise<boolean> {
  for (let tries = 0; tries < seconds * 100; tries++) {
    if (condition()) return true;
    await turns(2);
    realPause(0.01);
  }
  return condition();
}

export async function advance(milliseconds: number): Promise<void> {
  const target = performance.now() + milliseconds;
  while (performance.now() < target) {
    const sentinel = setTimeout(
      () => undefined,
      Math.min(target - performance.now(), timerLimit),
    );
    jest.advanceTimersToNextTimer();
    clearTimeout(sentinel);
    await turns();
  }
}

const listingBound = 5_000;
export function markedPids(marker: string): readonly number[] {
  const listed = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,args="], {
    timeout: listingBound,
    killSignal: "SIGKILL",
  });
  if (!listed.success)
    throw new Error(
      `UNPROVED: /bin/ps did not list processes within ${String(listingBound)} ms.`,
    );
  return listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number(line.trim().split(" ")[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}
export function killMarked(marker: string): void {
  for (const pid of markedPids(marker)) signalGroupIfPresent(pid, "SIGKILL");
}

export function shell(
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

const rcCauses = {
  ...commonCauses,
  DOMAIN_RC_DEADLINE_PROGRAM_STOP_UNCONFIRMED: programStopRow,
} as const;
export function holdContract(
  work: (programs: ProgramsCapability, signal: AbortSignal) => Promise<void>,
) {
  const hold = command({
    identity: "rc.hold",
    route: ["hold"],
    summary: "Hold until the test releases the handler.",
    input: {
      arguments: [],
      options: [],
      constraints: [],
      deadlineSupported: true,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { programs: true },
    stations: [
      station(rcCauses, {
        commandIdentity: "rc.hold",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Released.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        retryDelayPolicy: { kind: "none" },
        reachability: "required",
        unreachableRationale: null,
        independentObservable: "rc.hold:released",
      }),
      programStopStation(
        rcCauses,
        "rc.hold",
        "DOMAIN_RC_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
      ),
    ],
    programStopCause: "DOMAIN_RC_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
    run: async (_input, context) => {
      await work(context.programs, context.signal);
      return context.result(
        { commandIdentity: "rc.hold", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Released.", data: null, effects: unchangedEffects },
      );
    },
  });
  return contractFor({
    cli: "rc",
    commands: [hold],
    causes: { DOMAIN_RC_DEADLINE_PROGRAM_STOP_UNCONFIRMED: programStopRow },
    installedAddons: ["programs"],
  });
}

const stateCauses = {
  DOMAIN_RC_LOCK_HELD: refusedHandoff,
  DOMAIN_RC_UNRESOLVED: refusedHandoff,
  DOMAIN_RC_DECLINED: { ...refusedHandoff, guidance: "next" },
} as const satisfies CauseTable;
const allStateCauses = { ...commonCauses, ...stateCauses };
const inspectCases = {
  next: { kind: "instruction", text: "Inspect listed cases." },
} as const;

export function stateHoldContract(
  root: string,
  work: (programs: ProgramsCapability) => Promise<void>,
) {
  const state = stateAddon({ root, report: "rc.pending" });
  const handoff = {
    handoff: {
      owner: "operator",
      reason: "Coordination refused.",
      inspect: [{ kind: "command", command: "rc.pending", args: [] }],
    },
  } as const;
  const pending = command({
    identity: "rc.pending",
    route: ["pending"],
    summary: "Report unfinished work.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allStateCauses, {
        ...stationWords,
        commandIdentity: "rc.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: inspectCases,
        independentObservable: "rc.pending:read",
      }),
    ],
    run: readsUnchanged("rc.pending"),
  });
  const coordination = (
    causeCode: "DOMAIN_RC_LOCK_HELD" | "DOMAIN_RC_UNRESOLVED",
  ) =>
    station(allStateCauses, {
      ...stationWords,
      commandIdentity: "rc.change",
      causeCode,
      trigger: "Coordination refused.",
      repairAction: "Inspect the unfinished report.",
      guidance: handoff,
      independentObservable: `rc.change:${causeCode}`,
    });
  const change = changing({
    identity: "rc.change",
    route: ["change"],
    summary: "Hold, then decline to change anything.",
    input: { ...emptyInput, deadlineSupported: true },
    capabilities: { programs: true },
    effectClass: "repository-local",
    effects: ["rc.note"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_RC_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_RC_UNRESOLVED",
    stations: [
      coordination("DOMAIN_RC_LOCK_HELD"),
      coordination("DOMAIN_RC_UNRESOLVED"),
      station(allStateCauses, {
        ...stationWords,
        commandIdentity: "rc.change",
        causeCode: "DOMAIN_RC_DECLINED",
        trigger: "The handler declined to change anything.",
        repairAction: "Nothing to repair.",
        guidance: inspectCases,
        independentObservable: "rc.change:declined",
      }),
    ],
    run: async (_input, context) => {
      await work(context.programs);
      return context.result(
        { commandIdentity: "rc.change", causeCode: "DOMAIN_RC_DECLINED" },
        { message: "Declined.", data: null, effects: unchangedEffects },
      );
    },
  });
  const contract = contractFor({
    cli: "rc",
    commands: [change, pending],
    state: state.descriptor,
    causes: stateCauses,
    installedAddons: ["state", "programs"],
  });
  return { contract, descriptor: state.descriptor };
}

export function note(entry: Record<string, unknown>): void {
  const target = process.env.T2_EVIDENCE;
  if (target) appendFileSync(target, `${JSON.stringify(entry)}\n`);
}
