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
  ["authority-no-approval", "DOMAIN_AUTHORITY_REQUIRED", ["load", "--json"]],
  [
    "deadline-unchanged",
    "DOMAIN_DEADLINE_UNCHANGED",
    ["load", "--deadline-ms", "60000", "--json"],
  ],
] as const;

describe("KF5.a handler-selects-base-only-station", () => {
  for (const [variant, causeCode, argv] of preEntry)
    for (const declared of variant === "authority-no-approval"
      ? [true]
      : [false, true])
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
    },
    processWatchdog(2),
  );
});

describe("KF5.a setup B: kf.apply2", () => {
  for (const causeCode of [
    "DOMAIN_DEADLINE_UNCHANGED",
    "DOMAIN_DEADLINE_COMPLETED",
    "DOMAIN_DEADLINE_PARTIAL",
    "DOMAIN_DEADLINE_UNKNOWN",
    "USAGE_INVALID_INVOCATION",
    "DOMAIN_DEADLINE_BEFORE_START",
  ])
    test(
      `KF5.a apply2 ${causeCode}: never emitted`,
      async () => {
        const run = await runKf(
          entry,
          "apply2",
          ["apply2", "--deadline-ms", "60000", "--json"],
          { KF_SELECT: causeCode },
        );
        expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
          exit: 1,
          one: true,
        });
        expect(run.result).toMatchObject({
          commandIdentity: "kf.apply2",
          causeCode: "INTERNAL_RESULT_UNKNOWN",
          outcome: "failed",
          transactionState: "unknown",
          effects: { ...emptyComplete, inventoryComplete: false },
          handoff: {
            inspect: [{ kind: "command", command: "kf.pending", args: [] }],
          },
        });
        expect(run.ledger).toEqual(["attach state", "handler-entered"]);
      },
      processWatchdog(1),
    );
  test(
    "KF5.a apply2 authority-no-approval declared: never emitted",
    async () => {
      const run = await runKf(entry, "apply2", ["apply2", "--json"], {
        KF_SELECT: "DOMAIN_AUTHORITY_REQUIRED",
        KF_DECLARED: "DOMAIN_AUTHORITY_REQUIRED",
      });
      expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
        exit: 1,
        one: true,
      });
      expect(run.result).toMatchObject({
        commandIdentity: "kf.apply2",
        causeCode: "INTERNAL_RESULT_UNKNOWN",
        transactionState: "unknown",
        effects: { ...emptyComplete, inventoryComplete: false },
      });
      const twin = await runKf(entry, "apply2", ["apply2", "--json"], {
        KF_SELECT: "KF_HELD",
        KF_DECLARED: "DOMAIN_AUTHORITY_REQUIRED",
      });
      expect(twin.exit).toBe(3);
      expect(twin.result).toMatchObject({
        causeCode: "KF_HELD",
        outcome: "refused",
      });
    },
    processWatchdog(2),
  );
  test(
    "KF5.a apply2 twin: the kernel still produces its own deadline result",
    async () => {
      const run = await runKf(
        entry,
        "apply2",
        ["apply2", "--deadline-ms", "300", "--json"],
        { KF_WAIT: "2000" },
      );
      expect(run.exit).toBe(3);
      expect(run.result).toMatchObject({
        causeCode: "DOMAIN_DEADLINE_UNCHANGED",
        effects: { ...emptyComplete, remaining: ["kf.e1", "kf.e2"] },
      });
    },
    processWatchdog(1),
  );
});

