import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  absoluteArgv,
  bound,
  bunSpawn,
  compared,
  defaultLimits,
  envelopeFailures,
  evidenceFailures,
  failureLine,
  kernelFreeCheck,
  helperProbe,
  kernelImport,
  main,
  probeFailures,
  relayed,
  stopExit,
  timeoutFailure,
  untrustedExit,
} from "../../../skills/verify-cli/verify.ts";
import type {
  FailureId,
  Ran,
  Spawn,
} from "../../../skills/verify-cli/verify.ts";
import {
  probeResult,
  sha256,
  targetLimits,
} from "../../../skills/verify-cli/helper/place.ts";
import { verificationRun } from "../../../skills/verify-cli/helper/place.ts";
import { evidenceBytesLimit } from "../../../skills/verify-cli/helper/json.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  causeOf,
  viaKernelFreeCheck,
  field,
  fixtures,
  helper,
  checkEntry,
  helperBound,
  installedCopy,
  makeFifo,
  plantFault,
  rawFailIds,
  readOnlyScenario,
  releaseWorlds,
  repository,
  runFolder,
  scenarioFile,
  watchdog,
  world,
} from "./harness.ts";
import type { KernelFault, World } from "./harness.ts";

afterAll(releaseWorlds);

const kernelFaults = {
  exitsZero: {
    file: "kernel/src/kernel/process-host.ts",
    from: "      process.exit(code);",
    to: "      process.exit(0);",
  },
  contractThrows: {
    file: "kernel/src/kernel/index.ts",
    from: "  freeze(spec);\n",
    to: '  freeze(spec);\n  throw new Error("Planted kernel fault: building a contract throws.");\n',
  },
  entryFails: {
    file: "kernel/src/kernel/index.ts",
    from: 'import { navigationData } from "./validation/discovery.ts";\n',
    to: 'import { navigationData } from "./validation/discovery.ts";\nthrow new Error("Planted kernel fault: the entry cannot be imported.");\n',
  },
  envelopeTwice: {
    file: "kernel/src/kernel/process-host.ts",
    from: "          target.write(bytes, (error) => resolve(!error));",
    to: '          if (stream === "stdout") target.write(bytes);\n          target.write(bytes, (error) => resolve(!error));',
  },
  programsExitZero: {
    file: "kernel/src/addons/programs/index.ts",
    from: "      exitCode: child.exitCode,",
    to: "      exitCode: 0,",
  },
  programsDropStderr: {
    file: "kernel/src/addons/programs/index.ts",
    from: "      stderr: stderr.text,",
    to: '      stderr: "",',
  },
  refusalOnStdout: {
    file: "kernel/src/kernel/human.ts",
    from: '  if (result.outcome !== "success")\n    return {\n      stream: "stderr",',
    to: '  if (result.outcome !== "success")\n    return {\n      stream: "stdout",',
  },
} as const satisfies Record<string, KernelFault>;

function faulted(fault: KernelFault): { at: World; entry: string } {
  const at = world();
  const entry = installedCopy(at);
  plantFault(at, fault);
  return { at, entry };
}

async function untrusted(
  at: World,
  entry: string,
  argv: readonly string[],
): Promise<readonly string[]> {
  const ran = await viaKernelFreeCheck(at, argv, { entry });
  expect({ exit: ran.exit, stdout: ran.stdout }).toEqual({
    exit: 70,
    stdout: "",
  });
  return rawFailIds(ran.stderr);
}

