import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  defaultCommandDisclosure,
  runInProcess,
  scriptedTerminal,
  station,
} from "../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  InputSchema,
  RunControl,
  TerminalAdapter,
} from "../../kernel/src/kernel/index.ts";
import { builtins } from "../../kernel/src/kernel/navigation.ts";
import { resolveInvocation } from "../../kernel/src/kernel/routing.ts";
import { stateAddon } from "../../kernel/src/addons/state/index.ts";
import { ownedFolders } from "../support/fixture-files.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "./kernel-repair/shapes.ts";
import {
  processWatchdog,
  spawnBounded,
} from "./kernel-repair/swarm-process.ts";

const defaultCli = join(import.meta.dir, "fixtures/default-command-cli.ts");
const plainCli = join(import.meta.dir, "fixtures/no-default-command-cli.ts");
const folder = ownedFolders();

const expectedRefusalMessage =
  "No command was given. Run doorway --help to list the commands.";

function menuCommand(
  overrides: {
    readonly identity?: string;
    readonly route?: readonly string[];
    readonly summary?: string;
    readonly input?: InputSchema;
    readonly capabilities?: { readonly diagnostics?: true };
    readonly onRun?: () => void;
  } = {},
) {
  const identity = overrides.identity ?? "doorway.menu";
  return command({
    identity,
    route: overrides.route ?? ["menu"],
    summary:
      overrides.summary ??
      `Open the interactive menu. ${defaultCommandDisclosure}`,
    input: overrides.input ?? { ...emptyInput, deadlineSupported: true },
    capabilities: overrides.capabilities ?? {},
    run: (_input, context) => {
      overrides.onRun?.();
      return context.result(
        {
          commandIdentity: identity,
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        {
          message: "Opened menu.",
          data: { opened: "menu" },
          effects: unchanged,
        },
      );
    },
  });
}

function listCommand() {
  return command({
    identity: "doorway.list",
    route: ["list"],
    summary: "List available places.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: "doorway.list",
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        {
          message: "Listed places.",
          data: { places: [] },
          effects: unchanged,
        },
      ),
  });
}

function requiredArgumentInput(): InputSchema {
  return {
    ...emptyInput,
    arguments: [
      {
        name: "place",
        summary: "Place to open.",
        required: true,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 32,
          choices: null,
          pattern: null,
        },
      },
    ],
  };
}

function optionalOptionInput(): InputSchema {
  return {
    ...emptyInput,
    options: [
      {
        name: "--all",
        aliases: [],
        summary: "Show all places.",
        required: false,
        repeatable: false,
        value: null,
      },
    ],
  };
}

function requiredOptionInput(): InputSchema {
  return {
    ...emptyInput,
    options: [
      {
        name: "--place",
        aliases: [],
        summary: "Place to open.",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 32,
          choices: null,
          pattern: null,
        },
      },
    ],
  };
}

async function runInPty(
  argv: readonly string[],
  boundMilliseconds = 15_000,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const child = Bun.spawn([...argv], {
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, data) {
        chunks.push(new Uint8Array(data));
      },
    },
  });
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), boundMilliseconds);
  });
  try {
    const outcome = await Promise.race([child.exited, expired]);
    if (outcome === "expired") {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(
        `PTY child ${argv.join(" ")} did not exit within ${String(boundMilliseconds)} ms.`,
      );
    }
    return {
      exitCode: outcome,
      output: new TextDecoder().decode(Buffer.concat(chunks)),
    };
  } finally {
    clearTimeout(timer);
    child.terminal?.close();
  }
}

