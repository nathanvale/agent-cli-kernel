import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";

// Accepted decision "Contract question 7 of 8" (ledger OP-55): a handler
// may not select the stations that belong before handler entry. Built to
// the coordinator's provisional readings N5 (a) (a command may still
// declare a pre-entry tuple for its words; that grants no selection) and
// N6 (a) (on a command that declares approval a handler may select
// DOMAIN_AUTHORITY_REQUIRED for the denial at revalidation; a command
// without approval may not). DISC-11b, CMD-9 steps 3 to 5, WIRE-16, LIFE-7,
// LIFE-9, CMD-8. Expected values come from expectations.md (KF5).
let entry = "";
beforeAll(async () => {
  entry = await materialiseKf();
});
afterAll(async () => {
  await rm(join(dirname(entry), "../../../.."), {
    recursive: true,
    force: true,
  });
});

const preEntry = [
  ["usage", "USAGE_INVALID_INVOCATION", ["load", "--json"]],
  [
    "before-start",
    "DOMAIN_DEADLINE_BEFORE_START",
    ["load", "--deadline-ms", "60000", "--json"],
  ],
  // N6 (a): kf.load declares no approval.
  ["authority-no-approval", "DOMAIN_AUTHORITY_REQUIRED", ["load", "--json"]],
] as const;

describe("KF5.a handler-selects-base-only-station", () => {
  for (const [variant, causeCode, argv] of preEntry)
    for (const declared of [false, true])
      test(
        `KF5.a ${variant} ${declared ? "declared" : "undeclared"}: the selection never builds and the fallback prints`,
        async () => {
          const run = await runKf(entry, "load", argv, {
            KF_SELECT: causeCode,
            KF_DECLARED: declared ? causeCode : "",
          });
          expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
            exit: 1,
            one: true,
          });
          expect(run.result).toMatchObject({
            commandIdentity: "kf.load",
            causeCode: "INTERNAL_RESULT_UNCHANGED",
            outcome: "failed",
            transactionState: "unchanged",
            failureClass: "internal",
            exitCode: 1,
            effects: emptyComplete,
          });
          expect(run.result).toHaveProperty("handoff");
          expect(run.ledger).toEqual(["handler-entered"]);
        },
        processWatchdog(1),
      );
  test(
    "KF5.a twins: SCHEMA_INVALID_INPUT stays selectable; the base still refuses usage before entry",
    async () => {
      const schema = await runKf(entry, "load", ["load", "--json"], {
        KF_SELECT: "SCHEMA_INVALID_INPUT",
      });
      expect(schema.exit).toBe(4);
      expect(schema.result).toMatchObject({
        causeCode: "SCHEMA_INVALID_INPUT",
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "schema",
      });
      const usage = await runKf(entry, "load", ["load", "--bogus", "--json"]);
      expect({ exit: usage.exit, one: oneEnvelope(usage) }).toEqual({
        exit: 2,
        one: true,
      });
      expect(usage.result?.causeCode).toBe("USAGE_INVALID_INVOCATION");
      expect(usage.ledger).not.toContain("handler-entered");
      // The base twin for DOMAIN_DEADLINE_BEFORE_START (a deadline already
      // passed at CMD-9 step 4, no handler entry) is the existing process
      // control DS05.pre-dispatch-results-carry-no-key deadline-before-start.
      // The N6 (a) twin on a command that declares approval (a revalidation
      // denial the handler selects prints) is the frozen T3 case
      // S02.a-denial-under-coordination.
    },
    processWatchdog(2),
  );
});

test(
  "KF5.c declared-tuple-words-still-apply: a base usage refusal carries the command's declared words",
  async () => {
    const run = await runKf(entry, "load", ["load", "--bogus", "--json"], {
      KF_DECLARED: "USAGE_INVALID_INVOCATION",
    });
    expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
      exit: 2,
      one: true,
    });
    expect(run.result).toMatchObject({
      causeCode: "USAGE_INVALID_INVOCATION",
      next: {
        kind: "instruction",
        text: "kf.load's own words for USAGE_INVALID_INVOCATION.",
      },
      repairAction: "Repair as kf.load says for USAGE_INVALID_INVOCATION.",
    });
  },
  processWatchdog(1),
);

// KF5.b (CMD-8): the handler context is typed from the declaration, so a
// typed handler cannot select a pre-entry station even when the command
// declares its words; SCHEMA_INVALID_INPUT still type-checks. Native
// TypeScript 7, as the kernel-repair compiler locks run it.
const root = resolve(import.meta.dir, "../../..");
let probes = "";
beforeAll(async () => {
  probes = await mkdtemp(join(tmpdir(), "contract3-kf5-"));
  await mkdir(join(probes, "locks"));
  await symlink(join(root, "node_modules"), join(probes, "node_modules"));
  await writeFile(
    join(probes, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      include: [],
      files: ["locks/probe.ts"],
    }),
  );
});
afterAll(async () => {
  await rm(probes, { recursive: true, force: true });
});
function probe(causeCode: string): string {
  const kernel = join(root, "starters/contract3/src/kernel/index.ts");
  const tuple = (code: string) => `station(commonCauses, {
    commandIdentity: "kf.load",
    causeCode: "${code}",
    trigger: "Declared words.",
    guidance: { next: { kind: "instruction", text: "Own words." } },
    repairAction: "Repair.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "kf.load:${code}",
  })`;
  return `import { command, commonCauses, station } from ${JSON.stringify(kernel)};
export const load = command({
  identity: "kf.load",
  route: ["load"],
  summary: "Load.",
  input: {
    arguments: [{ name: "item", summary: "Item.", required: false, value: { kind: "string", minLength: 1, maxLength: 9, choices: null, pattern: null } }],
    options: [],
    constraints: [],
    deadlineSupported: true,
    additionalArguments: false,
    additionalOptions: false,
  },
  capabilities: {},
  stations: [${["USAGE_INVALID_INVOCATION", "DOMAIN_DEADLINE_BEFORE_START", "SCHEMA_INVALID_INPUT"].map(tuple).join(", ")}],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "kf.load", causeCode: "${causeCode}" },
      { message: "Selected.", data: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } },
    ),
});
`;
}
async function diagnostics(causeCode: string): Promise<string> {
  await writeFile(join(probes, "locks/probe.ts"), probe(causeCode));
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules/@typescript/native/bin/tsc"),
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(probes, "tsconfig.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return stdout + stderr;
}
test("KF5.b handler-type-excludes-base-only-station", async () => {
  // Twin first: the probe itself compiles with a selectable cause.
  expect(await diagnostics("SCHEMA_INVALID_INPUT")).toBe("");
  for (const causeCode of [
    "USAGE_INVALID_INVOCATION",
    "DOMAIN_DEADLINE_BEFORE_START",
  ]) {
    const output = await diagnostics(causeCode);
    // Exactly one diagnostic, on the probe's selection line.
    const line =
      probe(causeCode)
        .split("\n")
        .findIndex((text) =>
          text.includes(
            `{ commandIdentity: "kf.load", causeCode: "${causeCode}" }`,
          ),
        ) + 1;
    expect(line).toBeGreaterThan(0);
    expect(output.match(/error TS\d+/g)?.length).toBe(1);
    expect(output).toContain(`locks/probe.ts(${line},`);
  }
}, 60_000);
