import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { at, json, makeWorld, str, supportingTest } from "./harness.ts";
import type { Json, Observed, World } from "./harness.ts";

const entry = join(import.meta.dir, "fixtures", "in-process-specimen.ts");
const continuedCode = 7;

type Line = { readonly label: string; readonly value: Json };

function lines(world: World): readonly Line[] {
  const file = join(world.world, "in-process.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => {
      const parsed: unknown = JSON.parse(text);
      return {
        label: str(at(json(parsed), "label")),
        value: at(json(parsed), "value") ?? null,
      };
    });
}

function labelled(world: World, label: string): Json {
  const found = lines(world).find((line) => line.label === label);
  if (!found) throw new Error(`The fixture recorded no ${label} line.`);
  return found.value;
}

function operationOf(world: World, runId: string): Observed {
  const matches = world
    .operations()
    .filter((operation) => operation.intent.runId === runId);
  if (matches.length !== 1)
    throw new Error(`Expected one operation for ${runId}.`);
  const [operation] = matches;
  if (!operation) throw new Error(`No operation for ${runId}.`);
  return operation;
}

function emergencies(operation: Observed): number {
  return operation.events.records.filter((entry) => entry.kind === "emergency")
    .length;
}

const childBound = 60_000;

function inProcess(
  world: World,
  mode: string,
  extra: Record<string, string> = {},
) {
  return world.start([mode], extra, childBound).done;
}

supportingTest(
  "IP04.sequence-own-operation-and-proof two runs in one process each publish their own operation",
  async () => {
    const world = makeWorld({ entry });
    try {
      const done = await inProcess(world, "sequence");
      expect(done.stdout).toBe("");
      expect(done.stderr).toBe("");
      expect(done.exit).toBe(continuedCode);
      expect(lines(world).map((line) => line.label)).toEqual([
        "first",
        "second",
        "continued",
      ]);
      const runs = ["first", "second"].map((label) => {
        const value = labelled(world, label);
        expect(at(value, "kind")).toBe("envelope");
        expect(at(value, "exitCode")).toBe(0);
        const result = at(value, "envelope", "result");
        expect(at(result, "causeCode")).toBe("SUCCESS_COMPLETED");
        expect(at(result, "transactionState")).toBe("completed");
        expect(at(result, "effects", "completed")).toEqual(["note.write"]);
        const runId = str(at(value, "runId"));
        expect(at(result, "runId")).toBe(runId);
        expect(at(result, "data", "operationId")).toBe(
          operationOf(world, runId).id,
        );
        return runId;
      });
      expect(new Set(runs).size).toBe(2);
      expect(world.operations()).toHaveLength(2);
      expect(world.noteLedger("a")).toBe(1);
      expect(world.noteLedger("b")).toBe(1);
    } finally {
      world.dispose();
    }
  },
);

supportingTest(
  "IP05.overlap-refused-held-lock a second run in the same process is refused while the first holds its coordination lock",
  async () => {
    const world = makeWorld({ entry });
    try {
      const done = await inProcess(world, "overlap", {
        SX_BARRIER: "intent",
      });
      expect(done.stdout).toBe("");
      expect(done.exit).toBe(continuedCode);
      const second = labelled(world, "second");
      expect(at(second, "kind")).toBe("envelope");
      expect(at(second, "exitCode")).toBe(3);
      expect(at(second, "envelope", "result", "causeCode")).toBe(
        "DOMAIN_SX_LOCK_HELD",
      );
      expect(at(second, "envelope", "result", "transactionState")).toBe(
        "unchanged",
      );
      const first = labelled(world, "first");
      expect(at(first, "envelope", "result", "causeCode")).toBe(
        "SUCCESS_COMPLETED",
      );
      expect(at(first, "runId")).not.toBe(at(second, "runId"));
      expect(world.operations()).toHaveLength(1);
      expect(world.noteLedger("a")).toBe(1);
    } finally {
      world.dispose();
    }
  },
);

supportingTest(
  "IP06.crash-records-only-run-in-flight a crash writes one emergency record, for the run in flight",
  async () => {
    const world = makeWorld({ entry });
    try {
      const done = await inProcess(world, "crash", { SX_BARRIER: "intent" });
      expect(done.exit).toBe(1);
      expect(done.stdout).toBe("");
      expect(done.stderr).toBe("");
      expect(lines(world).map((line) => line.label)).toEqual(["first", "held"]);
      const finishedRun = str(at(labelled(world, "first"), "runId"));
      const finished = operationOf(world, finishedRun);
      const operations = world.operations();
      expect(operations).toHaveLength(2);
      const inFlight = operations.filter(
        (operation) => operation.id !== finished.id,
      );
      expect(inFlight).toHaveLength(1);
      expect(emergencies(finished)).toBe(0);
      expect(inFlight.map(emergencies)).toEqual([1]);
    } finally {
      world.dispose();
    }
  },
);

supportingTest(
  "IP06.crash-records-every-run-in-flight a crash with two runs in flight writes one emergency record for each",
  async () => {
    const world = makeWorld({ entry });
    try {
      const done = await inProcess(world, "crash-both", {
        SX_BARRIER: "intent",
      });
      expect(done.exit).toBe(1);
      expect(done.stdout).toBe("");
      expect(done.stderr).toBe("");
      expect(lines(world).map((line) => line.label)).toEqual(["held"]);
      const operations = world.operations();
      expect(operations).toHaveLength(2);
      expect(
        new Set(operations.map((operation) => operation.intent.runId)).size,
      ).toBe(2);
      expect(operations.map(emergencies)).toEqual([1, 1]);
    } finally {
      world.dispose();
    }
  },
);

supportingTest(
  "IP06.crash-listener-hears-error the listener hears the thrown error, then the process exits 1 with nothing printed",
  async () => {
    const world = makeWorld({ entry });
    try {
      const done = await inProcess(world, "crash-listener", {
        SX_BARRIER: "intent",
      });
      expect(done.exit).toBe(1);
      expect(done.stdout).toBe("");
      expect(done.stderr).toBe("");
      expect(lines(world).map((line) => line.label)).toEqual([
        "first",
        "held",
        "listener",
      ]);
      expect(labelled(world, "listener")).toBe(
        "Planted crash while the second run is in flight.",
      );
      const finishedRun = str(at(labelled(world, "first"), "runId"));
      const finished = operationOf(world, finishedRun);
      const inFlight = world
        .operations()
        .filter((operation) => operation.id !== finished.id);
      expect(emergencies(finished)).toBe(0);
      expect(inFlight.map(emergencies)).toEqual([1]);
    } finally {
      world.dispose();
    }
  },
);
