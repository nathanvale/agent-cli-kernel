import type { CommandResult } from "../../kernel/src/kernel/index.ts";
import { expect, test } from "bun:test";
import { contractFor, command } from "../../kernel/src/kernel/index.ts";
import type { EffectTransaction } from "../../kernel/src/kernel/index.ts";
import {
  attachState,
  attachedRunCount,
  createStateAddon,
  forgetRun,
  issuedProof,
  knownProof,
} from "../../kernel/src/kernel/state-seam.ts";
import { deferred, until } from "./lifecycle/recording-host.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";

test("a declared installed name or arbitrary host callback cannot acquire the state issuer", () => {
  let called = false;
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "specimen",
        installedAddons: ["state"],
        commands() {
          called = true;
          return [];
        },
      },
    ]);
  }).toThrow("Host callbacks never receive a state issuer");
  expect(called).toBe(false);
  expect(() =>
    contractFor({ cli: "specimen", installedAddons: ["state"], commands: [] }),
  ).toThrow("descriptor created by contractFor.stateAddon");
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "specimen",
        installedAddons: ["state"],
        state: { name: "state" },
        commands: [],
      },
    ]);
  }).toThrow("descriptor created by contractFor.stateAddon");
});

test("a handler cannot return a cloned result or a prior invocation with reused run text", async () => {
  let previous: CommandResult<"specimen.read"> | undefined;
  let copy = false;
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) => {
      if (previous) return copy ? { ...previous } : previous;
      const result = context.result(
        { commandIdentity: "specimen.read", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: unchanged,
        },
      );
      previous = result;
      return result;
    },
  });
  const contract = contractFor({ cli: "specimen", commands: [read] });
  const first = await contract.execute("specimen.read", [], "same-text");
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("Expected initial handler result.");
  const other = contractFor({ cli: "specimen", commands: [read] });
  expect(await other.buildResult(first.value)).toMatchObject({
    ok: false,
    path: "result",
  });
  expect((await contract.buildResult(first.value)).ok).toBe(true);
  expect(
    await contract.execute("specimen.read", [], "same-text"),
  ).toMatchObject({ ok: false, path: "result" });
  copy = true;
  expect(
    await contract.execute("specimen.read", [], "same-text"),
  ).toMatchObject({ ok: false, path: "result" });
});

function recordingState() {
  const descriptor = createStateAddon((issuer) => ({
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: "specimen.pending",
      args: [],
    }),
    attach: (runId) => ({
      transaction: async (work) => {
        await work({
          record: (effect, operation) =>
            operation(
              issuer.recordedEffect(runId, effect, (_runId, _effect, begin) =>
                begin(),
              ),
            ),
        });
        throw new Error("The test transaction proves nothing.");
      },
    }),
  }));
  const attached = attachState(descriptor, "run-1", ["specimen.note"]);
  if (!attached) throw new Error("The state did not attach.");
  return { descriptor, attached };
}

function messageOf(settled: Promise<unknown>): Promise<string> {
  return settled.then(
    () => "recorded",
    (error: unknown) =>
      error instanceof Error ? error.message : "not an Error",
  );
}

const note = () => Promise.resolve("noted");
const confirmed = () => Promise.resolve(true);

test("a transaction still open after its handler returns cannot record an effect, and its identity stays taken", async () => {
  const { descriptor, attached } = recordingState();
  const open = deferred();
  const recorded = attached.capability.transaction(async (transaction) => {
    await open.promise;
    await transaction.record("specimen.note", note, confirmed);
  });
  attached.close();
  forgetRun("run-1", descriptor);
  expect(attachState(descriptor, "run-1", ["specimen.note"])).toBeUndefined();
  open.resolve();
  expect(await messageOf(recorded)).toBe(
    "The state capability closed when the handler returned.",
  );
});

