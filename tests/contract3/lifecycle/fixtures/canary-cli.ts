import { appendFileSync } from "node:fs";
import {
  command,
  commonCauses,
  contractFor,
  runProcess,
  station,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { programsAddon } from "../../../../starters/contract3/src/addons/programs/index.ts";

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const read = command({
  identity: "canary.read",
  route: ["read"],
  summary: "Read canary data.",
  input: none,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "canary.read", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read canary data.", data: { canary: true }, effects: empty },
    ),
});

const refusal = station(commonCauses, {
  commandIdentity: "canary.refuse",
  causeCode: "DOMAIN_PRECONDITION_UNMET",
  trigger: "The canary precondition is unmet.",
  repairAction: "Repair the canary precondition.",
  guidance: { next: { kind: "instruction", text: "Repair the canary." } },
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "canary:refuse",
});
const refuse = command({
  identity: "canary.refuse",
  route: ["refuse"],
  summary: "Refuse on the canary precondition.",
  input: none,
  capabilities: {},
  stations: [refusal],
  run: (_input, context) =>
    context.result(refusal, {
      message: "The canary precondition is unmet.",
      data: null,
      effects: empty,
    }),
});

const wait = command({
  identity: "canary.wait",
  route: ["wait"],
  summary: "Wait on one canary program.",
  input: none,
  capabilities: { programs: true },
  run: async (_input, context) => {
    await context.programs.inspect({
      executable: canary.boundary.path("/bin/sh"),
      args: [
        "-c",
        'echo "child-started $$" >> "$FX_LEDGER"; exec /bin/sleep 30',
      ],
      timeoutMilliseconds: 60_000,
      outputLimitBytes: 1024,
      shutdownMilliseconds: 200,
    });
    appendFileSync(process.env.FX_LEDGER ?? "/dev/null", "program-returned\n");
    return context.result(
      { commandIdentity: "canary.wait", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The canary program finished.", data: null, effects: empty },
    );
  },
});

const canary = contractFor({
  cli: "canary",
  commands: [read, refuse, wait],
  installedAddons: ["programs"],
});

await runProcess(canary, { addons: { programs: programsAddon() } })(
  process.argv.slice(2),
);
