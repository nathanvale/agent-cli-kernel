import { afterAll, describe, expect, test } from "bun:test";
import { sweep } from "../../../skills/verify-cli/helper/sweep.ts";
import {
  kernelAdded,
  ownCommands,
} from "../../../skills/verify-cli/helper/target.ts";
import {
  causeOf,
  viaKernelFreeCheck,
  envelopeIn,
  field,
  fixture,
  helper,
  releaseWorlds,
  watchdog,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

const readyChecks = [
  "usage-probe-exit",
  "usage-probe-stdout-empty",
  "usage-probe-one-stderr-line",
  "discovery-exit",
  "discovery-stderr-empty",
  "discovery-one-envelope",
  "discovery-lists-a-command",
] as const;

const sweepChecks = [
  "help-exit",
  "help-stderr-empty",
  "help-usage-line",
  "unknown-command-exit",
  "unknown-command-stdout-empty",
  "unknown-command-stderr-one-line-with-cause",
  "discovery-exit",
  "discovery-stderr-empty",
  "discovery-one-envelope",
  "discovery-lists-a-command",
  "command-discovery-exit",
  "command-discovery-one-envelope",
  "usage-exit",
  "usage-json-stderr-empty",
  "usage-envelope-exit-equals-process-exit",
  "usage-cause-is-declared",
  "usage-cause-is-invalid-invocation",
  "usage-human-exit",
  "usage-human-stdout-empty",
  "usage-human-stderr-one-line-with-cause",
  "command-help-exit",
  "run-json-stderr-empty",
  "run-envelope-exit-equals-process-exit",
  "run-cause-is-declared",
  "run-names-its-command",
] as const;

function lying(at: World, lie: string) {
  return { ...at.env, VERIFY_LIE: lie };
}

describe("sweep", () => {
  test(
    "sweep passes the author guide's example and counts its checks",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(at, ["sweep", at.example]);
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(ran.stdout.split("\n")[0]).toBe(
        "36 checks passed. Stations owed: 2.",
      );
    },
    watchdog(0, 1),
  );

  test(
    "sweep owes the two stations of show that need input",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(at, ["sweep", at.example, "--json"]);
      expect(field(envelopeIn(ran), "result", "data", "owed")).toEqual([
        { command: "moons.show", cause: "SUCCESS_UNCHANGED" },
        { command: "moons.show", cause: "DOMAIN_MOONS_UNKNOWN_PLANET" },
      ]);
    },
    watchdog(0, 1),
  );

  test(
    "sweep treats a command with an empty route as a host command",
    async () => {
      const at = world();
      const ran = await helper(at, [
        "sweep",
        fixture(at, "empty-route-cli.ts"),
      ]);
      expect({
        exit: ran.exit,
        message: field(JSON.parse(ran.stdout), "message"),
        owed: field(ran.result, "data", "owed"),
      }).toEqual({
        exit: 0,
        message: "18 checks passed. Stations owed: 1.",
        owed: [{ command: "greeter.greet", cause: "SUCCESS_UNCHANGED" }],
      });
    },
    watchdog(1),
  );

  test(
    "the liar fixture passes ready and sweep when it tells no lie",
    async () => {
      const at = world();
      const liar = fixture(at, "liar-cli.ts");
      expect(causeOf(await helper(at, ["ready", liar]))).toBe(
        "SUCCESS_UNCHANGED",
      );
      expect(causeOf(await helper(at, ["sweep", liar]))).toBe(
        "SUCCESS_UNCHANGED",
      );
    },
    watchdog(2),
  );

  for (const id of readyChecks)
    test(
      `each check goes red on a CLI that breaks it: ready's ${id}`,
      async () => {
        const at = world();
        const ran = await helper(
          at,
          ["ready", fixture(at, "liar-cli.ts")],
          lying(at, id),
        );
        expect({
          exit: ran.exit,
          cause: causeOf(ran),
          message: field(JSON.parse(ran.stdout), "message"),
        }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_FINDINGS",
          message: `1 of 8 readiness checks failed: ${id}.`,
        });
      },
      watchdog(1),
    );

  for (const id of sweepChecks)
    test(
      `each check goes red on a CLI that breaks it: sweep's ${id}`,
      async () => {
        const at = world();
        const liar = fixture(at, "liar-cli.ts");
        const swept = await helper(at, ["sweep", liar], lying(at, id));
        expect({ exit: swept.exit, cause: causeOf(swept) }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_FINDINGS",
        });
        const found = await helper(at, ["findings", liar], lying(at, id));
        expect({
          exit: found.exit,
          checks: field(found.result, "data", "findings"),
        }).toEqual({
          exit: 0,
          checks: [expect.objectContaining({ check: id })],
        });
      },
      watchdog(2),
    );
});

