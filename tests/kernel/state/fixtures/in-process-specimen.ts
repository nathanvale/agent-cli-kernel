import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runInProcess } from "../../../../kernel/src/kernel/index.ts";
import {
  approvalAddon,
  barrierReached,
  closeBarrier,
  contract,
  releaseBarrier,
  state,
} from "./specimen.ts";

const mode = process.argv[2] ?? "";
const report = join(process.env.SX_WORLD ?? "", "in-process.jsonl");

const listened = mode.startsWith("on-crash");
const entry = runInProcess(contract, {
  addons: { approval: approvalAddon },
  emergencyRecord: state.emergencyRecord,
  ...(listened && {
    onCrash: (error: unknown) => {
      note("listener", error instanceof Error ? error.message : null);
    },
  }),
});

function apply(name: string, content: string): readonly string[] {
  return ["apply", name, "--content", content, "--json"];
}

function note(label: string, value: unknown): void {
  appendFileSync(report, `${JSON.stringify({ label, value })}\n`);
}

const barrierBound = 30_000;

function reached(name: string): Promise<"reached"> {
  return once(barrierReached, name, {
    signal: AbortSignal.timeout(barrierBound),
  }).then(() => "reached" as const);
}

async function heldAt(
  barrier: Promise<"reached">,
  name: string,
  run: Promise<unknown>,
): Promise<void> {
  const first = await Promise.race([
    barrier,
    run.then(() => "returned" as const),
  ]);
  if (first !== "reached")
    throw new Error(`The run returned before barrier ${name}.`);
}

async function sequence(): Promise<void> {
  note("first", await entry(apply("a", "v1")));
  note("second", await entry(apply("b", "v2")));
}

async function overlap(): Promise<void> {
  const held = reached("intent");
  const first = entry(apply("a", "v1"));
  await heldAt(held, "intent", first);
  note("second", await entry(apply("a", "v2")));
  releaseBarrier("intent");
  note("first", await first);
}

async function crashWhileHeld(plant: () => void): Promise<void> {
  releaseBarrier("intent");
  note("first", await entry(apply("a", "v1")));
  closeBarrier("intent");
  const held = reached("intent");
  const second = entry(apply("b", "v2"));
  await heldAt(held, "intent", second);
  note("held", true);
  setTimeout(plant, 0);
  await second;
}

function crash(): Promise<void> {
  return crashWhileHeld(() => {
    throw new Error("Planted crash while the second run is in flight.");
  });
}

function rejectionHeard(): Promise<void> {
  return crashWhileHeld(() => {
    void Promise.reject(
      new Error("Planted rejection while the second run is in flight."),
    );
  });
}

async function crashBoth(): Promise<void> {
  const firstHeld = reached("intent");
  const first = entry(apply("a", "v1"));
  await heldAt(firstHeld, "intent", first);
  const secondHeld = reached("intent");
  const second = entry(apply("b", "v2"));
  await heldAt(secondHeld, "intent", second);
  note("held", true);
  setTimeout(() => {
    throw new Error("Planted crash while two runs are in flight.");
  }, 0);
  await Promise.all([first, second]);
}

const modes: Readonly<Record<string, () => Promise<void>>> = {
  sequence,
  overlap,
  crash,
  "crash-both": crashBoth,
  "on-crash": crash,
  "on-crash-rejection": rejectionHeard,
};
if (!Object.hasOwn(modes, mode)) throw new Error(`Unknown mode ${mode}.`);
const selected = modes[mode];
if (!selected) throw new Error(`Mode ${mode} has no scenario.`);
await selected();
note("continued", true);
process.exitCode = 7;