describe("KF5.a setup B with an issued proof", () => {
  const proofCases = [
    [
      "completed",
      "DOMAIN_DEADLINE_COMPLETED",
      "INTERNAL_RESULT_COMPLETED",
      "completed",
      { ...emptyComplete, completed: ["kf.e"] },
      0,
    ],
    [
      "partial",
      "DOMAIN_DEADLINE_PARTIAL",
      "INTERNAL_RESULT_PARTIAL",
      "partially-completed",
      { ...emptyComplete, completed: ["kf.e1"], remaining: ["kf.e2"] },
      3,
    ],
    [
      "unknown",
      "DOMAIN_DEADLINE_UNKNOWN",
      "INTERNAL_RESULT_UNKNOWN",
      "unknown",
      { ...emptyComplete, uncertain: ["kf.e"] },
      undefined,
    ],
  ] as const;
  for (const [proof, select, fallback, state, effects, twinExit] of proofCases)
    test(
      `KF5.a apply ${select} with an issued ${proof} proof: never emitted`,
      async () => {
        const run = await runKf(entry, "proof", ["apply", "--json"], {
          KF_PROOF: proof,
          KF_AFTER: "select",
          KF_SELECT: select,
        });
        expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
          exit: 1,
          one: true,
        });
        expect(run.result).toMatchObject({
          commandIdentity: "kf.apply",
          causeCode: fallback,
          outcome: "failed",
          transactionState: state,
          failureClass: "internal",
          effects,
        });
        expect(run.ledger).toContain(`proof ${state}`);
        if (twinExit === undefined) return;
        const twin = await runKf(entry, "proof", ["apply", "--json"], {
          KF_PROOF: proof,
          KF_AFTER: "result",
        });
        expect(twin.exit).toBe(twinExit);
      },
      processWatchdog(2),
    );
});

test(
  "KF5.c deadline words: a kernel deadline result carries the command's declared words",
  async () => {
    const run = await runKf(
      entry,
      "load",
      ["load", "--deadline-ms", "100", "--json"],
      { KF_DECLARED: "DOMAIN_DEADLINE_UNCHANGED", KF_WAIT: "2000" },
    );
    expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
      exit: 3,
      one: true,
    });
    expect(run.result).toMatchObject({
      causeCode: "DOMAIN_DEADLINE_UNCHANGED",
      next: {
        kind: "instruction",
        text: "kf.load's own words for DOMAIN_DEADLINE_UNCHANGED.",
      },
      repairAction: "Repair as kf.load says for DOMAIN_DEADLINE_UNCHANGED.",
    });
  },
  processWatchdog(1),
);

test(
  "KF5.d handler-selects-program-stop-station",
  async () => {
    const run = await runKf(
      entry,
      "watch",
      ["watch", "--deadline-ms", "60000", "--json"],
      { KF_SELECT: "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED" },
    );
    expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
      exit: 1,
      one: true,
    });
    expect(run.result).toMatchObject({
      commandIdentity: "kf.watch",
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      outcome: "failed",
      transactionState: "unchanged",
      failureClass: "internal",
      exitCode: 1,
      effects: emptyComplete,
    });
    expect(run.result).toHaveProperty("handoff");
    expect(run.ledger).toEqual(["handler-entered"]);
    const twin = await runKf(
      entry,
      "watch",
      ["watch", "--deadline-ms", "60000", "--json"],
      { KF_SELECT: "DOMAIN_KF_WATCH_REFUSED" },
    );
    expect(twin.exit).toBe(3);
    expect(twin.result).toMatchObject({
      causeCode: "DOMAIN_KF_WATCH_REFUSED",
      outcome: "refused",
      transactionState: "unchanged",
    });
  },
  processWatchdog(2),
);

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

