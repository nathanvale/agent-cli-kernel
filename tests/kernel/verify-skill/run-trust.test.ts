import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLimits,
  kernelFreeCheck,
} from "../../../skills/verify-cli/verify.ts";
import type { Ran, Spawn } from "../../../skills/verify-cli/verify.ts";
import {
  causeOf,
  helper,
  installedCopy,
  plantFault,
  rawFailIds,
  readOnlyScenario,
  releaseWorlds,
  runFolder,
  scenarioFile,
  viaKernelFreeCheck,
  watchdog,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

async function driven(at: World, scenario: unknown = readOnlyScenario) {
  const run = runFolder(at, "r1");
  expect(causeOf(await helper(at, ["launch", run, at.example]))).toBe(
    "SUCCESS_COMPLETED",
  );
  await helper(at, ["drive", run, scenarioFile(at, scenario)]);
  return run;
}

function evidenceFile(run: string, feature: string, step: string): string {
  return join(run, "evidence", feature, `${step}.json`);
}

async function refused(at: World, argv: readonly string[], entry?: string) {
  const ran = await viaKernelFreeCheck(
    at,
    argv,
    entry === undefined ? {} : { entry },
  );
  return { exit: ran.exit, stdout: ran.stdout, ids: rawFailIds(ran.stderr) };
}

const untrusted = (id: string) => ({ exit: 70, stdout: "", ids: [id] });

describe("the check on a run already launched", () => {
  test(
    "a programs fault that arrives after launch is caught by drive and by report",
    async () => {
      const at = world();
      const entry = installedCopy(at);
      const run = runFolder(at, "r1");
      expect(
        (await viaKernelFreeCheck(at, ["launch", run, at.example], { entry }))
          .exit,
      ).toBe(0);
      plantFault(at, {
        file: "kernel/src/addons/programs/index.ts",
        from: "      exitCode: child.exitCode,",
        to: "      exitCode: 0,",
      });
      expect(
        await refused(
          at,
          ["drive", run, scenarioFile(at, readOnlyScenario)],
          entry,
        ),
      ).toEqual(untrusted("observation-mismatch"));
      expect(await refused(at, ["report", run], entry)).toEqual(
        untrusted("observation-mismatch"),
      );
    },
    watchdog(0, 3),
  );

  test(
    "a changed evidence file stops pending, drive and cleanup before they run",
    async () => {
      const at = world();
      const run = await driven(at);
      appendFileSync(
        evidenceFile(run, "read-only-command", "show-known-planet"),
        " ",
      );
      expect(await refused(at, ["pending", run])).toEqual(
        untrusted("evidence-mismatch"),
      );
      expect(
        await refused(at, [
          "drive",
          run,
          scenarioFile(at, { ...readOnlyScenario, feature: "again" }),
        ]),
      ).toEqual(untrusted("evidence-mismatch"));
      expect(existsSync(join(run, "evidence", "again"))).toBe(false);
      expect(await refused(at, ["cleanup", run])).toEqual(
        untrusted("evidence-mismatch"),
      );
      expect(existsSync(join(run, "scratch"))).toBe(true);
    },
    watchdog(2, 3),
  );

  test(
    "evidence a step changes during drive is caught when drive ends",
    async () => {
      const at = world();
      const run = await driven(at);
      const earlier = evidenceFile(
        run,
        "read-only-command",
        "show-known-planet",
      );
      expect(
        await refused(at, [
          "drive",
          run,
          scenarioFile(at, {
            schema: "verify-scenario/1",
            feature: "tamper",
            steps: [
              {
                name: "append",
                runner: "bun",
                argv: [
                  "-e",
                  "require('node:fs').appendFileSync(process.argv[1], ' ')",
                  earlier,
                ],
                expect: { exitCode: 0, stderr: "" },
              },
            ],
          }),
        ]),
      ).toEqual(untrusted("evidence-mismatch"));
    },
    watchdog(2, 1),
  );

  test(
    "a changed evidence file of an unmet step cannot be trusted either",
    async () => {
      const at = world();
      const [known, unknown] = readOnlyScenario.steps;
      const run = await driven(at, {
        ...readOnlyScenario,
        steps: [
          { ...known, expect: { ...known.expect, stderr: "x" } },
          unknown,
        ],
      });
      appendFileSync(
        evidenceFile(run, "read-only-command", "show-known-planet"),
        " ",
      );
      expect(await refused(at, ["report", run])).toEqual(
        untrusted("evidence-mismatch"),
      );
    },
    watchdog(2, 1),
  );
});

const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type Call = {
  readonly args: readonly string[];
  readonly milliseconds: number;
};

function answering(
  target: string,
  command: (args: readonly string[]) => Partial<Ran>,
): { spawn: Spawn; made: Call[] } {
  const made: Call[] = [];
  const envelope = (exitCode: number, data: unknown = null) =>
    `${JSON.stringify({ message: "m", result: { exitCode, causeCode: "C", data } })}\n`;
  const answer = (args: readonly string[]): Partial<Ran> => {
    if (args.includes("-e") || args[1] === target) return {};
    if (args.includes("verify-cli-undeclared-command"))
      return { exitCode: 2, stdout: envelope(2) };
    if (args.includes("probe"))
      return {
        stdout: envelope(0, {
          probes: [
            ["--verify-cli-undeclared-option"],
            ["--discover", "--json"],
          ].map((argv) => ({
            argv,
            exitCode: 0,
            stdoutBytes: 0,
            stdoutSha256: emptySha256,
            stderrSha256: emptySha256,
          })),
        }),
      };
    return { stdout: envelope(0), ...command(args) };
  };
  return {
    made,
    spawn: (args, _cwd, milliseconds) => {
      made.push({ args, milliseconds });
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...answer(args),
      });
    },
  };
}

describe("the check's steps on a run, in process", () => {
  const limits = {
    ...defaultLimits,
    commandMilliseconds: 1_111,
    driveMilliseconds: 2_222,
  };

  test(
    "drive is given the drive limit, and other run commands the command limit",
    async () => {
      const at = world();
      const run = await driven(at);
      for (const [argv, milliseconds] of [
        [["drive", run, scenarioFile(at, readOnlyScenario)], 2_222],
        [["report", run], 1_111],
        [["pending", run], 1_111],
      ] as const) {
        const { spawn, made } = answering(at.example, () => ({}));
        expect((await kernelFreeCheck(argv, at.repo, spawn, limits)).kind).toBe(
          "trusted",
        );
        expect(
          made.find((call) => call.args[2] === argv[0])?.milliseconds,
        ).toBe(milliseconds);
      }
    },
    watchdog(2),
  );

  test(
    "evidence changed while cleanup runs is caught when cleanup ends",
    async () => {
      const at = world();
      const run = await driven(at);
      const { spawn } = answering(at.example, (args) => {
        if (args[2] === "cleanup")
          appendFileSync(
            evidenceFile(run, "read-only-command", "show-known-planet"),
            " ",
          );
        return {};
      });
      const checked = await kernelFreeCheck(
        ["cleanup", run],
        at.repo,
        spawn,
        limits,
      );
      expect(
        checked.kind === "untrusted"
          ? checked.failures.map((failure) => failure.id)
          : [],
      ).toEqual(["evidence-mismatch"]);
    },
    watchdog(2),
  );
});
