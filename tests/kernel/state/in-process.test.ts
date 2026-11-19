import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { at, json, makeWorld, str, supportingTest } from "./harness.ts";
import type { Json, Observed, World } from "./harness.ts";

const entry = join(import.meta.dir, "fixtures", "in-process-specimen.ts");
const registered: string[] = [];
const ran: string[] = [];

function inProcessCase(title: string, body: () => Promise<void>): void {
  const id = title.split(" ")[0] ?? title;
  registered.push(id);
  supportingTest(title, async () => {
    ran.push(id);
    await body();
  });
}
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
    .cases()
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

function inProcess(
  world: World,
  mode: string,
  extra: Record<string, string> = {},
) {
  return world.start([mode], extra).done;
}

inProcessCase(
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
      expect(world.cases()).toHaveLength(2);
      expect(world.noteLedger("a")).toBe(1);
      expect(world.noteLedger("b")).toBe(1);
    } finally {
      world.dispose();
    }
  },
);

inProcessCase(
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

inProcessCase(
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
      const operations = world.cases();
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

inProcessCase(
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

const heard = [
  ["error", "on-crash", "Planted crash while the second run is in flight."],
  [
    "rejection",
    "on-crash-rejection",
    "Planted rejection while the second run is in flight.",
  ],
] as const;
for (const [cause, mode, message] of heard)
  inProcessCase(
    `IP06.on-crash-hears-${cause} onCrash hears the uncaught ${cause}, then the process exits 1 with nothing printed`,
    async () => {
      const world = makeWorld({ entry });
      try {
        const done = await inProcess(world, mode, { SX_BARRIER: "intent" });
        expect(done.exit).toBe(1);
        expect(done.stdout).toBe("");
        expect(done.stderr).toBe("");
        expect(lines(world).map((line) => line.label)).toEqual([
          "first",
          "held",
          "listener",
        ]);
        expect(labelled(world, "listener")).toBe(message);
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

const reentered = [
  [
    "error",
    "on-crash-reentry",
    "Planted crash while the second run is in flight.",
  ],
  [
    "rejection",
    "on-crash-reentry-rejection",
    "Planted rejection while the second run is in flight.",
  ],
] as const;
for (const [cause, mode, message] of reentered)
  inProcessCase(
    `IP06.on-crash-reentry-${cause} an abort observer and an emergency record that both throw on an uncaught ${cause} still let onCrash hear it, exit 1, and print nothing`,
    async () => {
      const world = makeWorld({ entry });
      try {
        const done = await inProcess(world, mode, {
          SX_BARRIER: "intent",
          SX_FAULT: "abort-observer-throws",
        });
        expect(done.stderr).toBe("");
        expect(done.stdout).toBe("");
        expect(done.exit).toBe(1);
        expect(lines(world).map((line) => line.label)).toEqual([
          "first",
          "held",
          "record",
          "listener",
        ]);
        expect(existsSync(join(world.world, "abort-observer.thrown"))).toBe(
          true,
        );
        expect(labelled(world, "listener")).toBe(message);
        const finishedRun = str(at(labelled(world, "first"), "runId"));
        const finished = operationOf(world, finishedRun);
        const inFlight = world
          .operations()
          .filter((operation) => operation.id !== finished.id);
        expect(emergencies(finished)).toBe(0);
        expect(inFlight.map(emergencies)).toEqual([1]);
        expect(labelled(world, "record")).toBe(
          inFlight[0]?.intent.runId ?? null,
        );
      } finally {
        world.dispose();
      }
    },
  );

test("in-process state cases ran their real bodies on macOS and Linux, and nowhere else claim to", () => {
  const cases = [
    "IP04.sequence-own-operation-and-proof",
    "IP05.overlap-refused-held-lock",
    "IP06.crash-records-only-run-in-flight",
    "IP06.crash-records-every-run-in-flight",
    "IP06.on-crash-hears-error",
    "IP06.on-crash-hears-rejection",
    "IP06.on-crash-reentry-error",
    "IP06.on-crash-reentry-rejection",
  ];
  expect(registered).toEqual(cases);
  const proved = ["darwin", "linux"].includes(process.platform);
  expect(ran).toEqual(proved ? cases : []);
});
