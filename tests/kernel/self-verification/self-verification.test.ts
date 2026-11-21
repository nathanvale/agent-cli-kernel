import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  field,
  helperEntry,
  readJson,
  releaseWorlds,
  repository,
  runFolder,
  scenarioFile,
  viaKernelFreeCheck,
  watchdog,
  world,
} from "../verify-skill/harness.ts";
import type { World } from "../verify-skill/harness.ts";
import {
  changingFeaturePath,
  checkLine,
  featurePath,
  featureScenario,
  type OwnCli,
  type OwnCliRun,
  ownCliFailures,
  wantsFindings,
} from "./self-verification.ts";
import { readRecord, recordedNames } from "./station-record.ts";

afterAll(releaseWorlds);

const record = readRecord();
const again =
  "then run bun test ./tests/kernel/self-verification from the repository root";
const exampleRepair = `repair the example in tests/kernel/author-guide/example/, write references/example.md again with bun run tests/kernel/author-guide/example-document.ts, ${again}.`;
const helperRepair = `repair the helper in skills/verify-cli/helper/; from the repository root, ${checkLine} findings skills/verify-cli/helper/cli.ts lists every failed check; ${again}.`;

function stepEvidence(run: string, scenario: unknown): Map<string, unknown> {
  const feature = String(field(scenario, "feature"));
  const steps = field(scenario, "steps");
  const evidence = new Map<string, unknown>();
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = String(field(step, "name"));
    const path = join(run, "evidence", feature, `${name}.json`);
    if (existsSync(path)) evidence.set(`${feature}/${name}`, readJson(path));
  }
  return evidence;
}

async function judged(
  at: World,
  own: OwnCli,
  entry: string,
  cwd: string = at.repo,
) {
  const findings = wantsFindings(own)
    ? await viaKernelFreeCheck(at, ["findings", entry, "--json"], { cwd })
    : undefined;
  return ownCliFailures({ ...own, findings }, record);
}

describe("self-verification: verify-cli on the kernel's own CLIs", () => {
  test(
    "the author skill's example passes the sweep, meets its read-only and changing scenarios, and reaches only the stations the record lists",
    async () => {
      const at = world();
      const run = runFolder(at, "example");
      const scenarios = [featurePath, changingFeaturePath].map((path) =>
        featureScenario(readFileSync(join(repository, path), "utf8"), path),
      );
      const opener = join(at.folder, "opener");
      writeFileSync(
        opener,
        '#!/bin/sh\ncase "$1" in */venus.txt) exec sleep 60 ;; esac\n',
      );
      chmodSync(opener, 0o755);
      const env = {
        ...at.env,
        MOONS_HOME: join(run, "scratch", "moons"),
        MOONS_OPENER: opener,
      };
      const runs: OwnCliRun[] = [];
      for (const [command, ...argv] of [
        ["launch", run, at.example],
        ...scenarios.map((scenario) => [
          "drive",
          run,
          scenarioFile(at, scenario),
        ]),
        ["report", run],
      ])
        runs.push({
          command: command ?? "",
          ran: await viaKernelFreeCheck(
            at,
            [command ?? "", ...argv, "--json"],
            {
              env,
            },
          ),
        });
      const own = {
        name: "example",
        repair: exampleRepair,
        runs,
        evidence: new Map(
          scenarios.flatMap((scenario) => [...stepEvidence(run, scenario)]),
        ),
      };
      expect(await judged(at, own, at.example)).toEqual([]);
    },
    watchdog(0, 5),
  );

  test(
    "the helper passes the sweep and reaches only the stations the record lists",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(
        at,
        ["sweep", helperEntry, "--json"],
        { cwd: repository },
      );
      const own = {
        name: "helper",
        repair: helperRepair,
        runs: [{ command: "sweep", ran }],
      };
      expect(await judged(at, own, helperEntry, repository)).toEqual([]);
    },
    watchdog(0, 2),
  );

  test("the station record names exactly the CLIs self-verification runs", () => {
    expect(recordedNames(record)).toEqual(["example", "helper"]);
  });
});
