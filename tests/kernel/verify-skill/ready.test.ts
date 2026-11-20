import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  quotedLine,
  readiness,
  toolchainBun,
} from "../../../skills/verify-cli/helper/ready.ts";
import {
  causeOf,
  viaKernelFreeCheck,
  envelopeIn,
  field,
  fixture,
  helper,
  helperAlone,
  releaseWorlds,
  watchdog,
  world,
  writePackage,
} from "./harness.ts";

afterAll(releaseWorlds);

describe("ready", () => {
  test(
    "ready passes the author guide's example",
    async () => {
      const at = world();
      const plain = await viaKernelFreeCheck(at, ["ready", at.example]);
      expect(plain).toMatchObject({
        exit: 0,
        stderr: "",
      });
      expect(plain.stdout.split("\n")[0]).toBe(
        "The target is ready: 8 readiness checks passed.",
      );
      const json = await viaKernelFreeCheck(at, [
        "ready",
        at.example,
        "--json",
      ]);
      expect(field(envelopeIn(json), "result", "data")).toEqual({
        contractVersion: "3.0.0",
        commands: [
          { commandIdentity: "moons.list", effectClass: "inspect" },
          { commandIdentity: "moons.show", effectClass: "inspect" },
        ],
      });
    },
    watchdog(0, 2),
  );

  test(
    "ready refuses a target that selects approval without state and quotes the kernel's sentence",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(at, [
        "ready",
        fixture(at, "approval-cli.ts"),
        "--json",
      ]);
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      expect(ran.stdout.split("\n")).toHaveLength(2);
      const envelope = envelopeIn(ran);
      expect(field(envelope, "result", "causeCode")).toBe(
        "DOMAIN_VERIFY_TARGET_START",
      );
      expect(String(field(envelope, "message"))).toContain(
        "Approval requires the state add-on",
      );
    },
    watchdog(0, 1),
  );

  test(
    "ready refuses a target that throws at start and quotes its error",
    async () => {
      const at = world();
      const ran = await helper(at, ["ready", fixture(at, "throwing-cli.ts")]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_TARGET_START",
      });
      expect(String(field(JSON.parse(ran.stdout), "message"))).toBe(
        "The target did not start: its usage probe exited 1, and its discovery probe wrote no envelope. Its first error: error: The target's own start-up failed before its kernel ran.",
      );
    },
    watchdog(1),
  );

  test(
    "ready refuses a missing entry file as a target that did not start",
    async () => {
      const at = world();
      const ran = await helper(at, ["ready", join(at.repo, "src", "gone.ts")]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_TARGET_START",
      });
    },
    watchdog(1),
  );

  test(
    "ready names a Bun that is not the toolchain pin",
    async () => {
      const at = world();
      writePackage(at.repo, { packageManager: "bun@0.0.1" });
      const ran = await helper(at, ["ready", at.example]);
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: field(JSON.parse(ran.stdout), "message"),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_FINDINGS",
        message: "1 of 8 readiness checks failed: bun-matches-toolchain-pin.",
      });
    },
    watchdog(1),
  );

  test(
    "each step starts in the repository root",
    async () => {
      const at = world();
      const ran = await viaKernelFreeCheck(
        at,
        ["ready", join("..", "fixtures", "relative-cli.ts")],
        { cwd: join(at.repo, "src") },
      );
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
    },
    watchdog(0, 1),
  );

  test(
    "the helper's own input takes an absolute target path only",
    async () => {
      const at = world();
      const ran = await helperAlone(at, ["ready", "src/cli.ts"]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 2,
        cause: "USAGE_INVALID_INVOCATION",
      });
    },
    watchdog(1),
  );
});

describe("how ready judges its two probes", () => {
  const usage = {
    exitCode: 2,
    stdout: "",
    stderr:
      "moons: No declared command matches this invocation. [USAGE_UNKNOWN_COMMAND]\n",
  };
  const discovery = {
    exitCode: 0,
    stdout: `${JSON.stringify({
      contractVersion: "3.0.0",
      result: {
        exitCode: 0,
        data: {
          commands: [
            {
              commandIdentity: "moons.help",
              route: ["--help"],
              effectClass: "inspect",
            },
            {
              commandIdentity: "moons.list",
              route: ["list"],
              effectClass: "inspect",
            },
          ],
        },
      },
    })}\n`,
    stderr: "",
  };

  test("a sound target passes all eight checks", () => {
    expect(
      readiness(
        usage,
        discovery,
        { kind: "pinned", version: "1.4.4" },
        "1.4.4",
      ),
    ).toMatchObject({
      kind: "judged",
      failed: [],
      contractVersion: "3.0.0",
    });
  });

  test("a target that answered neither probe did not start, and its message quotes the first error line", () => {
    expect(
      readiness(
        { exitCode: 1, stdout: "", stderr: "trace\nerror: boom\nmore\n" },
        { exitCode: 1, stdout: "", stderr: "" },
        { kind: "none" },
        "1.4.4",
      ),
    ).toEqual({
      kind: "not-started",
      message:
        "The target did not start: its usage probe exited 1, and its discovery probe wrote no envelope. Its first error: error: boom",
    });
  });

  test("a target that answered only one probe started, and its failed checks are findings", () => {
    expect(
      readiness(
        usage,
        { exitCode: 1, stdout: "", stderr: "" },
        { kind: "none" },
        "1.4.4",
      ),
    ).toMatchObject({
      kind: "judged",
      failed: [
        "discovery-exit",
        "discovery-one-envelope",
        "discovery-lists-a-command",
      ],
    });
  });

  test("ready cuts a quoted error line at 300 characters", () => {
    const kept = `error: ${"x".repeat(293)}`;
    expect(kept).toHaveLength(300);
    expect(quotedLine(`${kept}\n`)).toBe(kept);
    expect(quotedLine(`${kept}y\n`)).toBe(kept);
  });

  test("the quoted line is the first error line, else the first line that is not empty", () => {
    expect(quotedLine("\n  \nfirst\nerror: second\n")).toBe("error: second");
    expect(quotedLine("\n  \nfirst\nsecond\n")).toBe("first");
    expect(quotedLine("")).toBe("");
  });

  test("the toolchain pin is read from packageManager, no field pins nothing, and an unreadable package.json fails the check", () => {
    const at = world();
    expect(toolchainBun(at.repo)).toEqual({
      kind: "pinned",
      version: Bun.version,
    });
    writePackage(at.repo, { packageManager: undefined });
    expect(toolchainBun(at.repo)).toEqual({ kind: "none" });
    expect(toolchainBun(undefined)).toEqual({ kind: "none" });
    writeFileSync(join(at.repo, "package.json"), "{ not json");
    const unreadable = toolchainBun(at.repo);
    expect(unreadable.kind).toBe("unreadable");
    expect(readiness(usage, discovery, unreadable, Bun.version)).toMatchObject({
      failed: ["bun-matches-toolchain-pin"],
    });
  });
});
