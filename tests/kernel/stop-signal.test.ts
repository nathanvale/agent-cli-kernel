import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { CauseTable } from "../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../kernel/src/addons/state/index.ts";
import { testFolder } from "../support/test-folder.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const causes = {
  DOMAIN_SG_LOCK_HELD: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_SG_UNRESOLVED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
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
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Coordination refused.",
    inspect: [{ kind: "command", command: "sg.pending", args: [] }],
  },
} as const;

type Execute = (
  context: unknown,
  runId: string,
) => Promise<{ readonly ok: boolean }>;

function inspectRoute(seen: unknown[]): Execute {
  const read = command({
    identity: "sg.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) => {
      seen.push(context.signal);
      return context.result(
        { commandIdentity: "sg.read", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      );
    },
  });
  const contract = contractFor({ cli: "sg", commands: [read] });
  return (context, runId) => contract.execute("sg.read", [], runId, context);
}

function changingRoute(seen: unknown[]): Execute {
  const base = testFolder("c3-stop-signal-");
  temporaryRoots.push(base);
  const state = stateAddon({ root: join(base, "state"), report: "sg.pending" });
  const pending = command({
    identity: "sg.pending",
    route: ["pending"],
    summary: "Report unfinished work.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...words,
        commandIdentity: "sg.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: {
          next: { kind: "instruction", text: "Inspect listed cases." },
        },
        independentObservable: "sg.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "sg.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
  const change = changing({
    identity: "sg.change",
    route: ["change"],
    summary: "Enter one changing handler.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: ["e.one"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SG_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SG_UNRESOLVED",
    stations: [
      station(allCauses, {
        ...words,
        commandIdentity: "sg.change",
        causeCode: "DOMAIN_SG_LOCK_HELD",
        trigger: "Coordination refused.",
        repairAction: "Inspect the unfinished report.",
        guidance: handoff,
        independentObservable: "sg.change:held",
      }),
      station(allCauses, {
        ...words,
        commandIdentity: "sg.change",
        causeCode: "DOMAIN_SG_UNRESOLVED",
        trigger: "Coordination refused.",
        repairAction: "Inspect the unfinished report.",
        guidance: handoff,
        independentObservable: "sg.change:unresolved",
      }),
    ],
    run: (_input, context) => {
      seen.push(context.signal);
      return Promise.resolve(
        context.result(
          { commandIdentity: "sg.change", causeCode: "DOMAIN_SG_LOCK_HELD" },
          { message: "Entered.", data: null, effects: unchanged },
        ),
      );
    },
  });
  const contract = contractFor({
    cli: "sg",
    commands: [change, pending],
    state: state.descriptor,
    causes,
    installedAddons: ["state"],
  });
  return (context, runId) => contract.execute("sg.change", [], runId, context);
}

const routes = [
  {
    name: "command()",
    build: inspectRoute,
    refusal: "undeclared or unavailable capability",
  },
  { name: "changing()", build: changingRoute, refusal: "state unavailable" },
] as const;

for (const route of routes) {
  test(`${route.name}: a handler entered with no stop source holds a signal that has not aborted`, async () => {
    const seen: unknown[] = [];
    const executed = await route.build(seen)({}, "run-idle");
    expect(executed.ok).toBe(true);
    const [signal, ...rest] = seen;
    expect(rest).toEqual([]);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal instanceof AbortSignal ? signal.aborted : "absent").toBe(
      false,
    );
  });

  test(`${route.name}: a handler holds the very stop signal its run supplied`, async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const executed = await route.build(seen)(
      { signal: controller.signal },
      "run-supplied",
    );
    expect(executed.ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(controller.signal);
  });

  test(`${route.name}: a context signal that is not a stop signal is refused before the handler`, async () => {
    const seen: unknown[] = [];
    const executed = await route.build(seen)(
      { signal: { aborted: false, addEventListener: () => undefined } },
      "run-lookalike",
    );
    expect(executed).toMatchObject({
      ok: false,
      path: "capabilities",
      reason: route.refusal,
    });
    expect(seen).toEqual([]);
  });
}