describe("kernel faults the check reports", () => {
  test(
    "a healthy copy of the installed kernel is trusted",
    async () => {
      const at = world();
      const entry = installedCopy(at);
      const ran = await viaKernelFreeCheck(at, ["ready", at.example], {
        entry,
      });
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
    },
    watchdog(0, 1),
  );

  const flattening: readonly (readonly [string, KernelFault, string])[] = [
    [
      "a kernel that exits 0 from every process is reported as an exit mismatch",
      kernelFaults.exitsZero,
      "helper-exit-mismatch",
    ],
    [
      "a kernel whose contract throws while it is built is reported as no envelope",
      kernelFaults.contractThrows,
      "helper-no-envelope",
    ],
    [
      "a kernel whose entry cannot be imported is reported as a failed import",
      kernelFaults.entryFails,
      "kernel-import",
    ],
    [
      "a kernel that writes each envelope twice is reported as no envelope",
      kernelFaults.envelopeTwice,
      "helper-no-envelope",
    ],
  ];

  for (const [title, fault, id] of flattening)
    test(
      title,
      async () => {
        const { at, entry } = faulted(fault);
        for (const argv of [
          ["ready", at.example],
          ["sweep", at.example, "--json"],
          ["--help"],
        ])
          expect(await untrusted(at, entry, argv)).toContain(id);
      },
      watchdog(0, 3),
    );

  test(
    "a programs add-on that reports every exit code as 0 is reported as an observation mismatch, launch included",
    async () => {
      const { at, entry } = faulted(kernelFaults.programsExitZero);
      for (const argv of [
        ["ready", at.example],
        ["sweep", at.example],
        ["launch", runFolder(at, "r1"), at.example],
      ])
        expect(await untrusted(at, entry, argv)).toEqual([
          "observation-mismatch",
        ]);
    },
    watchdog(0, 3),
  );

  test(
    "a programs add-on that drops stderr is reported as an observation mismatch, launch included",
    async () => {
      const { at, entry } = faulted(kernelFaults.programsDropStderr);
      for (const argv of [
        ["ready", at.example],
        ["sweep", at.example],
        ["launch", runFolder(at, "r1"), at.example],
      ])
        expect(await untrusted(at, entry, argv)).toEqual([
          "observation-mismatch",
        ]);
    },
    watchdog(0, 3),
  );

  test(
    "a target that answers each run differently is the target's failure, exit 3, not 70",
    async () => {
      const at = world();
      const noisy = join(at.repo, "fixtures", "noisy-cli.ts");
      for (const argv of [
        ["ready", noisy],
        ["launch", runFolder(at, "r1"), noisy],
      ]) {
        const ran = await viaKernelFreeCheck(at, argv);
        expect({
          exit: ran.exit,
          stdout: ran.stdout,
          lines: ran.stderr
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => line.split(":").slice(0, 2).join(":")),
        }).toEqual({
          exit: 3,
          stdout: "",
          lines: [
            "verify-cli: TARGET FAIL target-not-repeatable",
            "verify-cli: TARGET FAIL target-not-repeatable",
          ],
        });
      }
    },
    watchdog(0, 2),
  );

  test(
    "the helper alone cannot see an exit code the kernel flattens",
    async () => {
      const { at } = faulted(kernelFaults.exitsZero);
      const ran = await spawnBounded(
        [
          process.execPath,
          join(
            at.repo,
            "node_modules/agent-cli-kernel/skills/verify-cli/helper/cli.ts",
          ),
          "ready",
          at.example,
        ],
        { cwd: at.repo, env: at.env, boundMilliseconds: helperBound },
      );
      expect(ran.exit).toBe(0);
      expect(ran.stderr).toContain("readiness checks failed");
    },
    watchdog(1),
  );

  test(
    "a refusal on stdout is a finding, not an untrusted run",
    async () => {
      const { at, entry } = faulted(kernelFaults.refusalOnStdout);
      const ran = await viaKernelFreeCheck(
        at,
        ["ready", at.example, "--json"],
        { entry },
      );
      expect({
        exit: ran.exit,
        cause: field(JSON.parse(ran.stdout), "result", "causeCode"),
      }).toEqual({ exit: 3, cause: "DOMAIN_VERIFY_FINDINGS" });
      expect(String(field(JSON.parse(ran.stdout), "message"))).toContain(
        "usage-probe-stdout-empty",
      );
    },
    watchdog(0, 1),
  );

  test(
    "findings shows what sweep refused",
    async () => {
      const { at, entry } = faulted(kernelFaults.refusalOnStdout);
      const swept = await viaKernelFreeCheck(
        at,
        ["sweep", at.example, "--json"],
        { entry },
      );
      expect({
        exit: swept.exit,
        data: field(JSON.parse(swept.stdout), "result", "data"),
      }).toEqual({ exit: 3, data: null });
      const found = await viaKernelFreeCheck(
        at,
        ["findings", at.example, "--json"],
        {
          entry,
        },
      );
      const findings = field(
        JSON.parse(found.stdout),
        "result",
        "data",
        "findings",
      );
      expect(found.exit).toBe(0);
      expect(Array.isArray(findings) ? findings.length : 0).toBe(6);
      expect(field(Array.isArray(findings) ? findings[0] : null, "check")).toBe(
        "unknown-command-stdout-empty",
      );
    },
    watchdog(0, 2),
  );
});

