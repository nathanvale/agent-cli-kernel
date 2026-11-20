import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  stationStates,
  stepDetails,
} from "../../../skills/verify-cli/helper/report.ts";
import { verificationRun } from "../../../skills/verify-cli/helper/place.ts";
import type { StepRow } from "../../../skills/verify-cli/helper/place.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { alive } from "../lifecycle/harness.ts";
import {
  causeOf,
  viaKernelFreeCheck,
  checkBound,
  checkEntry,
  field,
  fixture,
  helper,
  helperAlone,
  helperBound,
  ledgeredPid,
  ledgerHolds,
  lsTree,
  makeFifo,
  rawFailIds,
  readOnlyScenario,
  releaseFifo,
  releaseWorlds,
  runFolder,
  scenarioFile,
  watchdog,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

async function launched(at: World, target = at.example) {
  const run = runFolder(at, "r1");
  expect(causeOf(await helper(at, ["launch", run, target]))).toBe(
    "SUCCESS_COMPLETED",
  );
  return run;
}

function oneStep(feature: string, name: string, argv: readonly string[]) {
  return {
    schema: "verify-scenario/1",
    feature,
    steps: [{ name, argv, expect: { exitCode: 0, stderr: "" } }],
  };
}

describe("report and cleanup", () => {
  test(
    "report gives each station one state",
    async () => {
      const at = world();
      const run = await launched(at);
      await helper(at, ["drive", run, scenarioFile(at, readOnlyScenario)]);
      const ran = await viaKernelFreeCheck(at, ["report", run, "--json"]);
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const envelope: unknown = JSON.parse(ran.stdout);
      expect(field(envelope, "message")).toBe(
        "Stations: 1 swept, 1 driven, 1 owed. Steps: 2 met, 0 unmet.",
      );
      expect(field(envelope, "result", "data", "stations")).toEqual([
        {
          command: "moons.list",
          cause: "SUCCESS_UNCHANGED",
          state: "swept",
          by: "run-names-its-command",
        },
        {
          command: "moons.show",
          cause: "SUCCESS_UNCHANGED",
          state: "driven",
          by: "read-only-command/show-known-planet",
        },
        {
          command: "moons.show",
          cause: "DOMAIN_MOONS_UNKNOWN_PLANET",
          state: "owed",
          by: null,
        },
      ]);
    },
    watchdog(2, 1),
  );

  test(
    "a station whose run failed a check is owed, and the report counts the failed checks",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "liar-cli.ts"));
      const env = { ...at.env, VERIFY_LIE: "run-names-its-command" };
      const ran = await viaKernelFreeCheck(at, ["report", run, "--json"], {
        env,
      });
      const envelope: unknown = JSON.parse(ran.stdout);
      expect({
        exit: ran.exit,
        message: field(envelope, "message"),
        stations: field(envelope, "result", "data", "stations"),
      }).toEqual({
        exit: 0,
        message:
          "Stations: 0 swept, 0 driven, 1 owed. Steps: 0 met, 0 unmet. The sweep found 1 failed check; run findings to see it.",
        stations: [
          {
            command: "liar.status",
            cause: "SUCCESS_UNCHANGED",
            state: "owed",
            by: null,
          },
        ],
      });
    },
    watchdog(1, 1),
  );

  test(
    "evidence outlives cleanup",
    async () => {
      const at = world();
      const run = await launched(at);
      expect(
        (
          await viaKernelFreeCheck(at, [
            "drive",
            run,
            scenarioFile(at, readOnlyScenario),
          ])
        ).exit,
      ).toBe(0);
      const cleaned = await viaKernelFreeCheck(at, ["cleanup", run]);
      expect({ exit: cleaned.exit, stderr: cleaned.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(lsTree(run).filter((path) => !path.startsWith("state/"))).toEqual([
        "evidence",
        "evidence/index.jsonl",
        "evidence/read-only-command",
        "evidence/read-only-command/show-known-planet.json",
        "evidence/read-only-command/show-unknown-planet.json",
        "state",
      ]);
      expect((await viaKernelFreeCheck(at, ["report", run])).exit).toBe(0);
      const drivenAgain = await helper(at, [
        "drive",
        run,
        scenarioFile(at, { ...readOnlyScenario, feature: "after-cleanup" }),
      ]);
      expect({ exit: drivenAgain.exit, cause: causeOf(drivenAgain) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_CLEAN",
      });
      const again = await viaKernelFreeCheck(at, ["cleanup", run, "--json"]);
      expect({
        exit: again.exit,
        cause: field(JSON.parse(again.stdout), "result", "causeCode"),
      }).toEqual({ exit: 3, cause: "DOMAIN_VERIFY_RUN_CLEAN" });
    },
    watchdog(1, 4),
  );
});

