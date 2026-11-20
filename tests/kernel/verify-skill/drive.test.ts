import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  causeOf,
  changingScenario,
  field,
  fixture,
  helper,
  lsTree,
  parsed,
  readJson,
  readOnlyScenario,
  releaseWorlds,
  runFolder,
  scenarioFile,
  watchdog,
  world,
  writePackage,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

function indexRows(run: string): unknown[] {
  return readFileSync(join(run, "evidence", "index.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => parsed(line));
}

async function launched(at: World, name: string, target = at.example) {
  const run = runFolder(at, name);
  const ran = await helper(at, ["launch", run, target]);
  expect(causeOf(ran)).toBe("SUCCESS_COMPLETED");
  return run;
}

function stepFile(run: string, feature: string, step: string): unknown {
  return readJson(join(run, "evidence", feature, `${step}.json`));
}

function oneStep(feature: string, step: Record<string, unknown>) {
  return { schema: "verify-scenario/1", feature, steps: [step] };
}

describe("drive", () => {
  test(
    "drive meets the read-only example and credits one station",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const ran = await helper(at, [
        "drive",
        run,
        scenarioFile(at, readOnlyScenario),
      ]);
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: field(JSON.parse(ran.stdout), "message"),
      }).toEqual({
        exit: 0,
        cause: "SUCCESS_COMPLETED",
        message: "2 steps met.",
      });
      for (const step of ["show-known-planet", "show-unknown-planet"])
        expect(field(stepFile(run, "read-only-command", step), "verdict")).toBe(
          "met",
        );
      const rows = indexRows(run);
      expect(rows).toHaveLength(3);
      expect(
        rows.slice(1).map((row) => ({
          step: field(row, "step"),
          commandIdentity: field(row, "commandIdentity"),
          causeCode: field(row, "causeCode"),
        })),
      ).toEqual([
        {
          step: "show-known-planet",
          commandIdentity: "moons.show",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          step: "show-unknown-planet",
          commandIdentity: null,
          causeCode: null,
        },
      ]);
    },
    watchdog(2),
  );

  test(
    "drive reports the unmet expectation and still runs the next step",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const changed = parsed(
        JSON.stringify(readOnlyScenario).replace('"moons":2', '"moons":3'),
      );
      const ran = await helper(at, ["drive", run, scenarioFile(at, changed)]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_EXPECTATION_UNMET",
      });
      const known = stepFile(run, "read-only-command", "show-known-planet");
      expect({
        verdict: field(known, "verdict"),
        unmet: field(known, "unmet"),
      }).toEqual({ verdict: "unmet", unmet: ["result.data"] });
      expect(
        field(
          stepFile(run, "read-only-command", "show-unknown-planet"),
          "verdict",
        ),
      ).toBe("met");
    },
    watchdog(2),
  );

  test(
    "drive never overwrites an evidence file",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const scenario = scenarioFile(at, readOnlyScenario);
      expect(causeOf(await helper(at, ["drive", run, scenario]))).toBe(
        "SUCCESS_COMPLETED",
      );
      const path = join(
        run,
        "evidence",
        "read-only-command",
        "show-known-planet.json",
      );
      const before = readFileSync(path);
      const again = await helper(at, ["drive", run, scenario]);
      expect({ exit: again.exit, cause: causeOf(again) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_ALREADY_DRIVEN",
      });
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(indexRows(run)).toHaveLength(3);
    },
    watchdog(3),
  );

  test(
    "a timed-out step is unmet",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const ran = await helper(at, [
        "drive",
        run,
        scenarioFile(
          at,
          oneStep("time-limit", {
            name: "hangs",
            runner: "bun",
            timeoutMilliseconds: 300,
            argv: ["-e", "setInterval(() => {}, 1000)"],
            expect: { exitCode: 0, stdout: "" },
          }),
        ),
      ]);
      expect(causeOf(ran)).toBe("DOMAIN_VERIFY_EXPECTATION_UNMET");
      const kept = stepFile(run, "time-limit", "hangs");
      expect(field(kept, "unmet")).toContain("timedOut");
      expect(field(kept, "observed", "timedOut")).toBe(true);
    },
    watchdog(2),
  );

  test(
    "a cut output is unmet",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const ran = await helper(at, [
        "drive",
        run,
        scenarioFile(
          at,
          oneStep("output-limit", {
            name: "floods",
            runner: "bun",
            outputLimitBytes: 10,
            argv: ["-e", "process.stdout.write('x'.repeat(100))"],
            expect: { exitCode: 0, stderr: "" },
          }),
        ),
      ]);
      expect(causeOf(ran)).toBe("DOMAIN_VERIFY_EXPECTATION_UNMET");
      expect(field(stepFile(run, "output-limit", "floods"), "unmet")).toEqual([
        "outputTruncated",
      ]);
    },
    watchdog(2),
  );

  test(
    "drive shows a second run and an interrupted run of a changing command",
    async () => {
      const at = world();
      const run = await launched(at, "r1", fixture(at, "notes-cli.ts"));
      const state = join(run, "scratch", "notes-state");
      const ran = await helper(
        at,
        ["drive", run, scenarioFile(at, changingScenario)],
        { ...at.env, NOTES_STATE: state },
      );
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: field(JSON.parse(ran.stdout), "message"),
      }).toEqual({
        exit: 0,
        cause: "SUCCESS_COMPLETED",
        message: "6 steps met.",
      });
      const interrupted = stepFile(run, "changing-command", "interrupted-run");
      expect(field(interrupted, "observed")).toMatchObject({
        exitCode: 143,
        timedOut: true,
        stdout: "",
        stderr: "",
        files: [null],
      });
    },
    watchdog(2),
  );

  test(
    "a changing command keeps its state under its verification run",
    async () => {
      const at = world();
      const run = await launched(at, "r1", fixture(at, "notes-cli.ts"));
      const state = join(run, "scratch", "notes-state");
      await helper(at, ["drive", run, scenarioFile(at, changingScenario)], {
        ...at.env,
        NOTES_STATE: state,
      });
      expect(lsTree(state).length).toBeGreaterThan(0);
      expect(causeOf(await helper(at, ["cleanup", run]))).toBe(
        "SUCCESS_COMPLETED",
      );
      expect(lsTree(join(run, "scratch"))).toEqual([]);
    },
    watchdog(3),
  );

  test(
    "the check command is driven as a step",
    async () => {
      const at = world();
      mkdirSync(join(at.repo, "checks"));
      writeFileSync(
        join(at.repo, "checks", "ok.test.ts"),
        'import { expect, test } from "bun:test";\ntest("holds", () => expect(1).toBe(1));\n',
      );
      writePackage(at.repo, { scripts: { check: "bun test checks" } });
      const run = await launched(at, "green");
      const step = {
        name: "check",
        runner: "bun",
        timeoutMilliseconds: 600_000,
        argv: ["run", "check"],
        expect: { exitCode: 0, stderrIncludes: ["\n 0 fail\n"] },
      };
      expect(
        causeOf(
          await helper(at, [
            "drive",
            run,
            scenarioFile(at, oneStep("check-command", step)),
          ]),
        ),
      ).toBe("SUCCESS_COMPLETED");
      writeFileSync(
        join(at.repo, "checks", "bad.test.ts"),
        'import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n',
      );
      const red = await launched(at, "red");
      await helper(at, [
        "drive",
        red,
        scenarioFile(at, oneStep("check-command", step)),
      ]);
      expect(field(stepFile(red, "check-command", "check"), "unmet")).toEqual([
        "exitCode",
        "stderrIncludes.0",
      ]);
    },
    watchdog(4),
  );

  test(
    "an exit code of 0 that ran nothing is unmet",
    async () => {
      const at = world();
      writePackage(at.repo, { scripts: { check: "bun test checks" } });
      const run = await launched(at, "r1");
      await helper(at, [
        "drive",
        run,
        scenarioFile(
          at,
          oneStep("check-command", {
            name: "two-word-folder",
            runner: "bun",
            argv: ["--cwd", "{repository}", "run", "check"],
            expect: { exitCode: 0, stderrIncludes: ["\n 0 fail\n"] },
          }),
        ),
      ]);
      const kept = stepFile(run, "check-command", "two-word-folder");
      expect({
        exitCode: field(kept, "observed", "exitCode"),
        unmet: field(kept, "unmet"),
      }).toEqual({ exitCode: 0, unmet: ["stderrIncludes.0"] });
    },
    watchdog(2),
  );

  test(
    "each target step starts in the repository root, and placeholders name the scratch folder and the repository, in a file's content too",
    async () => {
      const at = world();
      const run = await launched(at, "r1", fixture(at, "target-cli.ts"));
      const ran = await helper(at, [
        "drive",
        run,
        scenarioFile(at, {
          ...oneStep("where", {
            name: "where",
            argv: ["where", "{scratch}/x"],
            expect: {
              exitCode: 0,
              stdout: `{repository} {scratch}/x\n`,
              stderr: "",
            },
          }),
          steps: [
            {
              name: "where",
              argv: ["where", "{scratch}/x"],
              expect: {
                exitCode: 0,
                stdout: `{repository} {scratch}/x\n`,
                stderr: "",
              },
            },
            {
              name: "write-paths",
              runner: "bun",
              argv: [
                "-e",
                "await Bun.write(process.argv[1], process.argv[2])",
                "{scratch}/paths",
                "{repository}|{scratch}",
              ],
              expect: {
                exitCode: 0,
                stderr: "",
                files: [
                  {
                    path: "{scratch}/paths",
                    content: "{repository}|{scratch}",
                  },
                ],
              },
            },
          ],
        }),
      ]);
      expect(causeOf(ran)).toBe("SUCCESS_COMPLETED");
      expect(field(stepFile(run, "where", "where"), "argv")).toEqual([
        "where",
        join(run, "scratch", "x"),
      ]);
    },
    watchdog(2),
  );
});

