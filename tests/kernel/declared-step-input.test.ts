import { describe, expect, test } from "bun:test";
import { stateAddon } from "../../kernel/src/addons/state/index.ts";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  defaultCommandDisclosure,
  runInProcess,
  station,
} from "../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  CommandStep,
  InProcessResult,
  InputSchema,
} from "../../kernel/src/kernel/index.ts";
import { ownedFolders } from "../support/fixture-files.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "./kernel-repair/shapes.ts";

const folder = ownedFolders();
const lowerNamePattern = "[a-z]+";

function enveloped(result: InProcessResult) {
  expect(result.kind).toBe("envelope");
  if (result.kind !== "envelope")
    throw new Error(`Expected envelope run, got ${result.kind}`);
  return result;
}

function lowerNameInput(
  required = true,
  overrides: Partial<InputSchema> = {},
): InputSchema {
  return {
    ...emptyInput,
    arguments: [
      {
        name: "name",
        summary: "Lower-case name.",
        required,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 32,
          choices: null,
          pattern: lowerNamePattern,
        },
      },
    ],
    ...overrides,
  };
}

function showCommand<const Identity extends string = "au.show">(
  identity: Identity,
  route: readonly string[],
  input: InputSchema,
) {
  return command({
    identity,
    route,
    summary: "Show one.",
    input,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
        { message: "Shown.", data: null, effects: unchanged },
      ),
  });
}

function startCommand<const Target extends "au.show" | "au.root">(
  next: CommandStep<Target>,
  bindings?: Record<string, string>,
) {
  return command({
    identity: "au.start",
    route: ["start"],
    summary: "Start.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(commonCauses, {
        ...stationWords,
        commandIdentity: "au.start",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Started.",
        guidance: { next },
        repairAction: null,
        independentObservable: "au.start:started",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "au.start", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Started.",
          data: null,
          effects: unchanged,
          ...(bindings === undefined ? {} : { bindings }),
        },
      ),
  });
}