describe("what the report reads", () => {
  const row = (
    step: string,
    verdict: "met" | "unmet",
    identity: string | null,
    cause: string | null,
    runner: "target" | "bun" = "target",
  ): StepRow => ({
    row: "step",
    feature: "f",
    step,
    runner,
    verdict,
    commandIdentity: identity,
    causeCode: cause,
    exitCode: 0,
    file: `f/${step}.json`,
    sha256: "",
  });
  const found = {
    contractVersion: "3.0.0",
    checks: 1,
    findings: [],
    required: [
      { command: "a.list", cause: "SUCCESS_UNCHANGED" },
      { command: "a.show", cause: "SUCCESS_UNCHANGED" },
      { command: "a.show", cause: "DOMAIN_A_MISSING" },
    ],
    swept: [
      {
        command: "a.list",
        cause: "SUCCESS_UNCHANGED",
        check: "run-names-its-command",
      },
    ],
    owed: [],
  };

  test("only a met target step whose envelope names the station drives it", () => {
    expect(
      stationStates(found, [
        row("unmet", "unmet", "a.show", "SUCCESS_UNCHANGED"),
        row("bun", "met", "a.show", "SUCCESS_UNCHANGED", "bun"),
        row("plain", "met", null, null),
        row("missing", "met", "a.show", "DOMAIN_A_MISSING"),
        row("other", "met", "a.other", "SUCCESS_UNCHANGED"),
      ]).map((entry) => `${entry.command} ${entry.cause} ${entry.state}`),
    ).toEqual([
      "a.list SUCCESS_UNCHANGED swept",
      "a.show SUCCESS_UNCHANGED owed",
      "a.show DOMAIN_A_MISSING driven",
    ]);
  });

  test("the report reads each step's unmet list and process end, and names a missing evidence file", () => {
    const at = world();
    const place = verificationRun(runFolder(at, "r1"));
    mkdirSync(join(place.evidence, "f"), { recursive: true });
    const write = (step: string, confirmed: boolean, unmet: string[]) =>
      writeFileSync(
        join(place.evidence, "f", `${step}.json`),
        JSON.stringify({
          unmet,
          observed: { terminationConfirmed: confirmed },
        }),
      );
    write("ended", true, []);
    write("lingered", false, ["exitCode"]);
    expect(
      stepDetails(place, [
        row("ended", "met", null, null),
        row("lingered", "unmet", null, null),
      ]),
    ).toEqual({
      kind: "read",
      steps: [
        { step: "f/ended", unmet: [], terminationConfirmed: true },
        {
          step: "f/lingered",
          unmet: ["exitCode"],
          terminationConfirmed: false,
        },
      ],
    });
    rmSync(join(place.evidence, "f", "ended.json"));
    expect(stepDetails(place, [row("ended", "met", null, null)])).toEqual({
      kind: "unreadable",
      reason: `${join(place.evidence, "f", "ended.json")} is missing`,
    });
  });
});