describe("evidence the check confirms", () => {
  async function driven(at: World) {
    const run = runFolder(at, "r1");
    expect(causeOf(await helper(at, ["launch", run, at.example]))).toBe(
      "SUCCESS_COMPLETED",
    );
    expect(
      causeOf(
        await helper(at, ["drive", run, scenarioFile(at, readOnlyScenario)]),
      ),
    ).toBe("SUCCESS_COMPLETED");
    return {
      run,
      file: join(
        run,
        "evidence",
        "read-only-command",
        "show-known-planet.json",
      ),
    };
  }

  test(
    "a missing evidence file cannot be trusted",
    async () => {
      const at = world();
      const { run, file } = await driven(at);
      rmSync(file);
      const ran = await viaKernelFreeCheck(at, ["report", run]);
      expect({
        exit: ran.exit,
        stdout: ran.stdout,
        ids: rawFailIds(ran.stderr),
      }).toEqual({
        exit: 70,
        stdout: "",
        ids: ["evidence-mismatch"],
      });
    },
    watchdog(2, 1),
  );

  test(
    "a changed evidence file cannot be trusted",
    async () => {
      const at = world();
      const { run, file } = await driven(at);
      const bytes = readFileSync(file);
      bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
      writeFileSync(file, bytes);
      const ran = await viaKernelFreeCheck(at, ["report", run, "--json"]);
      expect({
        exit: ran.exit,
        stdout: ran.stdout,
        ids: rawFailIds(ran.stderr),
      }).toEqual({
        exit: 70,
        stdout: "",
        ids: ["evidence-mismatch"],
      });
    },
    watchdog(2, 1),
  );

  test(
    "an evidence file that is a folder or too large is named as such, never read",
    async () => {
      const at = world();
      const { run, file } = await driven(at);
      const place = verificationRun(run);
      rmSync(file);
      mkdirSync(file);
      expect(evidenceFailures(place)).toEqual([
        { id: "evidence-mismatch", detail: `${file} is not a regular file` },
      ]);
      rmSync(file, { recursive: true });
      writeFileSync(file, "");
      truncateSync(file, evidenceBytesLimit + 1);
      expect(evidenceFailures(place)).toEqual([
        {
          id: "evidence-mismatch",
          detail: `${file} is ${String(evidenceBytesLimit + 1)} bytes, over ${String(evidenceBytesLimit)}`,
        },
      ]);
    },
    watchdog(2),
  );

  test(
    "an evidence file swapped for a named pipe does not hold the check",
    async () => {
      const at = world();
      const { run, file } = await driven(at);
      rmSync(file);
      await makeFifo(file);
      const ran = await spawnBounded(
        [process.execPath, checkEntry, "report", run],
        { cwd: at.repo, env: at.env, boundMilliseconds: helperBound },
      );
      expect({ exit: ran.exit, ids: rawFailIds(ran.stderr) }).toEqual({
        exit: 70,
        ids: ["evidence-mismatch"],
      });
    },
    watchdog(3),
  );

  test("each index row's file is confirmed by its hash, and an unlaunched folder has nothing to confirm", () => {
    const at = world();
    const place = verificationRun(runFolder(at, "none"));
    expect(evidenceFailures(place)).toEqual([]);
  });
});

type Call = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly milliseconds: number;
  readonly outputBytes: number | undefined;
};

function fake(answers: (args: readonly string[]) => Partial<Ran>): {
  spawn: Spawn;
  calls: (readonly string[])[];
  made: Call[];
} {
  const calls: (readonly string[])[] = [];
  const made: Call[] = [];
  return {
    calls,
    made,
    spawn: (args, cwd, milliseconds, outputBytes) => {
      calls.push(args);
      made.push({ args, cwd, milliseconds, outputBytes });
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...answers(args),
      });
    },
  };
}

const envelope = (exitCode: number, data: unknown = null) =>
  `${JSON.stringify({ message: "m", result: { exitCode, causeCode: "C", data } })}\n`;

