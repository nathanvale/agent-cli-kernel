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

const entry = runInProcess(contract, {
  addons: { approval: approvalAddon },
  emergencyRecord: state.emergencyRecord,
});

function apply(name: string, content: string): readonly string[] {
  return ["apply", name, "--content", content, "--json"];
}

function note(label: string, value: unknown): void {
  appendFileSync(report, `${JSON.stringify({ label, value })}\n`);
}

async function reached(name: string): Promise<void> {
  await once(barrierReached, name);
}

async function sequence(): Promise<void> {
  note("first", await entry(apply("a", "v1")));
  note("second", await entry(apply("b", "v2")));
}

async function overlap(): Promise<void> {
  const held = reached("intent");
  const first = entry(apply("a", "v1"));
  await held;
  note("second", await entry(apply("a", "v2")));
  releaseBarrier("intent");
  note("first", await first);
}

async function crash(): Promise<void> {
  releaseBarrier("intent");
  note("first", await entry(apply("a", "v1")));
  closeBarrier("intent");
  const held = reached("intent");
  const second = entry(apply("b", "v2"));
  await held;
  note("held", true);
  setTimeout(() => {
    throw new Error("Planted crash while the second run is in flight.");
  }, 0);
  await second;
}

const modes: Readonly<Record<string, () => Promise<void>>> = {
  sequence,
  overlap,
  crash,
};
const selected = modes[mode];
if (!selected) throw new Error(`Unknown mode ${mode}.`);
await selected();
note("continued", true);
process.exitCode = 7;
