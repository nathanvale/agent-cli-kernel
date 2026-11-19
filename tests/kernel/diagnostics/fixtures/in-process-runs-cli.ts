import {
  command,
  contractFor,
  runInProcess,
} from "../../../../kernel/src/kernel/index.ts";
import { diagnosticsAddon } from "../../../../kernel/src/addons/diagnostics/index.ts";
import { empty, none } from "./declarations.ts";

type Hold = { readonly arrive: () => void; readonly released: Promise<void> };
const holds: Hold[] = [];

function hold() {
  const arrival = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  holds.push({ arrive: arrival.resolve, released: release.promise });
  return { arrived: arrival.promise, release: release.resolve };
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
    held.arrive();
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

const holdBound = 10_000;

async function untilHeld(
  name: string,
  arrived: Promise<void>,
  run: Promise<unknown>,
): Promise<void> {
  const expiry = AbortSignal.timeout(holdBound);
  const expired = new Promise<"expired">((resolve) => {
    expiry.addEventListener("abort", () => resolve("expired"));
  });
  const settled = await Promise.race([
    arrived.then(() => "held" as const),
    run.then(() => "returned" as const),
    expired,
  ]);
  if (settled === "returned")
    throw new Error(`The ${name} run returned before its handler was held.`);
  if (settled === "expired")
    throw new Error(
      `The ${name} run's handler was not held within ${holdBound} ms.`,
    );
}

const first = hold();
const firstRun = entry(["read", "--json"]);
await untilHeld("first", first.arrived, firstRun);
const second = hold();
const secondRun = entry(["read", "--json"]);
await untilHeld("second", second.arrived, secondRun);
first.release();
const firstResult = await firstRun;
second.release();
const secondResult = await secondRun;
process.stdout.write(
  `${JSON.stringify({ runs: [firstResult, secondResult] })}\n`,
);