describe("the check's own steps, in process", () => {
  test("an untrusted run writes nothing to stdout", async () => {
    const { spawn } = fake(() => ({ exitCode: 1, stderr: "boom\n" }));
    for (const argv of [
      ["ready", "/t.ts"],
      ["ready", "/t.ts", "--json"],
    ]) {
      const ran = await main(argv, "/", spawn);
      expect(ran.exit).toBe(70);
      expect(ran.writes.map((write) => write.stream)).toEqual([
        "stderr",
        "stderr",
      ]);
      for (const write of ran.writes)
        expect(write.text).toMatch(
          /^verify-cli: RAW FAIL [a-z-]+: .+ Repair: .+\n$/,
        );
    }
  });

  test("the check reports its own failure", async () => {
    const ran = await main(["ready", "/t.ts"], "/", () =>
      Promise.reject(new Error("the spawn broke")),
    );
    expect(ran).toEqual({
      exit: 70,
      writes: [
        {
          stream: "stderr",
          text: failureLine({
            id: "check-internal",
            detail: "the check threw: the spawn broke",
          }),
        },
      ],
    });
  });

  test(
    "the check bounds each child",
    async () => {
      const limits = {
        ...defaultLimits,
        probeMilliseconds: 1,
        graceMilliseconds: 500,
      };
      const ran = await main(
        ["--help"],
        "/",
        bunSpawn(process.env, limits),
        limits,
      );
      expect(ran.exit).toBe(70);
      expect(
        rawFailIds(ran.writes.map((write) => write.text).join("")),
      ).toContain("child-timeout");
    },
    watchdog(1),
  );

  test(
    "a child that ignores SIGTERM is killed when the grace runs out",
    async () => {
      const at = world();
      const ledger = join(at.folder, "stubborn-ledger");
      const limits = { ...defaultLimits, graceMilliseconds: 300 };
      const started = performance.now();
      const ran = await bunSpawn(at.env, limits)(
        [join(fixtures, "stubborn-cli.ts"), ledger],
        fixtures,
        1_000,
      );
      const elapsed = performance.now() - started;
      expect({
        timedOut: ran.timedOut,
        exitCode: ran.exitCode,
        signal: ran.signal,
        ledger: readFileSync(ledger, "utf8"),
      }).toEqual({
        timedOut: true,
        exitCode: null,
        signal: "SIGKILL",
        ledger: "listening\nsigterm\n",
      });
      expect(elapsed).toBeGreaterThanOrEqual(1_300);
      expect(elapsed).toBeLessThan(2_500);
    },
    watchdog(1),
  );

  test("the kernel import runs in a child from the skill folder, and its failure names the import", async () => {
    const { spawn, calls } = fake(() => ({
      exitCode: 1,
      stderr: "\nerror: Cannot find package\n",
    }));
    expect(await kernelImport(spawn, "/skill", defaultLimits)).toEqual([
      {
        id: "kernel-import",
        detail:
          "importing agent-cli-kernel from /skill exited 1: error: Cannot find package",
      },
    ]);
    expect(calls).toEqual([
      ["--no-install", "-e", 'await import("agent-cli-kernel");'],
    ]);
    expect(
      await kernelImport(fake(() => ({})).spawn, "/skill", defaultLimits),
    ).toEqual([]);
  });

  test("the helper's probe needs one envelope, the process's exit code in it, and exit 2", async () => {
    const answer = (exitCode: number, stdout: string) =>
      helperProbe(fake(() => ({ exitCode, stdout })).spawn, "/", defaultLimits);
    expect(await answer(2, envelope(2))).toEqual([]);
    expect((await answer(2, "")).map((failure) => failure.id)).toEqual([
      "helper-no-envelope",
    ]);
    expect(
      (await answer(2, envelope(2) + envelope(2))).map((failure) => failure.id),
    ).toEqual(["helper-no-envelope"]);
    expect((await answer(0, envelope(2))).map((failure) => failure.id)).toEqual(
      ["helper-exit-mismatch"],
    );
    expect((await answer(1, envelope(1))).map((failure) => failure.id)).toEqual(
      ["helper-usage-exit"],
    );
  });

  test("an observation is compared on its exit code, its stdout byte count and hash, and its stderr hash", () => {
    const raw = {
      argv: ["x"],
      exitCode: 2,
      stdoutBytes: 0,
      stdoutSha256: "c",
      stderrSha256: "a",
    };
    expect(compared(raw, raw)).toEqual([]);
    expect(compared({ ...raw, exitCode: 0 }, raw)).toEqual([
      {
        id: "observation-mismatch",
        detail: 'for ["x"] the helper saw exit code 0, and a raw run saw 2.',
      },
    ]);
    expect(compared({ ...raw, stdoutBytes: 3 }, raw)).toEqual([
      {
        id: "observation-mismatch",
        detail:
          'for ["x"] the helper saw stdout byte count 3, and a raw run saw 0.',
      },
    ]);
    expect(compared({ ...raw, stdoutSha256: "d" }, raw)).toEqual([
      {
        id: "observation-mismatch",
        detail: 'for ["x"] the helper saw stdout hash d, and a raw run saw c.',
      },
    ]);
    expect(compared({ ...raw, stderrSha256: "b" }, raw)).toEqual([
      {
        id: "observation-mismatch",
        detail: 'for ["x"] the helper saw stderr hash b, and a raw run saw a.',
      },
    ]);
    expect(compared(undefined, raw).map((failure) => failure.id)).toEqual([
      "observation-mismatch",
    ]);
  });

  test("a probe's stdout is hashed without the run id each run draws, and with every other byte", () => {
    const line = (runId: string, moons: number) =>
      `{"result":{"runId":"${runId}","data":{"moons":${String(moons)}}}}\n`;
    const first = probeResult([], {
      exitCode: 0,
      stdout: line("91d19276-8b8b-43e8-9995-fcf3696fcf12", 2),
      stderr: "",
    });
    const second = probeResult([], {
      exitCode: 0,
      stdout: line("e83ba2da-1b47-4d44-a97f-fb39399094d2", 2),
      stderr: "",
    });
    const altered = probeResult([], {
      exitCode: 0,
      stdout: line("e83ba2da-1b47-4d44-a97f-fb39399094d2", 3),
      stderr: "",
    });
    expect(first.stdoutSha256).toBe(second.stdoutSha256);
    expect(altered.stdoutBytes).toBe(first.stdoutBytes);
    expect(altered.stdoutSha256).not.toBe(first.stdoutSha256);
  });

  test("the helper's probe is compared with raw runs of the same two probes", async () => {
    const seen = [
      {
        argv: ["--verify-cli-undeclared-option"],
        exitCode: 2,
        stdoutBytes: 0,
        stdoutSha256: sha256(""),
      },
      {
        argv: ["--discover", "--json"],
        exitCode: 0,
        stdoutBytes: 2,
        stdoutSha256: sha256("{}"),
      },
    ];
    const { spawn, calls } = fake((args) => {
      if (args.includes("probe"))
        return {
          stdout: envelope(0, {
            probes: seen.map((entry) => ({
              ...entry,
              stderrSha256:
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            })),
          }),
        };
      return args.includes("--discover")
        ? { exitCode: 0, stdout: "{}" }
        : { exitCode: 2, stdout: "" };
    });
    expect(await probeFailures(spawn, "/t.ts", "/", defaultLimits)).toEqual([]);
    expect(calls.slice(1)).toEqual([
      ["--no-install", "/t.ts", "--verify-cli-undeclared-option"],
      ["--no-install", "/t.ts", "--discover", "--json"],
    ]);
  });

  test("the raw runs take the helper's own limits, and the helper starts in the repository root", async () => {
    const { spawn, made } = fake((args) => {
      if (args.includes("-e")) return {};
      return args.includes("probe")
        ? { stdout: envelope(0, { probes: [] }) }
        : { exitCode: 2, stdout: envelope(2) };
    });
    await kernelFreeCheck(["ready", join(fixtures, "liar-cli.ts")], "/", spawn);
    const raw = made.filter(
      (call) => call.args[1] === join(fixtures, "liar-cli.ts"),
    );
    expect(raw.length).toBeGreaterThan(0);
    expect(
      new Set(
        raw.map((call) => [call.milliseconds, call.outputBytes].join(" ")),
      ),
    ).toEqual(
      new Set([
        [targetLimits.timeoutMilliseconds, targetLimits.outputLimitBytes].join(
          " ",
        ),
      ]),
    );
    expect(new Set(made.slice(1).map((call) => call.cwd))).toEqual(
      new Set([repository]),
    );
  });

  test("a mismatch is probed once more: steady sides that differ blame the kernel, and a side that changes blames the target", async () => {
    const empty =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const helperSaw = (stderrSha256: string) =>
      envelope(0, {
        probes: [
          {
            argv: ["--verify-cli-undeclared-option"],
            exitCode: 2,
            stdoutBytes: 0,
            stdoutSha256: empty,
            stderrSha256,
          },
          {
            argv: ["--discover", "--json"],
            exitCode: 0,
            stdoutBytes: 0,
            stdoutSha256: empty,
            stderrSha256: empty,
          },
        ],
      });
    let runs = 0;
    const changing = fake((args) => {
      if (args.includes("probe")) return { stdout: helperSaw(empty) };
      runs += 1;
      return args.includes("--discover")
        ? { exitCode: 0 }
        : { exitCode: 2, stderr: `run ${String(runs)}\n` };
    });
    expect(
      (await probeFailures(changing.spawn, "/t.ts", "/", defaultLimits)).map(
        (failure) => failure.id,
      ),
    ).toEqual(["target-not-repeatable"]);
    expect(changing.calls).toHaveLength(6);
    const steady = fake((args) =>
      args.includes("probe")
        ? { stdout: helperSaw(empty) }
        : args.includes("--discover")
          ? { exitCode: 0 }
          : { exitCode: 2, stderr: "same\n" },
    );
    expect(
      (await probeFailures(steady.spawn, "/t.ts", "/", defaultLimits)).map(
        (failure) => failure.id,
      ),
    ).toEqual(["observation-mismatch"]);
    const stopped = fake((args) =>
      args.includes("probe")
        ? { stdout: helperSaw(empty) }
        : { exitCode: null, timedOut: true, stdout: "" },
    );
    expect(
      (await probeFailures(stopped.spawn, "/t.ts", "/", defaultLimits)).map(
        (failure) => failure.id,
      ),
    ).toEqual(["observation-mismatch", "observation-mismatch"]);
  });

  test("a target that runs past the helper's own limit on a probe is the helper's to judge, not a timeout of the check", async () => {
    const empty =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const stopped = {
      exitCode: null,
      stdoutBytes: 0,
      stdoutSha256: empty,
      stderrSha256: empty,
    };
    const { spawn } = fake((args) =>
      args.includes("probe")
        ? {
            stdout: envelope(0, {
              probes: [
                { argv: ["--verify-cli-undeclared-option"], ...stopped },
                { argv: ["--discover", "--json"], ...stopped },
              ],
            }),
          }
        : { exitCode: null, signal: "SIGTERM", timedOut: true },
    );
    expect(await probeFailures(spawn, "/t.ts", "/", defaultLimits)).toEqual([]);
  });

  test("a target that is not repeatable exits 3, and any other failure with it exits 70", () => {
    const line = (id: FailureId) => failureLine({ id, detail: "d." });
    expect(line("target-not-repeatable")).toMatch(
      /^verify-cli: TARGET FAIL target-not-repeatable: d\. Repair: .+\n$/,
    );
    expect(untrustedExit([{ id: "target-not-repeatable", detail: "" }])).toBe(
      3,
    );
    expect(
      untrustedExit([
        { id: "target-not-repeatable", detail: "" },
        { id: "observation-mismatch", detail: "" },
      ]),
    ).toBe(70);
  });

  test("a probe observation without its byte count is no observation", async () => {
    const { spawn } = fake((args) =>
      args.includes("probe")
        ? {
            stdout: envelope(0, {
              probes: [
                {
                  argv: ["--verify-cli-undeclared-option"],
                  exitCode: 2,
                  stderrSha256: "a",
                },
              ],
            }),
          }
        : { exitCode: 2 },
    );
    const failures = await probeFailures(spawn, "/t.ts", "/", defaultLimits);
    expect(failures[0]).toEqual({
      id: "observation-mismatch",
      detail:
        'the helper\'s probe returned no observation for ["--verify-cli-undeclared-option"].',
    });
  });

  test("an envelope is one line whose exit code is the process's", () => {
    const ok = {
      exitCode: 0,
      signal: null,
      stdout: envelope(0),
      stderr: "",
      timedOut: false,
    };
    expect(envelopeFailures(ok, "x").failures).toEqual([]);
    expect(
      envelopeFailures({ ...ok, stdout: envelope(3) }, "x").failures.map(
        (failure) => failure.id,
      ),
    ).toEqual(["helper-exit-mismatch"]);
    expect(
      envelopeFailures({ ...ok, stdout: `${envelope(0)}${envelope(0)}` }, "x")
        .failures,
    ).toEqual([
      {
        id: "helper-no-envelope",
        detail: "x exited 0 without exactly one envelope on stdout. stderr: ",
      },
    ]);
  });

  test("each path argument of a known command is made absolute, and other words are kept", () => {
    expect(absoluteArgv(["drive", "run", "s.json", "--json"], "/w")).toEqual([
      "drive",
      "/w/run",
      "/w/s.json",
      "--json",
    ]);
    expect(absoluteArgv(["ready", "/abs/cli.ts"], "/w")).toEqual([
      "ready",
      "/abs/cli.ts",
    ]);
    expect(absoluteArgv(["--help", "x"], "/w")).toEqual(["--help", "x"]);
  });

  test("the helper's result is relayed as its envelope, its message and data, or its message on stderr", () => {
    const ran = (exitCode: number, data: unknown) => ({
      exitCode,
      signal: null,
      stdout: `${JSON.stringify({ message: "Said.", result: { exitCode, data } })}\n`,
      stderr: "",
      timedOut: false,
    });
    expect(relayed(ran(0, { a: 1 }), true)).toEqual({
      stream: "stdout",
      text: ran(0, { a: 1 }).stdout,
    });
    expect(relayed(ran(0, { a: 1 }), false)).toEqual({
      stream: "stdout",
      text: 'Said.\n{\n  "a": 1\n}\n',
    });
    expect(relayed(ran(0, null), false)).toEqual({
      stream: "stdout",
      text: "Said.\n",
    });
    expect(relayed(ran(3, null), false)).toEqual({
      stream: "stderr",
      text: "Said.\n",
    });
  });

  test("a run that passed its limit is a child-timeout, and one that ended is not", () => {
    const ran = {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    };
    expect(timeoutFailure(ran, "a probe", 5)).toEqual([
      {
        id: "child-timeout",
        detail: "a probe ran past its limit of 5 ms and was stopped.",
      },
    ]);
    expect(timeoutFailure({ ...ran, timedOut: false }, "a probe", 5)).toEqual(
      [],
    );
    expect(stopExit()).toBeUndefined();
  });

  test(
    "the repository root and target come from the target, or from the run's index",
    async () => {
      const at = world();
      expect(bound(["ready", at.example])).toEqual({
        root: at.repo,
        target: at.example,
        run: undefined,
      });
      const run = runFolder(at, "r1");
      expect(bound(["launch", run, at.example])).toEqual({
        root: at.repo,
        target: at.example,
        run: undefined,
      });
      expect(bound(["report", run])).toEqual({
        root: undefined,
        target: undefined,
        run: undefined,
      });
      expect(causeOf(await helper(at, ["launch", run, at.example]))).toBe(
        "SUCCESS_COMPLETED",
      );
      expect(bound(["report", run])).toEqual({
        root: at.repo,
        target: at.example,
        run: verificationRun(run),
      });
      expect(bound(["cleanup", run]).target).toBeUndefined();
      expect(bound(["--help"])).toEqual({
        root: undefined,
        target: undefined,
        run: undefined,
      });
    },
    watchdog(1),
  );

  test("a trusted run passes the helper's answer on, and asks the helper for its envelope", async () => {
    const { spawn, calls } = fake((args) =>
      args.includes("verify-cli-undeclared-command")
        ? { exitCode: 2, stdout: envelope(2) }
        : { exitCode: 0, stdout: envelope(0) },
    );
    const checked = await kernelFreeCheck(["--help", "--json"], "/w", spawn);
    expect(checked.kind).toBe("trusted");
    expect(calls.at(-1)?.slice(-2)).toEqual(["--help", "--json"]);
    expect(calls).toHaveLength(3);
  });
});