describe("which commands and stations the sweep counts", () => {
  const discovery = (commands: unknown[]) => ({
    result: { data: { commands } },
  });
  const command = (identity: string, route: string[]) => ({
    commandIdentity: identity,
    route,
    effectClass: "inspect",
  });

  test("a host command is told apart from the kernel's four by its identity, not its route", () => {
    expect(
      ownCommands(
        discovery([
          command("tool.help", ["--help"]),
          command("tool.discovery", ["--discover"]),
          command("tool.command-discovery", ["--discover-command"]),
          command("tool.dispatch", []),
          command("tool.run", []),
          command("tool.list", ["list"]),
        ]),
      ),
    ).toEqual({
      cli: "tool",
      own: [
        { identity: "tool.run", route: [], effectClass: "inspect" },
        { identity: "tool.list", route: ["list"], effectClass: "inspect" },
      ],
    });
  });

  test("discovery with no help command names no CLI and no host command", () => {
    expect(ownCommands(discovery([command("tool.list", ["list"])]))).toEqual({
      cli: null,
      own: [],
    });
  });

  test("a station the kernel adds has the trigger Kernel and its cause code, exactly", () => {
    expect(
      kernelAdded(
        "USAGE_INVALID_INVOCATION",
        "Kernel USAGE_INVALID_INVOCATION.",
      ),
    ).toBe(true);
    expect(kernelAdded("SUCCESS_UNCHANGED", "Kernel decides.")).toBe(false);
    expect(
      kernelAdded("SUCCESS_UNCHANGED", "List the planets this CLI knows."),
    ).toBe(false);
  });

  test("the sweep counts ten checks on a CLI with no host command, and owes nothing", async () => {
    const answers = new Map<
      string,
      { exitCode: number; stdout: string; stderr: string }
    >([
      ["--help", { exitCode: 0, stdout: "Usage: x\n", stderr: "" }],
      [
        "verify-cli-no-such-command",
        {
          exitCode: 2,
          stdout: "",
          stderr: "x: none [USAGE_UNKNOWN_COMMAND]\n",
        },
      ],
    ]);
    const found = await sweep((argv) =>
      Promise.resolve(
        answers.get(argv[0] ?? "") ?? { exitCode: 0, stdout: "", stderr: "" },
      ),
    );
    expect({
      checks: found.checks,
      failed: found.findings.map((entry) => entry.check),
      owed: found.owed,
    }).toEqual({
      checks: 10,
      failed: ["discovery-one-envelope", "discovery-lists-a-command"],
      owed: [],
    });
  });

  test("a station is swept only when every check on its run passed", async () => {
    const envelope = (result: object) =>
      `${JSON.stringify({ contractVersion: "3.0.0", result: { commandIdentity: "x.go", causeCode: "SUCCESS_UNCHANGED", ...result } })}\n`;
    const required = (causeCode: string) => ({
      causeCode,
      reachability: "required",
      trigger: "The host's own.",
    });
    const answers = new Map([
      [
        "--discover --json",
        envelope({
          exitCode: 0,
          data: {
            commands: [
              {
                commandIdentity: "x.help",
                route: ["--help"],
                effectClass: "inspect",
              },
              {
                commandIdentity: "x.go",
                route: ["go"],
                effectClass: "inspect",
              },
            ],
          },
        }),
      ],
      [
        "--discover-command x.go --json",
        envelope({
          exitCode: 0,
          data: {
            input: { arguments: [], options: [] },
            stations: [
              required("SUCCESS_UNCHANGED"),
              required("USAGE_INVALID_INVOCATION"),
            ],
          },
        }),
      ],
      [
        "go --verify-cli-undeclared-option --json",
        envelope({ exitCode: 2, causeCode: "USAGE_INVALID_INVOCATION" }),
      ],
      [
        "go --json",
        envelope({
          exitCode: 0,
          causeCode: "SUCCESS_UNCHANGED",
          commandIdentity: "x.other",
        }),
      ],
    ]);
    const exits = new Map([
      ["verify-cli-no-such-command", 2],
      ["go --verify-cli-undeclared-option --json", 2],
      ["go --verify-cli-undeclared-option", 2],
    ]);
    const found = await sweep((argv) => {
      const key = argv.join(" ");
      return Promise.resolve({
        exitCode: exits.get(key) ?? 0,
        stdout:
          answers.get(key) ?? (key.endsWith("--help") ? "Usage: x\n" : ""),
        stderr: key.endsWith("--verify-cli-undeclared-option")
          ? "x: bad [USAGE_INVALID_INVOCATION]\n"
          : key === "verify-cli-no-such-command"
            ? "x: no [USAGE_UNKNOWN_COMMAND]\n"
            : "",
      });
    });
    expect({
      failed: found.findings.map((entry) => entry.check),
      swept: found.swept.map((entry) => entry.cause),
      owed: found.owed.map((entry) => entry.cause),
    }).toEqual({
      failed: ["run-names-its-command"],
      swept: ["USAGE_INVALID_INVOCATION"],
      owed: ["SUCCESS_UNCHANGED"],
    });
  });
});