const ruleDetails: Readonly<Record<string, string>> = {
  "unknown-field":
    "the scenario has the field extra, which the format does not name",
  "bad-name": "feature must be 1 to 64 lower-case letters, digits and hyphens",
  "duplicate-step": "two steps are named show-known-planet",
  "step-count": "the scenario has 0 steps; it needs 1 to 200",
  "exit-code-only":
    "steps.0.expect must hold exitCode and at least one expectation on stdout, stderr, the result or a file",
  "includes-on-target-step":
    "steps.0.expect has stdoutIncludes or stderrIncludes on a target step, which must be exact",
  "path-outside-scratch":
    'steps.0.expect.files.0.path "{scratch}/../x" must start {scratch}/ and hold no .. segment',
  "limit-out-of-range": "steps.0.timeoutMilliseconds is 0, outside 1 to 600000",
  "bad-value": "steps.0.argv must be a list of strings",
};

const brokenScenarios: readonly (readonly [string, unknown])[] = [
  ["unknown-field", { ...readOnlyScenario, extra: true }],
  ["bad-name", { ...readOnlyScenario, feature: "Read-Only" }],
  [
    "duplicate-step",
    {
      ...readOnlyScenario,
      steps: [readOnlyScenario.steps[0], readOnlyScenario.steps[0]],
    },
  ],
  ["step-count", { ...readOnlyScenario, steps: [] }],
  [
    "exit-code-only",
    oneStep("read-only-command", {
      name: "s",
      argv: ["list"],
      expect: { exitCode: 0 },
    }),
  ],
  [
    "includes-on-target-step",
    oneStep("read-only-command", {
      name: "s",
      argv: ["list"],
      expect: { exitCode: 0, stdoutIncludes: ["mars"] },
    }),
  ],
  [
    "path-outside-scratch",
    oneStep("read-only-command", {
      name: "s",
      argv: ["list"],
      expect: {
        exitCode: 0,
        files: [{ path: "{scratch}/../x", absent: true }],
      },
    }),
  ],
  [
    "limit-out-of-range",
    oneStep("read-only-command", {
      name: "s",
      argv: ["list"],
      timeoutMilliseconds: 0,
      expect: { exitCode: 0, stderr: "" },
    }),
  ],
  [
    "bad-value",
    oneStep("read-only-command", {
      name: "s",
      argv: "list",
      expect: { exitCode: 0, stderr: "" },
    }),
  ],
];