const root = resolve(import.meta.dir, "../../..");
const kernelDir = join(root, "kernel/src/kernel");
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
type Probe = {
  readonly select: string;
  readonly declared: readonly string[];
  readonly approval?: boolean;
  readonly programStop?: boolean;
};
function selectionLine(select: string): string {
  return `{ commandIdentity: "kf.load", causeCode: "${select}" }`;
}
const handoffArm = [
  "DOMAIN_AUTHORITY_REQUIRED",
  "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
  "DOMAIN_KF_WATCH_REFUSED",
  "DOMAIN_DEADLINE_COMPLETED",
  "DOMAIN_DEADLINE_PARTIAL",
  "DOMAIN_DEADLINE_UNKNOWN",
];
function probe(spec: Probe): string {
  const guidance = (code: string) =>
    handoffArm.includes(code)
      ? `{ handoff: { owner: "operator", reason: "Own words.", inspect: [{ kind: "instruction", text: "Inspect." }] } }`
      : `{ next: { kind: "instruction", text: "Own words." } }`;
  const tuple = (code: string) =>
    code === "SUCCESS_UNCHANGED"
      ? `station(causes, { commandIdentity: "kf.load", causeCode: "SUCCESS_UNCHANGED", trigger: "Loaded.", guidance: { next: { kind: "done" } }, repairAction: null, retryDelayPolicy: { kind: "none" }, reachability: "required", unreachableRationale: null, independentObservable: "kf.load:done" })`
      : `station(causes, { commandIdentity: "kf.load", causeCode: "${code}", trigger: "Declared words.", guidance: ${guidance(code)}, repairAction: "Repair.", retryDelayPolicy: { kind: "none" }, reachability: "required", unreachableRationale: null, independentObservable: "kf.load:${code}" })`;
  const capabilities = [
    ...(spec.approval ? ["approval: true"] : []),
    ...(spec.programStop ? ["programs: true"] : []),
  ].join(", ");
  return [
    `import { command, commonCauses, station } from ${JSON.stringify(join(kernelDir, "index.ts"))};`,
    `import { authority, resource } from ${JSON.stringify(join(kernelDir, "validation/brands.ts"))};`,
    `const row = { outcome: "failed", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "handoff" } as const;`,
    `const causes = { ...commonCauses, DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED: row, DOMAIN_KF_WATCH_REFUSED: { ...row, outcome: "refused" } } as const;`,
    "void authority; void resource;",
    "export const load = command({",
    `  identity: "kf.load", route: ["load"], summary: "Load.",`,
    `  input: { arguments: [{ name: "item", summary: "Item.", required: false, value: { kind: "string", minLength: 1, maxLength: 9, choices: null, pattern: null } }], options: [], constraints: [], deadlineSupported: true, additionalArguments: false, additionalOptions: false },`,
    `  capabilities: { ${capabilities} },`,
    spec.approval
      ? `  approval: () => ({ authority: authority("kf.owner"), resource: resource("kf.item"), resourceRevision: "1", effects: [], preview: "p" }),`
      : "",
    spec.programStop
      ? `  programStopCause: "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED",`
      : "",
    `  stations: [${spec.declared.map(tuple).join(", ")}],`,
    "  run: (_input, context) =>",
    "    context.result(",
    `      ${selectionLine(spec.select)},`,
    `      { message: "Selected.", data: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } },`,
    "    ),",
    "});",
    "",
  ].join("\n");
}
async function diagnostics(spec: Probe): Promise<string> {
  await writeFile(join(probes, "locks/probe.ts"), probe(spec));
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
async function expectRejected(spec: Probe) {
  const output = await diagnostics(spec);
  const line =
    probe(spec)
      .split("\n")
      .findIndex((text) => text.includes(selectionLine(spec.select))) + 1;
  expect({
    select: spec.select,
    onLine: line > 0 && output.includes(`locks/probe.ts(${line},`),
  }).toEqual({
    select: spec.select,
    onLine: true,
  });
}
const baseOnly = [
  "USAGE_INVALID_INVOCATION",
  "DOMAIN_DEADLINE_BEFORE_START",
  "DOMAIN_DEADLINE_UNCHANGED",
  "DOMAIN_DEADLINE_COMPLETED",
  "DOMAIN_DEADLINE_PARTIAL",
  "DOMAIN_DEADLINE_UNKNOWN",
];
const programStopProbe = {
  programStop: true,
  declared: [
    "SUCCESS_UNCHANGED",
    "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
    "DOMAIN_KF_WATCH_REFUSED",
  ],
} as const;
test("KF5.b handler-type-excludes-base-only-station", async () => {
  for (const twin of [
    {
      select: "SCHEMA_INVALID_INPUT",
      declared: ["SCHEMA_INVALID_INPUT", ...baseOnly],
    },
    { ...programStopProbe, select: "DOMAIN_KF_WATCH_REFUSED" },
    {
      select: "DOMAIN_AUTHORITY_REQUIRED",
      declared: ["DOMAIN_AUTHORITY_REQUIRED"],
      approval: true,
    },
  ])
    expect({ twin: twin.select, output: await diagnostics(twin) }).toEqual({
      twin: twin.select,
      output: "",
    });
  for (const select of baseOnly)
    await expectRejected({
      select,
      declared: ["SCHEMA_INVALID_INPUT", ...baseOnly],
    });
  await expectRejected({
    select: "DOMAIN_AUTHORITY_REQUIRED",
    declared: ["DOMAIN_AUTHORITY_REQUIRED"],
  });
  await expectRejected({
    ...programStopProbe,
    select: "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
  });
}, 180_000);