async function keptRecord(
  attached: ReturnType<typeof recordingState>["attached"],
): Promise<EffectTransaction<"specimen.note">> {
  let kept: EffectTransaction<"specimen.note"> | undefined;
  expect(
    await messageOf(
      attached.capability.transaction((transaction) => {
        kept = transaction;
        return Promise.resolve();
      }),
    ),
  ).toBe("The test transaction proves nothing.");
  if (!kept) throw new Error("The transaction kept no record.");
  return kept;
}

function outsideTheRun(transaction: EffectTransaction<"specimen.note">) {
  return messageOf(
    Promise.resolve().then(() =>
      transaction.record("specimen.note", note, confirmed),
    ),
  );
}

const outsideRefusal = "A recorded effect requires the active attached run.";

test("a record inside its open run's transaction records its effect", async () => {
  const { attached } = recordingState();
  const recorded: string[] = [];
  await messageOf(
    attached.capability.transaction(async (transaction) => {
      recorded.push(await transaction.record("specimen.note", note, confirmed));
    }),
  );
  expect(recorded).toEqual(["noted"]);
});

test("a record kept past its forgotten run and called outside the run cannot record an effect", async () => {
  const { descriptor, attached } = recordingState();
  const kept = await keptRecord(attached);
  attached.close();
  forgetRun("run-1", descriptor);
  expect(await outsideTheRun(kept)).toBe(outsideRefusal);
});

test("a record kept past its forgotten run cannot record under the run that reused its identity", async () => {
  const { descriptor, attached } = recordingState();
  const kept = await keptRecord(attached);
  attached.close();
  forgetRun("run-1", descriptor);
  expect(attachState(descriptor, "run-1", ["specimen.note"])).toBeDefined();
  expect(await outsideTheRun(kept)).toBe(outsideRefusal);
});

test("a record called outside its run's transaction cannot record an effect, even while the run is open", async () => {
  const { attached } = recordingState();
  const kept = await keptRecord(attached);
  expect(await outsideTheRun(kept)).toBe(outsideRefusal);
});

test("a refused reuse keeps the live run's proof as its trusted summary but refuses it as a result", async () => {
  const descriptor = createStateAddon((issuer) => ({
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: "specimen.pending",
      args: [],
    }),
    attach: (runId) => ({
      transaction: async (work) => {
        await work({
          record: () => Promise.reject(new Error("Not recorded here.")),
        });
        return issuer.transactionProof(runId, {
          transactionState: "unchanged",
          effects: unchanged,
        });
      },
    }),
  }));
  const attached = attachState(descriptor, "run-1", ["specimen.note"]);
  if (!attached) throw new Error("The state did not attach.");
  const proof = await attached.capability.transaction(() => Promise.resolve());
  expect(issuedProof("run-1", descriptor)).toBe(proof);
  expect(knownProof(proof, "run-1", descriptor)).toBe(true);
  expect(attachState(descriptor, "run-1", ["specimen.note"])).toBeUndefined();
  expect(issuedProof("run-1", descriptor)).toBe(proof);
  expect(knownProof(proof, "run-1", descriptor)).toBe(false);
});

test("a run whose transaction is still running stays live after its handler returns, so no other run can take its identity", async () => {
  const { descriptor, attached } = recordingState();
  const open = deferred();
  const kept: EffectTransaction<"specimen.note">[] = [];
  const running = attached.capability.transaction(async (transaction) => {
    kept.push(transaction);
    await open.promise;
  });
  attached.close();
  forgetRun("run-1", descriptor);
  expect(attachedRunCount(descriptor)).toBe(1);
  expect(attachState(descriptor, "run-1", ["specimen.note"])).toBeUndefined();
  open.resolve();
  expect(await messageOf(running)).toBe("The test transaction proves nothing.");
  expect(await until(() => attachedRunCount(descriptor) === 0)).toBe(true);
  expect(attachState(descriptor, "run-1", ["specimen.note"])).toBeDefined();
});