describe("drive refuses a scenario that breaks a rule", () => {
  test(
    "drive refuses a scenario that breaks a rule: unreadable",
    async () => {
      const at = world();
      const run = await launched(at, "r1");
      const ran = await helper(at, [
        "drive",
        run,
        join(at.folder, "missing.json"),
      ]);
      expect({
        cause: causeOf(ran),
        message: field(parsed(ran.stdout), "message"),
      }).toEqual({
        cause: "DOMAIN_VERIFY_SCENARIO",
        message: `The scenario breaks the rule unreadable: ${join(at.folder, "missing.json")} is missing.`,
      });
      expect(lsTree(join(run, "evidence"))).toEqual(["index.jsonl"]);
    },
    watchdog(2),
  );

  for (const [rule, scenario] of brokenScenarios)
    test(
      `drive refuses a scenario that breaks a rule: ${rule}`,
      async () => {
        const at = world();
        const run = await launched(at, "r1");
        const ran = await helper(at, [
          "drive",
          run,
          scenarioFile(at, scenario),
        ]);
        expect({
          exit: ran.exit,
          cause: causeOf(ran),
          message: field(parsed(ran.stdout), "message"),
        }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_SCENARIO",
          message: `The scenario breaks the rule ${rule}: ${String(ruleDetails[rule])}.`,
        });
        expect(lsTree(join(run, "evidence"))).toEqual(["index.jsonl"]);
        expect(indexRows(run)).toHaveLength(1);
      },
      watchdog(2),
    );
});