describe("default command start-up checks", () => {
  test("accepts an ordinary command with disclosure and no required input, including optional slots and changing commands", () => {
    const optionalMenu = menuCommand({ input: optionalOptionInput() });
    const contract = contractFor({
      cli: "doorway",
      commands: [optionalMenu, listCommand()],
      defaultCommand: optionalMenu,
    });
    expect(contract.cli).toBe("doorway");

    const stateCauses = {
      DOMAIN_DOORWAY_LOCK_HELD: refusedHandoff,
      DOMAIN_DOORWAY_UNRESOLVED: refusedHandoff,
      DOMAIN_DOORWAY_NOTHING_CHOSEN: { ...refusedHandoff, guidance: "next" },
    } as const satisfies CauseTable;
    const allCauses = { ...commonCauses, ...stateCauses };
    const root = folder("default-command-state-");
    const descriptor = stateAddon({
      root,
      report: "doorway.pending",
    }).descriptor;
    const pending = command({
      identity: "doorway.pending",
      route: ["pending"],
      summary: "Report unfinished work.",
      input: emptyInput,
      capabilities: {},
      stations: [
        station(allCauses, {
          ...stationWords,
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Read.",
          repairAction: null,
          guidance: {
            next: { kind: "instruction", text: "Inspect listed cases." },
          },
          independentObservable: "doorway.pending:read",
        }),
      ],
      run: (_input, context) =>
        context.result(
          {
            commandIdentity: "doorway.pending",
            causeCode: "SUCCESS_UNCHANGED",
          },
          { message: "Pending.", data: null, effects: unchanged },
        ),
    });
    const handoff = {
      handoff: {
        owner: "operator",
        reason: "Coordination refused.",
        inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
      },
    } as const;
    const changingMenu = changing({
      identity: "doorway.menu",
      route: ["menu"],
      summary: `Choose and open a place. ${defaultCommandDisclosure}`,
      input: emptyInput,
      capabilities: {},
      effectClass: "repository-local",
      effects: ["doorway.open"],
      ifNoResult: descriptor.ifNoResult,
      heldLockCause: "DOMAIN_DOORWAY_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_DOORWAY_UNRESOLVED",
      stations: [
        station(allCauses, {
          ...stationWords,
          commandIdentity: "doorway.menu",
          causeCode: "DOMAIN_DOORWAY_LOCK_HELD",
          trigger: "Lock held.",
          repairAction: "Inspect pending.",
          guidance: handoff,
          independentObservable: "doorway.menu:lock-held",
        }),
        station(allCauses, {
          ...stationWords,
          commandIdentity: "doorway.menu",
          causeCode: "DOMAIN_DOORWAY_UNRESOLVED",
          trigger: "Unresolved.",
          repairAction: "Inspect pending.",
          guidance: handoff,
          independentObservable: "doorway.menu:unresolved",
        }),
        station(allCauses, {
          ...stationWords,
          commandIdentity: "doorway.menu",
          causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
          trigger: "Nothing chosen.",
          repairAction: "Run again.",
          guidance: {
            next: { kind: "instruction", text: "Choose a place." },
          },
          independentObservable: "doorway.menu:nothing-chosen",
        }),
      ],
      run: async (_input, context) =>
        Promise.resolve(
          context.result(
            {
              commandIdentity: "doorway.menu",
              causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
            },
            { message: "Nothing was opened.", data: null, effects: unchanged },
          ),
        ),
    });
    const changingContract = contractFor({
      cli: "doorway",
      commands: [changingMenu, pending],
      defaultCommand: changingMenu,
      state: descriptor,
      causes: stateCauses,
      installedAddons: ["state"],
    });
    expect(changingContract.cli).toBe("doorway");
  });

  test("refuses a default command naming a built-in command", () => {
    const help = builtins("doorway").find(
      (item) => item.commandIdentity === "doorway.help",
    );
    expect(help).toBeDefined();
    expect(() => {
      Reflect.apply(contractFor, undefined, [
        {
          cli: "doorway",
          commands: [menuCommand()],
          defaultCommand: help,
        },
      ]);
    }).toThrow("defaultCommand cannot name built-in command doorway.help.");
  });

  test("refuses a default command that is not in commands", () => {
    const listed = listCommand();
    const unlisted = menuCommand();
    expect(() => {
      Reflect.apply(contractFor, undefined, [
        {
          cli: "doorway",
          commands: [listed],
          defaultCommand: unlisted,
        },
      ]);
    }).toThrow("defaultCommand must be one of the declared commands.");
  });

  test("refuses a default command with a required argument", () => {
    const needsArg = menuCommand({ input: requiredArgumentInput() });
    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [needsArg],
        defaultCommand: needsArg,
      }),
    ).toThrow("defaultCommand doorway.menu cannot run with no arguments");
  });

  test("refuses a default command with a required option", () => {
    const needsOption = menuCommand({ input: requiredOptionInput() });
    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [needsOption],
        defaultCommand: needsOption,
      }),
    ).toThrow("defaultCommand doorway.menu cannot run with no arguments");
  });

  test("refuses a default command that is a root operation", () => {
    const rootOp = menuCommand({ route: [], input: optionalOptionInput() });
    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [rootOp],
        defaultCommand: rootOp,
      }),
    ).toThrow("a root operation needs an option or operand");
  });

  test("refuses a default command whose summary lacks defaultCommandDisclosure", () => {
    const silent = menuCommand({ summary: "Open the interactive menu." });
    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [silent],
        defaultCommand: silent,
      }),
    ).toThrow(defaultCommandDisclosure);
  });
});