describe("the helper's own state, one folder for each run", () => {
  test(
    "a drive that holds a run makes a cleanup of that run DOMAIN_VERIFY_RUN_HELD, and the drive then finishes",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "target-cli.ts"));
      const ledger = join(at.folder, "ledger");
      const gate = join(at.folder, "gate");
      await makeFifo(gate);
      const held = helper(at, [
        "drive",
        run,
        scenarioFile(at, oneStep("hold", "hold", ["hold", ledger, gate])),
      ]);
      let cleanup: Awaited<ReturnType<typeof helper>> | undefined;
      let finished: Awaited<ReturnType<typeof helper>> | undefined;
      try {
        await ledgerHolds(ledger, "holding", helperBound);
        cleanup = await helper(at, ["cleanup", run]);
      } finally {
        try {
          await releaseFifo(gate);
        } finally {
          finished = await held;
        }
      }
      expect({
        exit: cleanup.exit,
        cause: causeOf(cleanup),
        finished: causeOf(finished),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_HELD",
        finished: "SUCCESS_COMPLETED",
      });
    },
    watchdog(4),
  );

  test(
    "an interrupted helper change is listed and holds its verification run",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "target-cli.ts"));
      const killed = await helperAlone(at, [
        "drive",
        run,
        scenarioFile(at, oneStep("orphan", "orphan", ["orphan", "now"])),
      ]);
      expect(killed.signal).toBe("SIGKILL");
      const pending = await helper(at, ["pending", run]);
      expect(field(pending.result, "data", "unfinished")).toEqual([
        expect.objectContaining({
          commandIdentity: "verify-cli.drive",
          effects: ["scenario.drive"],
        }),
      ]);
      const cleanup = await helper(at, ["cleanup", run]);
      expect({ exit: cleanup.exit, cause: causeOf(cleanup) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
      });
    },
    watchdog(4),
  );

  test(
    "a run whose index is gone but whose state holds an unfinished change is listed by pending and refused by cleanup as unresolved",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "target-cli.ts"));
      const killed = await helperAlone(at, [
        "drive",
        run,
        scenarioFile(at, oneStep("orphan", "orphan", ["orphan", "now"])),
      ]);
      expect(killed.signal).toBe("SIGKILL");
      rmSync(join(run, "evidence", "index.jsonl"));
      const pending = await helper(at, ["pending", run]);
      expect({
        cause: causeOf(pending),
        unfinished: field(pending.result, "data", "unfinished"),
      }).toEqual({
        cause: "SUCCESS_UNCHANGED",
        unfinished: [
          expect.objectContaining({ commandIdentity: "verify-cli.drive" }),
        ],
      });
      const unfinished = field(pending.result, "data", "unfinished");
      expect(
        Array.isArray(unfinished)
          ? unfinished.map((entry: unknown) =>
              typeof entry === "object" && entry !== null
                ? Object.keys(entry).sort()
                : [],
            )
          : [],
      ).toEqual([["commandIdentity", "effects", "operationId", "runId"]]);
      const cleanup = await helper(at, ["cleanup", run]);
      expect({ exit: cleanup.exit, cause: causeOf(cleanup) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
      });
    },
    watchdog(4),
  );

  test(
    "a state folder that is a file makes drive and pending DOMAIN_VERIFY_STATE_UNAVAILABLE",
    async () => {
      const at = world();
      const run = await launched(at);
      rmSync(join(run, "state"), { recursive: true });
      writeFileSync(join(run, "state"), "not a folder");
      const drive = await helper(at, [
        "drive",
        run,
        scenarioFile(at, readOnlyScenario),
      ]);
      expect({ exit: drive.exit, cause: causeOf(drive) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      });
      const pending = await helper(at, ["pending", run]);
      expect({ exit: pending.exit, cause: causeOf(pending) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      });
    },
    watchdog(3),
  );

  test(
    "a run whose index cannot be read is untrusted by the check, and refused by the helper's drive and report as DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
    async () => {
      const at = world();
      const run = await launched(at);
      writeFileSync(join(run, "evidence", "index.jsonl"), "not an index\n");
      const checked = await helper(at, ["report", run]);
      expect({ exit: checked.exit, ids: rawFailIds(checked.stderr) }).toEqual({
        exit: 70,
        ids: ["evidence-mismatch"],
      });
      for (const argv of [
        ["drive", run, scenarioFile(at, readOnlyScenario)],
        ["report", run],
      ]) {
        const ran = await helperAlone(at, argv);
        expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
        });
      }
    },
    watchdog(3),
  );

  test(
    "pending names its missing run folder, and lists nothing on a fresh run",
    async () => {
      const at = world();
      const bare = await helper(at, ["pending"]);
      expect({ exit: bare.exit, cause: causeOf(bare) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_MISSING",
      });
      const run = await launched(at);
      const listed = await helper(at, ["pending", run]);
      expect({
        cause: causeOf(listed),
        unfinished: field(listed.result, "data", "unfinished"),
      }).toEqual({ cause: "SUCCESS_UNCHANGED", unfinished: [] });
    },
    watchdog(3),
  );

  test(
    "a scratch folder cleanup cannot remove makes cleanup DOMAIN_VERIFY_CHANGE_UNKNOWN",
    async () => {
      const at = world();
      const run = await launched(at);
      const inner = join(run, "scratch", "inner");
      mkdirSync(join(inner, "kept"), { recursive: true });
      chmodSync(inner, 0o500);
      try {
        const cleanup = await helper(at, ["cleanup", run]);
        expect({ exit: cleanup.exit, cause: causeOf(cleanup) }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_CHANGE_UNKNOWN",
        });
      } finally {
        chmodSync(inner, 0o700);
      }
    },
    watchdog(2),
  );

  test(
    "the check stopped by SIGTERM in the middle of a drive stops the helper and the target, and exits 143",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "target-cli.ts"));
      const ledger = join(at.folder, "ledger");
      const gate = join(at.folder, "gate");
      await makeFifo(gate);
      const held = oneStep("hold", "hold", ["hold", ledger, gate]);
      const scenario = scenarioFile(at, {
        ...held,
        steps: held.steps.map((step) => ({
          ...step,
          timeoutMilliseconds: 60_000,
        })),
      });
      const started = performance.now();
      let stopped: { readonly exit: number; readonly stderr: string };
      try {
        stopped = await spawnBounded(
          [process.execPath, checkEntry, "drive", run, scenario],
          {
            cwd: at.repo,
            env: at.env,
            boundMilliseconds: checkBound,
            signalAt: { ledger, line: "holding", signal: "SIGTERM" },
          },
        );
      } finally {
        if (alive(ledgeredPid(ledger))) await releaseFifo(gate);
      }
      expect({ exit: stopped.exit, stderr: stopped.stderr }).toEqual({
        exit: 143,
        stderr:
          "verify-cli: stopped by SIGTERM; the helper stopped its children first.\n",
      });
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(alive(ledgeredPid(ledger))).toBe(false);
      expect(
        readFileSync(join(run, "evidence", "index.jsonl"), "utf8"),
      ).toContain('"row":"run"');
    },
    watchdog(1, 2),
  );

  test(
    "the check stopped by SIGINT in the middle of a drive stops the helper and the target, and exits 130",
    async () => {
      const at = world();
      const run = await launched(at, fixture(at, "target-cli.ts"));
      const ledger = join(at.folder, "ledger");
      const gate = join(at.folder, "gate");
      await makeFifo(gate);
      const held = oneStep("hold", "hold", ["hold", ledger, gate]);
      const scenario = scenarioFile(at, {
        ...held,
        steps: held.steps.map((step) => ({
          ...step,
          timeoutMilliseconds: 60_000,
        })),
      });
      const started = performance.now();
      let stopped: { readonly exit: number; readonly stderr: string };
      try {
        stopped = await spawnBounded(
          [process.execPath, checkEntry, "drive", run, scenario],
          {
            cwd: at.repo,
            env: at.env,
            boundMilliseconds: checkBound,
            signalAt: { ledger, line: "holding", signal: "SIGINT" },
          },
        );
      } finally {
        if (alive(ledgeredPid(ledger))) await releaseFifo(gate);
      }
      expect({ exit: stopped.exit, stderr: stopped.stderr }).toEqual({
        exit: 130,
        stderr:
          "verify-cli: stopped by SIGINT; the helper stopped its children first.\n",
      });
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(alive(ledgeredPid(ledger))).toBe(false);
      expect(
        readFileSync(join(run, "evidence", "index.jsonl"), "utf8"),
      ).toContain('"row":"run"');
    },
    watchdog(1, 2),
  );
});
