import {
  appendFileSync,
  existsSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runInProcess } from "../../../../kernel/src/kernel/index.ts";
import { approvalAddon, contract, state } from "./specimen.ts";

const mode = process.argv[2] ?? "";
const world = process.env.SX_WORLD ?? "";
const barrierDirectory = process.env.SX_BARRIER_DIR ?? "";
const report = join(world, "in-process.jsonl");

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

function reached(name: string): Promise<void> {
  const file = join(barrierDirectory, `${name}.reached`);
  return new Promise((resolve, reject) => {
    const watcher = watch(barrierDirectory);
    const bound = setTimeout(() => {
      watcher.close();
      reject(new Error(`Barrier ${name} never reached.`));
    }, 60_000);
    const check = () => {
      if (!existsSync(file)) return;
      clearTimeout(bound);
      watcher.close();
      rmSync(file);
      resolve();
    };
    watcher.on("change", check);
    check();
  });
}

function release(name: string): void {
  writeFileSync(join(barrierDirectory, `${name}.release`), "go\n");
}

async function sequence(): Promise<void> {
  note("first", await entry(apply("a", "v1")));
  note("second", await entry(apply("b", "v2")));
}

async function overlap(): Promise<void> {
  const first = entry(apply("a", "v1"));
  await reached("intent");
  note("second", await entry(apply("a", "v2")));
  release("intent");
  note("first", await first);
}

async function crash(): Promise<void> {
  release("intent");
  note("first", await entry(apply("a", "v1")));
  await reached("intent");
  rmSync(join(barrierDirectory, "intent.release"));
  const second = entry(apply("b", "v2"));
  await reached("intent");
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