describe("SP declared step input parser", () => {
  test("SP01.next-step-pattern-refused: contractFor refuses a literal next step or handoff inspect step that breaks its target pattern", async () => {
    const show = showCommand("au.show", ["show"], lowerNameInput());
    const badStart = startCommand({
      kind: "command",
      command: "au.show",
      args: ["ABC"],
    });
    expect(() =>
      contractFor({ cli: "au", commands: [show, badStart] }),
    ).toThrow(
      /Command step au\.show \["ABC"\] from au\.start can never parse:.*\[a-z\]\+/,
    );

    const taggedShow = showCommand("au.show", ["show"], {
      ...emptyInput,
      options: [
        {
          name: "--tag",
          aliases: [],
          summary: "Lower-case tag.",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 8,
            choices: null,
            pattern: lowerNamePattern,
          },
        },
      ],
    });
    const causes = {
      ...commonCauses,
      DOMAIN_NEEDS_INSPECT: refusedHandoff,
    } as const satisfies CauseTable;
    const badHandoff = command({
      identity: "au.check",
      route: ["check"],
      summary: "Check.",
      input: emptyInput,
      capabilities: {},
      stations: [
        station(causes, {
          ...stationWords,
          commandIdentity: "au.check" as const,
          causeCode: "DOMAIN_NEEDS_INSPECT",
          trigger: "Needs inspection.",
          guidance: {
            handoff: {
              owner: "operator",
              reason: "Inspect target.",
              inspect: [
                { kind: "command", command: "au.show", args: ["--tag=BAD"] },
              ],
            },
          },
          repairAction: "Inspect the target.",
          independentObservable: "au.check:handoff",
        }),
      ],
      run: (_input, context) =>
        context.result(
          { commandIdentity: "au.check", causeCode: "DOMAIN_NEEDS_INSPECT" },
          { message: "Needs inspect.", data: null, effects: unchanged },
        ),
    });
    expect(() =>
      contractFor({ cli: "au", causes, commands: [taggedShow, badHandoff] }),
    ).toThrow(
      /Command step au\.show \["--tag=BAD"\] from au\.check can never parse:.*\[a-z\]\+/,
    );

    const goodStart = startCommand({
      kind: "command",
      command: "au.show",
      args: ["abc"],
    });
    const contract = contractFor({ cli: "au", commands: [show, goodStart] });
    const started = enveloped(await runInProcess(contract)(["start"]));
    expect(started.exitCode).toBe(0);
    expect(started.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    const shown = enveloped(await runInProcess(contract)(["show", "abc"]));
    expect(shown.exitCode).toBe(0);
    expect(shown.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
  });

  test("SP02.ifnoresult-step-checked: state add-on ifNoResult report command is checked by the same parser at start-up", () => {
    const causes = {
      ...commonCauses,
      DOMAIN_AU_LOCK_HELD: refusedHandoff,
      DOMAIN_AU_UNRESOLVED: refusedHandoff,
    } as const satisfies CauseTable;
    const state = stateAddon({
      root: folder("sp02-ifnoresult-"),
      report: "au.pending",
    }).descriptor;
    const buildWithPending = (route: readonly string[], input: InputSchema) => {
      const pending = command({
        identity: "au.pending",
        route,
        summary: "Report unfinished work.",
        input,
        capabilities: {},
        stations: [
          station(causes, {
            ...stationWords,
            commandIdentity: "au.pending" as const,
            causeCode: "SUCCESS_UNCHANGED",
            trigger: "Listed.",
            guidance: {
              next: { kind: "instruction", text: "Inspect listed work." },
            },
            repairAction: null,
            independentObservable: "au.pending:listed",
          }),
        ],
        run: (_input, context) =>
          context.result(
            { commandIdentity: "au.pending", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Listed.", data: null, effects: unchanged },
          ),
      });
      const apply = changing({
        identity: "au.apply",
        route: ["apply"],
        summary: "Apply a change.",
        input: emptyInput,
        capabilities: {},
        effectClass: "repository-local",
        effects: ["au.write"],
        ifNoResult: state.ifNoResult,
        heldLockCause: "DOMAIN_AU_LOCK_HELD",
        unresolvedCaseCause: "DOMAIN_AU_UNRESOLVED",
        stations: [
          station(causes, {
            ...stationWords,
            commandIdentity: "au.apply" as const,
            causeCode: "DOMAIN_AU_LOCK_HELD",
            trigger: "Lock held.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Lock held.",
                inspect: [{ kind: "command", command: "au.pending", args: [] }],
              },
            },
            repairAction: "Inspect pending work.",
            independentObservable: "au.apply:lock",
          }),
          station(causes, {
            ...stationWords,
            commandIdentity: "au.apply" as const,
            causeCode: "DOMAIN_AU_UNRESOLVED",
            trigger: "Unresolved.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Unresolved.",
                inspect: [{ kind: "command", command: "au.pending", args: [] }],
              },
            },
            repairAction: "Inspect unresolved work.",
            independentObservable: "au.apply:unresolved",
          }),
        ],
        run: (_input, context) =>
          Promise.resolve(
            context.result(
              { commandIdentity: "au.apply", causeCode: "DOMAIN_AU_LOCK_HELD" },
              { message: "Held.", data: null, effects: unchanged },
            ),
          ),
      });
      return contractFor({
        cli: "au",
        causes,
        state,
        installedAddons: ["state"],
        commands: [pending, apply],
      });
    };

    expect(() => buildWithPending(["pending"], lowerNameInput(true))).toThrow(
      "ifNoResult step au.pending [] can never parse: required name is absent.",
    );
    expect(() => buildWithPending([], lowerNameInput(false))).toThrow(
      "ifNoResult step au.pending [] can never parse: a root operation needs an option or operand.",
    );
    expect(() => buildWithPending(["pending"], emptyInput)).not.toThrow();
  });

  test("SP03.default-command-checked: defaultCommand is checked by the same parser at start-up", () => {
    const buildDefault = (route: readonly string[], input: InputSchema) => {
      const menu = command({
        identity: "au.menu",
        route,
        summary: `Open menu. ${defaultCommandDisclosure}`,
        input,
        capabilities: {},
        run: (_input, context) =>
          context.result(
            { commandIdentity: "au.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Opened.", data: null, effects: unchanged },
          ),
      });
      return contractFor({
        cli: "au",
        commands: [menu],
        defaultCommand: menu,
      });
    };

    expect(() => buildDefault(["menu"], lowerNameInput(true))).toThrow(
      "defaultCommand au.menu cannot run with no arguments: required name is absent.",
    );
    expect(() => buildDefault([], lowerNameInput(false))).toThrow(
      "defaultCommand au.menu cannot run with no arguments: a root operation needs an option or operand.",
    );
    expect(() => buildDefault(["menu"], lowerNameInput(false))).not.toThrow();
  });

  test("SP04.placeholder-tokens: templated placeholders pass declaration checks while run-time parsing checks literal braces against the slot pattern", async () => {
    const show = showCommand("au.show", ["show"], lowerNameInput());
    const templatedBinding = startCommand(
      { kind: "command", command: "au.show", args: ["{binding.name}"] },
      { name: "abc" },
    );
    const contract = contractFor({
      cli: "au",
      commands: [show, templatedBinding],
    });
    const ran = enveloped(await runInProcess(contract)(["start"]));
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.result.next).toEqual({
      kind: "command",
      command: "au.show",
      args: ["abc"],
    });

    const templatedOption = startCommand({
      kind: "command",
      command: "au.show",
      args: ["--{runId}", "abc"],
    });
    expect(() =>
      contractFor({ cli: "au", commands: [show, templatedOption] }),
    ).toThrow(
      'Command step au.show ["--{runId}","abc"] from au.start can never parse: a run value in --{runId} would select an option the step does not name.',
    );

    const literalBraceRun = enveloped(
      await runInProcess(contract)(["show", "{binding.name}"]),
    );
    expect(literalBraceRun.exitCode).toBe(2);
    expect(literalBraceRun.envelope.result.causeCode).toBe(
      "USAGE_INVALID_INVOCATION",
    );
    expect(literalBraceRun.envelope.message).toContain(lowerNamePattern);
    expect(await contract.parse("au.show", ["{runId}"])).toEqual({
      ok: false,
      path: "input",
      reason: "pattern mismatch",
    });
  });

  test("SP05.root-rule: root operation steps apply the same root input rule and pattern check as run-time parsing", async () => {
    const rootInput = lowerNameInput(false, {
      deadlineSupported: true,
      options: [
        {
          name: "--flag",
          aliases: [],
          summary: "Optional flag.",
          required: false,
          repeatable: false,
          value: null,
        },
      ],
    });
    const rootOp = showCommand("au.root", [], rootInput);

    const emptyRootStep = startCommand({
      kind: "command",
      command: "au.root",
      args: [],
    });
    expect(() =>
      contractFor({ cli: "au", commands: [rootOp, emptyRootStep] }),
    ).toThrow(
      "Command step au.root [] from au.start can never parse: a root operation needs an option or operand.",
    );

    const deadlineOnlyStep = startCommand({
      kind: "command",
      command: "au.root",
      args: ["--deadline-ms", "10"],
    });
    expect(() =>
      contractFor({ cli: "au", commands: [rootOp, deadlineOnlyStep] }),
    ).toThrow(
      'Command step au.root ["--deadline-ms","10"] from au.start can never parse: a root operation needs an option or operand.',
    );

    const badPatternStep = startCommand({
      kind: "command",
      command: "au.root",
      args: ["ABC"],
    });
    expect(() =>
      contractFor({ cli: "au", commands: [rootOp, badPatternStep] }),
    ).toThrow(
      /Command step au\.root \["ABC"\] from au\.start can never parse:.*\[a-z\]\+/,
    );

    const goodRootStep = startCommand({
      kind: "command",
      command: "au.root",
      args: ["abc"],
    });
    const contract = contractFor({
      cli: "au",
      commands: [rootOp, goodRootStep],
    });
    expect(await contract.parse("au.root", [])).toEqual({
      ok: false,
      path: "input",
      reason: "root operation requires a command-specific input",
    });
    expect(await contract.parse("au.root", ["--deadline-ms", "10"])).toEqual({
      ok: false,
      path: "input",
      reason: "root operation requires a command-specific input",
    });
    expect(enveloped(await runInProcess(contract)(["start"])).exitCode).toBe(0);
    expect(enveloped(await runInProcess(contract)(["abc"])).exitCode).toBe(0);
  });
});
