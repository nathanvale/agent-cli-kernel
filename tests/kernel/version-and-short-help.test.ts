import { describe, expect, test } from "bun:test";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { CauseTable, InputSchema } from "../../kernel/src/kernel/index.ts";
import { renderHuman } from "../../kernel/src/kernel/human.ts";
import { runInProcessOn } from "../../kernel/src/kernel/lifecycle.ts";
import { createStateAddon } from "../../kernel/src/kernel/state-seam.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput, stationWords, unchanged } from "./kernel-repair/shapes.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const itemInput = {
  ...emptyInput,
  arguments: [
    {
      name: "item",
      summary: "Item.",
      required: false,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 32,
        choices: null,
        pattern: null,
      },
    },
  ],
} as const satisfies InputSchema;

function echoCommand(cli: string) {
  return command({
    identity: `${cli}.echo`,
    route: ["echo"],
    summary: "Echo one item.",
    input: itemInput,
    capabilities: {},
    run: (input, context) =>
      context.result(
        {
          commandIdentity: `${cli}.echo`,
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        {
          message: "Echoed.",
          data: { item: input.item ?? null },
          effects: unchanged,
        },
      ),
  });
}

function makeContract(version?: string) {
  return contractFor({
    cli: "tool",
    ...(version === undefined ? {} : { version }),
    commands: [echoCommand("tool")],
  });
}

async function runEnvelope(contract: object, argv: readonly string[]) {
  const result = await runInProcessOn(
    contract,
    {},
    () => recordingHost().host,
  )(argv);
  if (result.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${result.kind}.`);
  return result;
}

function humanStdout(cli: string, envelope: Parameters<typeof renderHuman>[1]) {
  return renderHuman(cli, envelope)
    .filter((entry) => entry.stream === "stdout")
    .map((entry) => entry.text)
    .join("");
}

function withoutRunId(envelope: Parameters<typeof renderHuman>[1]) {
  const { runId: _runId, ...restResult } = envelope.result;
  void _runId;
  return { ...envelope, result: restResult };
}

describe("-h short help spelling", () => {
  test("-h --json matches --help --json in identity, data and exit code", async () => {
    const contract = makeContract("1.2.3");
    const short = await runEnvelope(contract, ["-h", "--json"]);
    const long = await runEnvelope(contract, ["--help", "--json"]);
    expect(short.exitCode).toBe(0);
    expect(short.envelope.result.commandIdentity).toBe("tool.help");
    expect(withoutRunId(short.envelope)).toEqual(withoutRunId(long.envelope));
    expect((await contract.validate(short.envelope)).ok).toBe(true);
  });

  test("-h human stdout matches --help human stdout", async () => {
    const contract = makeContract("1.2.3");
    const short = await runEnvelope(contract, ["-h"]);
    const long = await runEnvelope(contract, ["--help"]);
    expect(short.exitCode).toBe(0);
    expect(humanStdout("tool", short.envelope)).toBe(
      humanStdout("tool", long.envelope),
    );
  });

  test("<command> -h matches <command> --help", async () => {
    const contract = makeContract("1.2.3");
    const short = await runEnvelope(contract, ["echo", "-h", "--json"]);
    const long = await runEnvelope(contract, ["echo", "--help", "--json"]);
    expect(short.exitCode).toBe(0);
    expect(short.envelope.result.commandIdentity).toBe(
      "tool.command-discovery",
    );
    expect(withoutRunId(short.envelope)).toEqual(withoutRunId(long.envelope));
  });

  test("-- -h passes -h as an argument after --, not help", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["echo", "--json", "--", "-h"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.result.commandIdentity).toBe("tool.echo");
    expect(ran.envelope.result.data).toEqual({ item: "-h" });

    const bare = await runEnvelope(contract, ["--json", "--", "-h"]);
    expect(bare.exitCode).toBe(2);
    expect(bare.envelope.result.commandIdentity).toBe("tool.dispatch");
    expect(bare.envelope.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
  });
});

describe("--version built-in route", () => {
  test("--version --json with declared version returns cli and version", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["--version", "--json"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.message).toBe("Version of this CLI.");
    expect(ran.envelope.result.commandIdentity).toBe("tool.version");
    expect(ran.envelope.result.effectClass).toBe("inspect");
    expect(ran.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(ran.envelope.result.data).toEqual({
      cli: "tool",
      version: "1.2.3",
    });
    expect((await contract.validate(ran.envelope)).ok).toBe(true);
  });

  test("--version --json with no declared version returns null version", async () => {
    const contract = makeContract();
    const ran = await runEnvelope(contract, ["--version", "--json"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.result.commandIdentity).toBe("tool.version");
    expect(ran.envelope.result.data).toEqual({
      cli: "tool",
      version: null,
    });
    expect((await contract.validate(ran.envelope)).ok).toBe(true);
  });

  test("--version human output prints declared version or undeclared wording with kernel contract version", async () => {
    const declared = makeContract("1.2.3");
    const withVersion = await runEnvelope(declared, ["--version"]);
    expect(withVersion.exitCode).toBe(0);
    expect(humanStdout("tool", withVersion.envelope)).toBe(
      "tool 1.2.3 (kernel contract 3.0.0)\n",
    );

    const undeclared = makeContract();
    const withoutVersion = await runEnvelope(undeclared, ["--version"]);
    expect(withoutVersion.exitCode).toBe(0);
    expect(humanStdout("tool", withoutVersion.envelope)).toBe(
      "tool version not declared (kernel contract 3.0.0)\n",
    );
  });

  test("--discover --json lists <cli>.version once", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["--discover", "--json"]);
    expect(ran.exitCode).toBe(0);
    const data = ran.envelope.result.data;
    const rawCommands: unknown =
      typeof data === "object" &&
      data !== null &&
      Object.hasOwn(data, "commands")
        ? Reflect.get(data, "commands")
        : undefined;
    const commands = Array.isArray(rawCommands) ? rawCommands : [];
    const versionEntries = commands.filter(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        Object.hasOwn(entry, "commandIdentity") &&
        Reflect.get(entry, "commandIdentity") === "tool.version",
    );
    expect(versionEntries).toEqual([
      {
        commandIdentity: "tool.version",
        route: ["--version"],
        summary: "Show the version.",
        effectClass: "inspect",
      },
    ]);
  });

  test("validator checks --version data by exact projection", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["--version", "--json"]);
    expect((await contract.validate(ran.envelope)).ok).toBe(true);
    const invalidData = [
      null,
      { cli: "tool", version: null },
      { cli: "tool", version: "9.9.9" },
      { cli: "other", version: "1.2.3" },
      { cli: "tool", version: "1.2.3", extra: true },
      { cli: "tool" },
    ];
    for (const data of invalidData) {
      const checked = await contract.validate({
        ...ran.envelope,
        result: { ...ran.envelope.result, data },
      });
      expect(checked.ok).toBe(false);
    }
  });
});

describe("navigation switch guards for -h and --version", () => {
  test("--version extra --json is declined with USAGE_INVALID_INVOCATION and exit 2", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["--version", "extra", "--json"]);
    expect(ran.exitCode).toBe(2);
    expect(ran.envelope.result.commandIdentity).toBe("tool.dispatch");
    expect(ran.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(ran.envelope.message).toBe(
      "Give --help, -h, --version, --discover or --discover-all alone, or --discover-command with one command identity.",
    );
  });

  test("-h --version --json is declined naming the navigation switches", async () => {
    const contract = makeContract("1.2.3");
    const ran = await runEnvelope(contract, ["-h", "--version", "--json"]);
    expect(ran.exitCode).toBe(2);
    expect(ran.envelope.result.commandIdentity).toBe("tool.dispatch");
    expect(ran.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(ran.envelope.message).toBe(
      "Use only one of --help, -h, --version, --discover, --discover-all and --discover-command.",
    );
  });

  test("--version=x --json and -h=x --json are declined as switches that take no value", async () => {
    const contract = makeContract("1.2.3");
    for (const sw of ["--version", "-h"] as const) {
      const ran = await runEnvelope(contract, [`${sw}=x`, "--json"]);
      expect(ran.exitCode).toBe(2);
      expect(ran.envelope.result.commandIdentity).toBe("tool.dispatch");
      expect(ran.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
      expect(ran.envelope.message).toBe(`The option ${sw} takes no value.`);
    }
  });
});

describe("declaration guards for version and reserved option names", () => {
  test("a host option declared with name --version or alias -h or --version is declined", () => {
    const withOption = (name: string, aliases: readonly string[]) =>
      command({
        identity: "tool.custom",
        route: ["custom"],
        summary: "Custom.",
        input: {
          ...emptyInput,
          options: [
            {
              name,
              aliases,
              summary: "Conflicting option.",
              required: false,
              repeatable: false,
              value: null,
            },
          ],
        },
        capabilities: {},
        run: readsUnchanged("tool.custom"),
      });

    expect(() =>
      contractFor({ cli: "tool", commands: [withOption("--version", [])] }),
    ).toThrow(new Error("Invalid input declaration."));
    expect(() =>
      contractFor({ cli: "tool", commands: [withOption("--flag", ["-h"])] }),
    ).toThrow(new Error("Invalid input declaration."));
    expect(() =>
      contractFor({
        cli: "tool",
        commands: [withOption("--flag", ["--version"])],
      }),
    ).toThrow(new Error("Invalid input declaration."));
  });

  test("contractFor rejects non-string or empty version with a Repair: line", () => {
    for (const bad of [5, "", "   ", null] as const) {
      let caught: unknown;
      try {
        Reflect.apply(contractFor, undefined, [
          { cli: "tool", version: bad, commands: [] },
        ]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof Error ? caught.message : "").toBe(
        "Invalid CLI version. Repair: pass a non-empty string for version, or omit it.",
      );
    }
  });

  test("ifNoResult rejects -h and --version before --", () => {
    const causes = {
      ...commonCauses,
      DOMAIN_LOCKED: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "handoff",
      },
      DOMAIN_UNRESOLVED: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "handoff",
      },
    } as const satisfies CauseTable;
    const reportSuccess = station(causes, {
      commandIdentity: "tool.report",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Reported.",
      guidance: {
        next: { kind: "instruction", text: "Inspect the report." },
      },
      repairAction: null,
      ...stationWords,
      independentObservable: "version-short-help-report",
    });
    const report = command({
      identity: "tool.report",
      route: ["report"],
      summary: "Report.",
      input: itemInput,
      capabilities: {},
      stations: [reportSuccess],
      run: (_input, context) =>
        context.result(reportSuccess, {
          message: "Reported.",
          data: null,
          effects: unchanged,
        }),
    });
    for (const sw of ["-h", "--version"] as const) {
      const descriptor = createStateAddon((issuer) => ({
        ifNoResult: issuer.ifNoResult({
          kind: "command",
          command: "tool.report",
          args: [sw],
        }),
        attach: () => ({
          transaction: () =>
            Promise.reject(new Error("The test transaction never runs.")),
        }),
      }));
      const write = changing({
        identity: "tool.write",
        route: ["write"],
        summary: "Write.",
        effectClass: "repository-local",
        effects: ["write"],
        ifNoResult: descriptor.ifNoResult,
        heldLockCause: "DOMAIN_LOCKED",
        unresolvedCaseCause: "DOMAIN_UNRESOLVED",
        input: emptyInput,
        capabilities: {},
        stations: [
          station(causes, {
            commandIdentity: "tool.write",
            causeCode: "SUCCESS_COMPLETED",
            trigger: "Written.",
            guidance: { next: { kind: "done" } },
            repairAction: null,
            ...stationWords,
            independentObservable: "version-short-help-written",
          }),
          station(causes, {
            commandIdentity: "tool.write",
            causeCode: "DOMAIN_LOCKED",
            trigger: "Locked.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Locked.",
                inspect: [{ kind: "instruction", text: "Inspect lock." }],
              },
            },
            repairAction: "Inspect lock.",
            ...stationWords,
            independentObservable: "version-short-help-locked",
          }),
          station(causes, {
            commandIdentity: "tool.write",
            causeCode: "DOMAIN_UNRESOLVED",
            trigger: "Unresolved.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Unresolved.",
                inspect: [{ kind: "instruction", text: "Inspect case." }],
              },
            },
            repairAction: "Inspect case.",
            ...stationWords,
            independentObservable: "version-short-help-unresolved",
          }),
        ],
        run: () => Promise.reject(new Error("never runs")),
      });
      expect(() =>
        contractFor({
          cli: "tool",
          causes,
          state: descriptor,
          installedAddons: ["state"],
          commands: [report, write],
        }),
      ).toThrow(
        new Error(
          `ifNoResult step tool.report ${JSON.stringify([sw])} carries a global switch before --.`,
        ),
      );
    }
  });
});
