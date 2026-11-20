import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  helperEntry,
  releaseWorlds,
  repository,
  runFolder,
  scenarioFile,
  viaKernelFreeCheck,
  watchdog,
  world,
} from "../verify-skill/harness.ts";
import {
  featurePath,
  featureScenario,
  type OwnCli,
  type OwnCliRun,
  ownCliFailures,
  type Ran,
  readRecord,
  recordedNames,
  recordPath,
} from "./self-verification.ts";

afterAll(releaseWorlds);

const record = readRecord();

describe("self-verification: verify-cli on the kernel's own CLIs", () => {
  test(
    "the author skill's example passes the sweep, meets its read-only scenario, and owes only what the record lists",
    async () => {
      const at = world();
      const run = runFolder(at, "example");
      const scenario = scenarioFile(
        at,
        featureScenario(readFileSync(join(repository, featurePath), "utf8")),
      );
      const runs: OwnCliRun[] = [];
      for (const [command, ...argv] of [
        ["launch", run, at.example],
        ["drive", run, scenario],
        ["report", run],
      ] as const)
        runs.push({
          command,
          ran: await viaKernelFreeCheck(at, [command, ...argv, "--json"]),
        });
      expect(
        ownCliFailures({ name: "example", entry: "src/cli.ts", runs }, record),
      ).toEqual([]);
    },
    watchdog(0, 3),
  );

  test(
    "verify-cli's own CLI passes the sweep and owes only what the record lists",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(
        at,
        ["sweep", helperEntry, "--json"],
        { cwd: repository },
      );
      expect(
        ownCliFailures(
          {
            name: "verify-cli",
            entry: "skills/verify-cli/helper/cli.ts",
            runs: [{ command: "sweep", ran }],
          },
          record,
        ),
      ).toEqual([]);
    },
    watchdog(0, 1),
  );

  test("the owed-result record names exactly the CLIs self-verification runs", () => {
    expect(recordedNames(record)).toEqual(["example", "verify-cli"]);
  });
});

function envelope(data: unknown, exit = 0, extra: object = {}): Ran {
  return {
    exit,
    stdout: JSON.stringify({ message: "said", result: { data, ...extra } }),
    stderr: "",
  };
}

const owed = { command: "moons.show", cause: "DOMAIN_MOONS_UNKNOWN_PLANET" };
const recorded = { example: [owed] };

function swept(ran: Ran): OwnCli {
  return {
    name: "example",
    entry: "src/cli.ts",
    runs: [{ command: "sweep", ran }],
  };
}

function reported(data: object): OwnCli {
  return {
    name: "example",
    entry: "src/cli.ts",
    runs: [
      {
        command: "report",
        ran: envelope({
          stations: [
            { ...owed, state: "owed" },
            {
              command: "moons.show",
              cause: "SUCCESS_UNCHANGED",
              state: "driven",
            },
          ],
          unmet: [],
          unconfirmed: [],
          findings: 0,
          ...data,
        }),
      },
    ],
  };
}

