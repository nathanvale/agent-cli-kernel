import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  EffectTransaction,
  InProcessResult,
} from "../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../kernel/src/addons/state/index.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "./kernel-repair/shapes.ts";
import { testFolder } from "../support/test-folder.ts";

const causes = {
  DOMAIN_RC_LOCK_HELD: refusedHandoff,
  DOMAIN_RC_UNRESOLVED: refusedHandoff,
  DOMAIN_RC_UNAVAILABLE: refusedHandoff,
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "rc.pending", args: [] }],
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
  const folder = testFolder("c3-rc-");
  folders.push(folder);
  return join(folder, "state");
}

function envelopeOf(outcome: InProcessResult) {
  if (outcome.kind !== "envelope")
    throw new Error(`Expected envelope outcome, got ${outcome.kind}.`);
  return outcome;
}

function sharedCounter(): { readonly seen: number[] } {
  const seen: number[] = [];
  return { seen };
}

function pendingCommand() {
  return command({
    identity: "rc.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "rc.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "rc.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "rc.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

function changingStations() {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "rc.apply",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "rc.apply:done",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "rc.apply",
      causeCode: "DOMAIN_RC_LOCK_HELD",
      trigger: "Held.",
      repairAction: "Wait.",
      guidance: handoff,
      independentObservable: "rc.apply:held",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "rc.apply",
      causeCode: "DOMAIN_RC_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "rc.apply:unresolved",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "rc.apply",
      causeCode: "DOMAIN_RC_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "rc.apply:unavailable",
    }),
  ];
}

function rememberHost(shared: { readonly seen: number[] }) {
  const remember = command({
    identity: "rc.remember",
    route: ["remember"],
    summary: "Remember a run.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) => {
      shared.seen.push(shared.seen.length);
      return context.result(
        { commandIdentity: "rc.remember", causeCode: "SUCCESS_UNCHANGED" },
        { message: "ok", data: shared, effects: unchanged },
      );
    },
  });
  return runInProcess(contractFor({ cli: "rc", commands: [remember] }));
}

function changingHost(root: string, shared: { readonly seen: number[] }) {
  const state = stateAddon({
    root,
    report: "rc.pending",
    admissionWaitMilliseconds: 300,
  });
  const apply = changing({
    identity: "rc.apply",
    route: ["apply"],
    summary: "Apply.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_RC_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_RC_UNRESOLVED",
    stations: changingStations(),
    run: async (_input, context) => {
      shared.seen.push(shared.seen.length);
      const outcome = await state.transaction(
        context.state,
        {
          command: "rc.apply",
          scope: { resources: [{ resource: "note", key: "k1" }] },
        },
        async (transaction: EffectTransaction<Effects>) => {
          await transaction.record(
            "note.write",
            () => Promise.resolve(),
            () => Promise.resolve(true),
          );
        },
      );
      if (outcome.kind !== "ran")
        return context.result(
          { commandIdentity: "rc.apply", causeCode: "DOMAIN_RC_UNAVAILABLE" },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      return context.result(
        { commandIdentity: "rc.apply", causeCode: "SUCCESS_COMPLETED" },
        { message: "ran", data: shared, transaction: outcome.proof },
      );
    },
  });
  return runInProcess(
    contractFor({
      cli: "rc",
      commands: [pendingCommand(), apply],
      causes: allCauses,
      state: state.descriptor,
      installedAddons: ["state"],
    }),
    { emergencyRecord: state.emergencyRecord },
  );
}

function uncloneableData(value: unknown): Readonly<Record<string, never>> {
  const target: Record<string, never> = {};
  Object.defineProperty(target, "bad", { value, enumerable: true });
  return target;
}

function uncloneableHost(value: unknown) {
  const broken = command({
    identity: "rc.broken",
    route: ["broken"],
    summary: "Return uncloneable data.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: "rc.broken", causeCode: "SUCCESS_UNCHANGED" },
        { message: "ok", data: uncloneableData(value), effects: unchanged },
      ),
  });
  return runInProcess(contractFor({ cli: "rc", commands: [broken] }));
}

describe("result data copy", () => {
  test("RC01.a handler object stays mutable across runs in one host", async () => {
    const shared = sharedCounter();
    const run = rememberHost(shared);

    const first = envelopeOf(await run(["remember"]));
    expect(first.exitCode).toBe(0);
    expect(first.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.seen)).toBe(false);

    const second = envelopeOf(await run(["remember"]));
    expect(second.exitCode).toBe(0);
    expect(second.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(first.envelope.result.data).toEqual({ seen: [0] });
    expect(second.envelope.result.data).toEqual({ seen: [0, 1] });
    expect(shared.seen).toEqual([0, 1]);
  });

  test("RC02.a envelope data is frozen", async () => {
    const shared = sharedCounter();
    const run = rememberHost(shared);

    const first = envelopeOf(await run(["remember"]));
    expect(first.exitCode).toBe(0);
    const data = first.envelope.result.data;
    expect(data).toEqual({ seen: [0] });
    expect(Object.isFrozen(data)).toBe(true);
    expect(
      Object.isFrozen(
        typeof data === "object" && data !== null
          ? Reflect.get(data, "seen")
          : undefined,
      ),
    ).toBe(true);
  });

  test("RC03.a changing command keeps transaction proof identity while copying data", async () => {
    const shared = sharedCounter();
    const run = changingHost(stateRoot(), shared);

    const first = envelopeOf(await run(["apply"]));
    expect(first.exitCode).toBe(0);
    expect(first.envelope.result.causeCode).toBe("SUCCESS_COMPLETED");
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(shared.seen)).toBe(false);
    expect(Object.isFrozen(first.envelope.result.data)).toBe(true);

    const second = envelopeOf(await run(["apply"]));
    expect(second.exitCode).toBe(0);
    expect(second.envelope.result.causeCode).toBe("SUCCESS_COMPLETED");
    expect(first.envelope.result.data).toEqual({ seen: [0] });
    expect(second.envelope.result.data).toEqual({ seen: [0, 1] });
  });

  test("RC04.a uncloneable data ends in INTERNAL_RESULT_UNCHANGED fallback", async () => {
    const withFunction = envelopeOf(
      await uncloneableHost(() => "no")(["broken"]),
    );
    expect(withFunction.exitCode).toBe(1);
    expect(withFunction.envelope.result.causeCode).toBe(
      "INTERNAL_RESULT_UNCHANGED",
    );

    const withSymbol = envelopeOf(
      await uncloneableHost(Symbol("no"))(["broken"]),
    );
    expect(withSymbol.exitCode).toBe(1);
    expect(withSymbol.envelope.result.causeCode).toBe(
      "INTERNAL_RESULT_UNCHANGED",
    );
  });
});