describe("default command in-process routing and terminal fact", () => {
  test("without a terminal, empty argv returns the byte-identical refusal as a CLI without defaultCommand", async () => {
    let calls = 0;
    const menu = menuCommand({
      onRun: () => {
        calls += 1;
      },
    });
    const withDefault = contractFor({
      cli: "doorway",
      commands: [menu, listCommand()],
      defaultCommand: menu,
    });
    const withoutDefault = contractFor({
      cli: "doorway",
      commands: [listCommand()],
    });
    const a = await runInProcess(withDefault)([]);
    const b = await runInProcess(withoutDefault)([]);
    expect(calls).toBe(0);
    expect(a.kind).toBe("envelope");
    expect(b.kind).toBe("envelope");
    if (a.kind !== "envelope" || b.kind !== "envelope") return;
    expect(a.exitCode).toBe(2);
    expect(a.exitCode).toBe(b.exitCode);
    expect(a.envelope.message).toBe(expectedRefusalMessage);
    expect(a.envelope.message).toBe(b.envelope.message);
    expect(a.envelope.result.commandIdentity).toBe("doorway.dispatch");
    expect(a.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
    expect(a.envelope.result.causeCode).toBe(b.envelope.result.causeCode);
    expect(a.envelope.result.repairAction).toBe(b.envelope.result.repairAction);
    expect(a.envelope.result.next).toEqual(b.envelope.result.next);
  });

  test("in an interactive run with scriptedTerminal, empty argv runs the default command", async () => {
    let calls = 0;
    const menu = menuCommand({
      onRun: () => {
        calls += 1;
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [menu, listCommand()],
      defaultCommand: menu,
    });
    const result = await runInProcess(contract, {
      terminal: scriptedTerminal([]),
    })([]);
    expect(calls).toBe(1);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.exitCode).toBe(0);
    expect(result.envelope.message).toBe("Opened menu.");
    expect(result.envelope.result.commandIdentity).toBe("doorway.menu");
    expect(result.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(result.envelope.result.data).toEqual({ opened: "menu" });
  });

  test("with --json alone in a terminal, refuses with USAGE_INVALID_INVOCATION and exit 2", async () => {
    let calls = 0;
    const menu = menuCommand({
      onRun: () => {
        calls += 1;
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [menu, listCommand()],
      defaultCommand: menu,
    });
    const result = await runInProcess(contract, {
      terminal: scriptedTerminal([]),
    })(["--json"]);
    expect(calls).toBe(0);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.exitCode).toBe(2);
    expect(result.envelope.message).toBe(expectedRefusalMessage);
    expect(result.envelope.result.commandIdentity).toBe("doorway.dispatch");
    expect(result.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
  });

  test("resolveInvocation with interactive true still refuses --json alone", async () => {
    const menu = menuCommand();
    const resolved = await resolveInvocation(
      "doorway",
      [menu, ...builtins("doorway")],
      ["--json"],
      { interactive: true, defaultCommand: menu },
    );
    expect(resolved).toMatchObject({
      ok: false,
      commandIdentity: "doorway.dispatch",
      causeCode: "USAGE_INVALID_INVOCATION",
      machine: true,
      message: expectedRefusalMessage,
    });
  });

  test("with --deadline-ms alone in a terminal, refuses instead of running the default command", async () => {
    let calls = 0;
    const menu = menuCommand({
      onRun: () => {
        calls += 1;
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [menu, listCommand()],
      defaultCommand: menu,
    });
    const result = await runInProcess(contract, {
      terminal: scriptedTerminal([]),
    })(["--deadline-ms", "9000"]);
    expect(calls).toBe(0);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.exitCode).toBe(2);
    expect(result.envelope.message).toBe(expectedRefusalMessage);
    expect(result.envelope.result.commandIdentity).toBe("doorway.dispatch");
    expect(result.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
  });

  test("a CLI without defaultCommand refuses empty argv even with a terminal", async () => {
    const contract = contractFor({
      cli: "doorway",
      commands: [listCommand()],
    });
    const result = await runInProcess(contract, {
      terminal: scriptedTerminal([]),
    })([]);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.exitCode).toBe(2);
    expect(result.envelope.message).toBe(expectedRefusalMessage);
    expect(result.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
  });

  test("the default command keeps its own route and carries defaultCommandDisclosure in discovery", async () => {
    const menu = menuCommand();
    const contract = contractFor({
      cli: "doorway",
      commands: [menu, listCommand()],
      defaultCommand: menu,
    });
    const ran = await runInProcess(contract)(["menu"]);
    expect(ran.kind).toBe("envelope");
    if (ran.kind !== "envelope") return;
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.result.commandIdentity).toBe("doorway.menu");

    const discovered = contract.discoverCommand("doorway.menu");
    expect(JSON.stringify(discovered)).toContain(defaultCommandDisclosure);
  });

  test("RunControl.terminal is settled before routing: present in an interactive run, absent with --json or without a terminal", async () => {
    const observed: (TerminalAdapter | undefined)[] = [];
    const probeAddon = {
      reportsStatus: true as const,
      attach(run: RunControl) {
        observed.push(run.terminal);
        return {
          capability: {
            record: () => undefined,
          },
          settle: () => Promise.resolve(true),
          killNow: () => undefined,
        };
      },
    };
    const menu = menuCommand({ capabilities: { diagnostics: true } });
    const contract = contractFor({
      cli: "doorway",
      commands: [menu],
      defaultCommand: menu,
      installedAddons: ["diagnostics"],
    });
    const terminal = scriptedTerminal([]);
    await runInProcess(contract, {
      addons: { diagnostics: probeAddon },
      terminal,
    })([]);
    await runInProcess(contract, {
      addons: { diagnostics: probeAddon },
      terminal,
    })(["menu"]);
    await runInProcess(contract, {
      addons: { diagnostics: probeAddon },
      terminal,
    })(["menu", "--json"]);
    await runInProcess(contract, {
      addons: { diagnostics: probeAddon },
    })(["menu"]);
    expect(observed).toEqual([terminal, terminal, undefined, undefined]);
  });

  test("scriptedTerminal replays keys and records drawn lines", async () => {
    const terminal = scriptedTerminal(["a", new Uint8Array([13])], {
      columns: 100,
      rows: 30,
    });
    expect(terminal.size()).toEqual({ columns: 100, rows: 30 });
    terminal.enter();
    terminal.draw(["Open what?", "> alpha"]);
    terminal.leave();
    terminal.leave();
    expect(terminal.drawn).toEqual([["Open what?", "> alpha"]]);

    const controller = new AbortController();
    const read: number[][] = [];
    for await (const chunk of terminal.keys(controller.signal))
      read.push([...chunk]);
    expect(read).toEqual([[97], [13]]);
  });
});

describe("default command real-process proofs", () => {
  const timeout = processWatchdog(5);

  test(
    "piped empty argv is byte-identical to a CLI without defaultCommand",
    async () => {
      const [withDefault, withoutDefault] = await Promise.all([
        spawnBounded([process.execPath, defaultCli]),
        spawnBounded([process.execPath, plainCli]),
      ]);
      expect(withDefault.exit).toBe(2);
      expect(withDefault.stdout).toBe("");
      expect(withDefault.stderr).toBe(
        `doorway: ${expectedRefusalMessage} [USAGE_INVALID_INVOCATION]\n`,
      );
      expect(withDefault.exit).toBe(withoutDefault.exit);
      expect(withDefault.stdout).toBe(withoutDefault.stdout);
      expect(withDefault.stderr).toBe(withoutDefault.stderr);
    },
    timeout,
  );

  test(
    "pseudo-terminal empty argv runs defaultCommand; --json and --deadline-ms still refuse",
    async () => {
      const interactive = await runInPty([process.execPath, defaultCli]);
      expect(interactive.exitCode).toBe(0);
      expect(interactive.output).toContain("Opened menu.");

      const jsonRun = await runInPty([process.execPath, defaultCli, "--json"]);
      expect(jsonRun.exitCode).toBe(2);
      const parsed: unknown = JSON.parse(jsonRun.output.trim());
      expect(parsed).toMatchObject({
        message: expectedRefusalMessage,
        result: {
          commandIdentity: "doorway.dispatch",
          causeCode: "USAGE_INVALID_INVOCATION",
          exitCode: 2,
        },
      });

      const deadlineRun = await runInPty([
        process.execPath,
        defaultCli,
        "--deadline-ms",
        "9000",
      ]);
      expect(deadlineRun.exitCode).toBe(2);
      expect(deadlineRun.output).toContain(expectedRefusalMessage);
    },
    timeout,
  );

  test(
    "ProcessHost terminal requires both stdin and stdout to be terminals",
    async () => {
      const stdoutPiped = await runInPty([
        "/bin/sh",
        "-c",
        `out=$("${process.execPath}" "${defaultCli}"); rc=$?; printf '%s' "$out"; exit $rc`,
      ]);
      expect(stdoutPiped.exitCode).toBe(2);
      expect(stdoutPiped.output).toContain(expectedRefusalMessage);
      expect(stdoutPiped.output).not.toContain("Opened menu.");

      const stdinPiped = await runInPty([
        "/bin/sh",
        "-c",
        `printf '' | "${process.execPath}" "${defaultCli}"`,
      ]);
      expect(stdinPiped.exitCode).toBe(2);
      expect(stdinPiped.output).toContain(expectedRefusalMessage);
      expect(stdinPiped.output).not.toContain("Opened menu.");
    },
    timeout,
  );
});
