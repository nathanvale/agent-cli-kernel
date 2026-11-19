import {
  command,
  contractFor,
  runInProcess,
} from "../../../../kernel/src/kernel/index.ts";
import { diagnosticsAddon } from "../../../../kernel/src/addons/diagnostics/index.ts";
import { empty, none } from "./declarations.ts";

type Hold = { readonly entered: () => void; readonly released: Promise<void> };
const holds: Hold[] = [];

function hold() {
  let entered = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  holds.push({ entered, released });
  return { reached, release };
}

const read = command({
  identity: "dxs.read",
  route: ["read"],
  summary: "Write two log lines with another in-process run in between.",
  input: none,
  capabilities: { diagnostics: true },
  run: async (_input, context) => {
    const held = holds.shift();
    if (!held) throw new Error("A run entered its handler with no hold.");
    context.diagnostics.record("opened", { step: 1 });
    held.entered();
    await held.released;
    context.diagnostics.record("continued", { step: 2 });
    return context.result(
      { commandIdentity: "dxs.read", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read specimen data.", data: { read: true }, effects: empty },
    );
  },
});

const entry = runInProcess(
  contractFor({
    cli: "dxs",
    commands: [read],
    installedAddons: ["diagnostics"],
  }),
  {
    addons: {
      diagnostics: diagnosticsAddon({ cli: "dxs", environment: process.env }),
    },
  },
);

async function entered(
  reached: Promise<void>,
  run: Promise<unknown>,
): Promise<void> {
  const first = await Promise.race([
    reached.then(() => "entered" as const),
    run.then(() => "returned" as const),
  ]);
  if (first !== "entered")
    throw new Error("A run returned before its handler was held.");
}

const first = hold();
const firstRun = entry(["read", "--json"]);
await entered(first.reached, firstRun);
const second = hold();
const secondRun = entry(["read", "--json"]);
await entered(second.reached, secondRun);
first.release();
const firstResult = await firstRun;
second.release();
const secondResult = await secondRun;
process.stdout.write(
  `${JSON.stringify({ runs: [firstResult, secondResult] })}\n`,
);