describe("self-verification refuses what verify-cli reports, each with a repair", () => {
  test("a clean sweep and a clean report pass", () => {
    expect(
      ownCliFailures(swept(envelope({ checks: 3, owed: [owed] })), recorded),
    ).toEqual([]);
    expect(ownCliFailures(reported({}), recorded)).toEqual([]);
  });

  test("an owed result the record does not list is refused", () => {
    const extra = { command: "moons.list", cause: "SUCCESS_UNCHANGED" };
    expect(
      ownCliFailures(
        swept(envelope({ checks: 3, owed: [owed, extra] })),
        recorded,
      ),
    ).toEqual([
      `example: moons.list SUCCESS_UNCHANGED is owed and ${recordPath} does not list it. Repair: drive it with a --json step in a scenario, or add it to "example" in that record when no scenario can reach it yet.`,
    ]);
  });

  test("a recorded owed result that is no longer owed is refused", () => {
    expect(
      ownCliFailures(swept(envelope({ checks: 3, owed: [] })), recorded),
    ).toEqual([
      `example: ${recordPath} lists moons.show DOMAIN_MOONS_UNKNOWN_PLANET, which is no longer owed. Repair: remove it from "example" in that record.`,
    ]);
  });

  test("a CLI the record does not name is refused", () => {
    expect(
      ownCliFailures(swept(envelope({ checks: 3, owed: [] })), {}),
    ).toEqual([
      `example: ${recordPath} holds no list of { command, cause } entries for this CLI. Repair: give "example" the list of owed results its self-verification run leaves.`,
    ]);
  });

  test("a sweep with findings is refused with its own repair", () => {
    expect(
      ownCliFailures(
        swept(envelope(null, 3, { repairAction: "Run the findings command." })),
        recorded,
      ),
    ).toEqual([
      "example: bun skills/verify-cli/verify.ts sweep exited 3: said Repair: Run the findings command.",
    ]);
  });

  test("a sweep that ran no check is refused", () => {
    expect(
      ownCliFailures(swept(envelope({ checks: 0, owed: [owed] })), recorded),
    ).toEqual([
      "example: the sweep ran no check. Repair: a sweep that checks nothing proves nothing; run bun skills/verify-cli/verify.ts sweep src/cli.ts by hand and repair the target's discovery.",
    ]);
  });

  test("a run verify-cli cannot trust is refused with its RAW FAIL lines", () => {
    expect(
      ownCliFailures(
        swept({
          exit: 70,
          stdout: "",
          stderr: "verify-cli: RAW FAIL kernel-entry: broke. Repair: mend.\n",
        }),
        recorded,
      ),
    ).toEqual([
      "example: bun skills/verify-cli/verify.ts sweep exited 70, so its run cannot be trusted: verify-cli: RAW FAIL kernel-entry: broke. Repair: mend. Repair: follow each RAW FAIL line's repair, then run this test again.",
    ]);
  });

  test("a report with findings, an unmet step, an unconfirmed end, or nothing driven is refused", () => {
    expect(
      ownCliFailures(
        reported({
          findings: 2,
          unmet: [{ step: "show-known-planet", unmet: ["result.data"] }],
          unconfirmed: ["show-known-planet"],
          stations: [{ ...owed, state: "owed" }],
        }),
        recorded,
      ),
    ).toEqual([
      "example: the sweep found 2 failed checks. Repair: run bun skills/verify-cli/verify.ts findings src/cli.ts for the list, then repair the target or its declarations.",
      `example: step show-known-planet is unmet: result.data. Repair: make the target do what the step expects. Change the scenario in ${featurePath} only when the example's documented output changed on purpose.`,
      "example: step show-known-planet's process end was not confirmed. Repair: make the target exit on its own within the step's limit.",
      `example: the scenario drove no station. Repair: give ${featurePath}'s scenario a met --json step.`,
    ]);
  });

  test("a sweep or a report missing a field it must hold is refused, never read as empty", () => {
    const repair = (command: string, name: string, kind: string) =>
      `example: bun skills/verify-cli/verify.ts ${command}'s result holds no ${name} ${kind}. Repair: run bun skills/verify-cli/verify.ts ${command} --json by hand and repair verify-cli's output; a missing ${name} never reads as empty.`;
    expect(
      ownCliFailures(swept(envelope({ checks: 3 })), {
        example: [],
      }),
    ).toEqual([repair("sweep", "owed", "list")]);
    const report = reported({});
    expect(
      ownCliFailures(
        {
          ...report,
          runs: [
            {
              command: "report",
              ran: envelope({
                stations: [
                  { ...owed, state: "owed" },
                  {
                    command: "moons.show",
                    cause: "SUCCESS_UNCHANGED",
                    state: "driven",
                  },
                ],
              }),
            },
          ],
        },
        recorded,
      ),
    ).toEqual([
      repair("report", "findings", "number"),
      repair("report", "unmet", "list"),
      repair("report", "unconfirmed", "list"),
    ]);
  });

  test("a failed drive still lets the report's own failures through", () => {
    const report = reported({ findings: 1 });
    expect(
      ownCliFailures(
        {
          ...report,
          runs: [
            {
              command: "drive",
              ran: envelope(null, 3, { repairAction: "Read the evidence." }),
            },
            ...report.runs,
          ],
        },
        recorded,
      ),
    ).toEqual([
      "example: bun skills/verify-cli/verify.ts drive exited 3: said Repair: Read the evidence.",
      "example: the sweep found 1 failed checks. Repair: run bun skills/verify-cli/verify.ts findings src/cli.ts for the list, then repair the target or its declarations.",
    ]);
  });

  test("the read-only feature file must show exactly one scenario", () => {
    expect(() => featureScenario("no block")).toThrow(
      `${featurePath} shows 0 scenario blocks. Repair: keep exactly one json block there, the scenario self-verification drives.`,
    );
  });
});
