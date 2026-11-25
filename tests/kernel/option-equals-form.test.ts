import { describe, expect, test } from "bun:test";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../kernel/src/kernel/index.ts";
import { asksMachineOutput } from "../../kernel/src/kernel/routing.ts";
import { createStateAddon } from "../../kernel/src/kernel/state-seam.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";

const stringValue = (minLength = 0) =>
  ({
    kind: "string",
    minLength,
    maxLength: 64,
    choices: null,
    pattern: null,
  }) as const;

function equalsContract() {
  const inspect = command({
    identity: "demo.check",
    route: ["check"],
    summary: "Check option forms.",
    input: {
      ...emptyInput,
      deadlineSupported: true,
      arguments: [
        {
          name: "item",
          summary: "Optional item.",
          required: false,
          value: stringValue(0),
        },
      ],
      options: [
        {
          name: "--at-least",
          aliases: [],
          summary: "Minimum count.",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 0, maximum: 100 },
        },
        {
          name: "--name",
          aliases: ["--long-alias", "-x"],
          summary: "Name value.",
          required: false,
          repeatable: false,
          value: stringValue(0),
        },
        {
          name: "--strict-name",
          aliases: [],
          summary: "Non-empty name.",
          required: false,
          repeatable: false,
          value: stringValue(1),
        },
        {
          name: "--tag",
          aliases: [],
          summary: "Repeatable tag.",
          required: false,
          repeatable: true,
          value: stringValue(1),
        },
        {
          name: "--verbose",
          aliases: [],
          summary: "Verbose flag.",
          required: false,
          repeatable: false,
          value: null,
        },
        {
          name: "--wiki",
          aliases: [],
          summary: "Wiki path.",
          required: false,
          repeatable: false,
          value: stringValue(1),
        },
      ],
    },
    capabilities: {},
    run: (input, context) =>
      context.result(
        {
          commandIdentity: "demo.check",
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        { message: "Checked.", data: input, effects: unchanged },
      ),
  });
  return contractFor({ cli: "demo", commands: [inspect] });
}

describe("option equals form", () => {
  test("--at-least=2 parses to the same values as --at-least 2", async () => {
    const contract = equalsContract();
    const space = await contract.resolve(["check", "--at-least", "2"]);
    const equals = await contract.resolve(["check", "--at-least=2"]);
    expect(equals).toEqual(space);
    expect(equals).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--at-least": 2 },
      },
    });
  });

  test("--name=a=b splits at the first equals sign only", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--name=a=b"])).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--name": "a=b" },
      },
    });
  });

  test("--name= passes the empty string through the option's value rules like --name ''", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--name="])).toEqual(
      await contract.resolve(["check", "--name", ""]),
    );
    expect(await contract.resolve(["check", "--name="])).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--name": "" },
      },
    });
    const strictSpace = await contract.resolve(["check", "--strict-name", ""]);
    const strictEquals = await contract.resolve(["check", "--strict-name="]);
    expect(strictEquals).toEqual(strictSpace);
    expect(strictEquals).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: "The option --strict-name must be 1 to 64 characters long.",
    });
  });

  test("--at-least= is declined the same way --at-least '' is", async () => {
    const contract = equalsContract();
    const space = await contract.resolve(["check", "--at-least", ""]);
    const equals = await contract.resolve(["check", "--at-least="]);
    expect(equals).toEqual(space);
    expect(equals).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: "The option --at-least must be a whole number.",
    });
  });

  test("--name=-5 reads -5 as the option's value", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--name=-5"])).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--name": "-5" },
      },
    });
  });

  test("--tag=a --tag=b collects repeatable values and mixes with space form", async () => {
    const contract = equalsContract();
    const expected = {
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--tag": ["a", "b"] },
      },
    } as const;
    expect(await contract.resolve(["check", "--tag=a", "--tag=b"])).toEqual(
      expected,
    );
    expect(await contract.resolve(["check", "--tag=a", "--tag", "b"])).toEqual(
      expected,
    );
    expect(await contract.resolve(["check", "--tag", "a", "--tag=b"])).toEqual(
      expected,
    );
  });

  test("--long-alias=value parses the same as --long-alias value", async () => {
    const contract = equalsContract();
    const space = await contract.resolve(["check", "--long-alias", "value"]);
    const equals = await contract.resolve(["check", "--long-alias=value"]);
    expect(equals).toEqual(space);
    expect(equals).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { "--name": "value" },
      },
    });
  });

  test("-x=value declines a one-dash alias with an equals sign and hides the value", async () => {
    const contract = equalsContract();
    const result = await contract.resolve(["check", "-x=PRIVATE_SECRET"]);
    expect(result).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message:
        "The invocation uses -x, an option this command does not declare. Did you mean --name?",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
  });

  test("--verbose=yes declines a boolean option with a value", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--verbose=yes"])).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: "The option --verbose takes no value.",
    });
    expect(await contract.parse("demo.check", ["--verbose=yes"])).toEqual({
      ok: false,
      path: "--verbose",
      reason: "unexpected value",
    });
  });

  test("--deadline-ms=500 parses the same as --deadline-ms 500", async () => {
    const contract = equalsContract();
    const space = await contract.resolve(["check", "--deadline-ms", "500"]);
    const equals = await contract.resolve(["check", "--deadline-ms=500"]);
    expect(equals).toEqual(space);
    expect(equals).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: {},
        deadlineMilliseconds: 500,
      },
    });
  });

  test("--json=true, --help=x and --discover=x refuse as switches that take no value and never enable --json", async () => {
    const contract = equalsContract();
    expect(asksMachineOutput(["check", "--json=true"])).toBe(false);
    for (const [token, name] of [
      ["--json=true", "--json"],
      ["--help=x", "--help"],
      ["--discover=x", "--discover"],
    ] as const) {
      expect(await contract.resolve(["check", token])).toEqual({
        ok: false,
        commandIdentity: "demo.dispatch",
        machine: false,
        causeCode: "USAGE_INVALID_INVOCATION",
        message: `The option ${name} takes no value.`,
      });
    }
  });

  test("--discover-all=x --json refuses like --discover=x and never runs full discovery", async () => {
    const contract = equalsContract();
    const run = runInProcess(contract);
    const discover = await run(["--discover=x", "--json"]);
    const discoverAll = await run(["--discover-all=x", "--json"]);
    expect(discover.kind).toBe("envelope");
    expect(discoverAll.kind).toBe("envelope");
    if (discover.kind !== "envelope" || discoverAll.kind !== "envelope")
      throw new Error("Expected refusal envelopes.");
    expect(discoverAll.exitCode).toBe(discover.exitCode);
    expect(discoverAll.exitCode).toBe(2);
    expect(discoverAll.envelope.result.causeCode).toBe(
      discover.envelope.result.causeCode,
    );
    expect(discoverAll.envelope.result.causeCode).toBe(
      "USAGE_INVALID_INVOCATION",
    );
    expect(discoverAll.envelope.result.commandIdentity).toBe("demo.dispatch");
    expect(discoverAll.envelope.result.commandIdentity).not.toBe(
      "demo.full-discovery",
    );
    expect(discover.envelope.message).toBe(
      "The option --discover takes no value.",
    );
    expect(discoverAll.envelope.message).toBe(
      "The option --discover-all takes no value.",
    );
  });

  test("--discover-command=<identity> resolves the same as --discover-command <identity>", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["--discover-command=demo.check"])).toEqual(
      await contract.resolve(["--discover-command", "demo.check"]),
    );
    const run = runInProcess(contract);
    const space = await run(["--discover-command", "demo.check"]);
    const equals = await run(["--discover-command=demo.check"]);
    expect(equals).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          commandIdentity: "demo.command-discovery",
          causeCode: "SUCCESS_UNCHANGED",
          data: { command: { commandIdentity: "demo.check" } },
        },
      },
    });
    expect(equals.kind === "envelope" && equals.envelope.result.data).toEqual(
      space.kind === "envelope" && space.envelope.result.data,
    );
  });

  test("-- --name=value treats the word after -- as an argument", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--", "--name=value"])).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { item: "--name=value" },
      },
    });
    expect(await contract.resolve(["check", "--", "--json=true"])).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { item: "--json=true" },
      },
    });
    expect(
      await contract.resolve(["check", "--", "--deadline-ms=500"]),
    ).toEqual({
      ok: true,
      value: {
        commandIdentity: "demo.check",
        machine: false,
        input: { item: "--deadline-ms=500" },
      },
    });
  });

  test("--wikki=. names the undeclared option without its value and suggests --wiki", async () => {
    const contract = equalsContract();
    const result = await contract.resolve(["check", "--wikki=PRIVATE_PATH"]);
    expect(result).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message:
        "The invocation uses --wikki, an option this command does not declare. Did you mean --wiki?",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PATH");
  });

  test("--nope names the undeclared option with no suggestion", async () => {
    const contract = equalsContract();
    expect(await contract.resolve(["check", "--nope"])).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message:
        "The invocation uses --nope, an option this command does not declare.",
    });
  });

  test("ifNoResult step check refuses global switches in equals form before -- and admits them after --", () => {
    const causes = {
      ...commonCauses,
      DOMAIN_DEMO_HELD: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "handoff",
      },
      DOMAIN_DEMO_UNRESOLVED: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "handoff",
      },
    } as const;
    function build(args: readonly string[]) {
      const descriptor = createStateAddon((issuer) => ({
        ifNoResult: issuer.ifNoResult({
          kind: "command",
          command: "demo.pending",
          args,
        }),
        attach: () => ({
          transaction: () =>
            Promise.reject(new Error("The test transaction never runs.")),
        }),
      }));
      const pending = command({
        identity: "demo.pending",
        route: ["pending"],
        summary: "Inspect pending.",
        input: {
          ...emptyInput,
          options: [
            {
              name: "--note",
              aliases: [],
              summary: "Note.",
              required: false,
              repeatable: false,
              value: stringValue(1),
            },
          ],
          arguments: [
            {
              name: "item",
              summary: "Item.",
              required: false,
              value: stringValue(1),
            },
          ],
        },
        capabilities: {},
        stations: [
          station(commonCauses, {
            commandIdentity: "demo.pending",
            causeCode: "SUCCESS_UNCHANGED",
            trigger: "Checked.",
            guidance: {
              next: { kind: "instruction", text: "Inspect the pending item." },
            },
            repairAction: null,
            retryDelayPolicy: { kind: "none" },
            reachability: "required",
            unreachableRationale: null,
            independentObservable: "demo.pending:checked",
          }),
        ],
        run: readsUnchanged("demo.pending"),
      });
      const apply = changing({
        identity: "demo.apply",
        route: ["apply"],
        summary: "Apply change.",
        input: emptyInput,
        capabilities: {},
        effectClass: "repository-local",
        effects: ["demo.write"],
        ifNoResult: descriptor.ifNoResult,
        heldLockCause: "DOMAIN_DEMO_HELD",
        unresolvedCaseCause: "DOMAIN_DEMO_UNRESOLVED",
        stations: [
          station(causes, {
            commandIdentity: "demo.apply",
            causeCode: "SUCCESS_COMPLETED",
            trigger: "Applied.",
            guidance: { next: { kind: "done" } },
            repairAction: null,
            retryDelayPolicy: { kind: "none" },
            reachability: "required",
            unreachableRationale: null,
            independentObservable: "demo.apply:done",
          }),
          station(causes, {
            commandIdentity: "demo.apply",
            causeCode: "DOMAIN_DEMO_HELD",
            trigger: "Lock held.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Lock held.",
                inspect: [
                  { kind: "command", command: "demo.pending", args: [] },
                ],
              },
            },
            repairAction: "Wait and retry.",
            retryDelayPolicy: { kind: "none" },
            reachability: "required",
            unreachableRationale: null,
            independentObservable: "demo.apply:held",
          }),
          station(causes, {
            commandIdentity: "demo.apply",
            causeCode: "DOMAIN_DEMO_UNRESOLVED",
            trigger: "Unresolved.",
            guidance: {
              handoff: {
                owner: "operator",
                reason: "Unresolved case.",
                inspect: [
                  { kind: "command", command: "demo.pending", args: [] },
                ],
              },
            },
            repairAction: "Inspect pending cases.",
            retryDelayPolicy: { kind: "none" },
            reachability: "required",
            unreachableRationale: null,
            independentObservable: "demo.apply:unresolved",
          }),
        ],
        run: () => Promise.reject(new Error("never runs")),
      });
      return contractFor({
        cli: "demo",
        commands: [pending, apply],
        causes,
        state: descriptor,
        installedAddons: ["state"],
      });
    }
    for (const token of [
      "--json=true",
      "--help=x",
      "--discover=x",
      "--discover-command=demo.pending",
    ]) {
      expect(() => build(["--note", token])).toThrow(
        `ifNoResult step demo.pending ${JSON.stringify(["--note", token])} carries a global switch before --.`,
      );
    }
    expect(() => build(["--", "--json=true"])).not.toThrow();
  });

  test("step vector validation accepts long option equals form and refuses boolean option equals form", () => {
    const target = command({
      identity: "demo.target",
      route: ["target"],
      summary: "Target command.",
      input: {
        ...emptyInput,
        options: [
          {
            name: "--note",
            aliases: [],
            summary: "Note.",
            required: false,
            repeatable: false,
            value: stringValue(1),
          },
          {
            name: "--verbose",
            aliases: [],
            summary: "Verbose flag.",
            required: false,
            repeatable: false,
            value: null,
          },
        ],
      },
      capabilities: {},
      stations: [
        station(commonCauses, {
          commandIdentity: "demo.target",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Checked.",
          guidance: { next: { kind: "done" } },
          repairAction: null,
          retryDelayPolicy: { kind: "none" },
          reachability: "required",
          unreachableRationale: null,
          independentObservable: "demo.target:checked",
        }),
      ],
      run: readsUnchanged("demo.target"),
    });
    const buildWithStep = (args: readonly string[]) =>
      contractFor({
        cli: "demo",
        commands: [
          target,
          command({
            identity: "demo.caller",
            route: ["caller"],
            summary: "Caller command.",
            input: emptyInput,
            capabilities: {},
            stations: [
              station(commonCauses, {
                commandIdentity: "demo.caller",
                causeCode: "SUCCESS_UNCHANGED",
                trigger: "Calls target.",
                guidance: {
                  next: { kind: "command", command: "demo.target", args },
                },
                repairAction: null,
                retryDelayPolicy: { kind: "none" },
                reachability: "required",
                unreachableRationale: null,
                independentObservable: "demo.caller:checked",
              }),
            ],
            run: readsUnchanged("demo.caller"),
          }),
        ],
      });
    expect(() => buildWithStep(["--note=ok"])).not.toThrow();
    expect(() => buildWithStep(["--verbose=yes"])).toThrow(
      "--verbose takes no value",
    );
  });

  test("unknown option display names 64-character tokens and omits longer or control/whitespace tokens", async () => {
    const contract = equalsContract();
    const atBound = `--${"a".repeat(62)}`;
    const overBound = `--${"a".repeat(63)}`;
    expect(await contract.resolve(["check", atBound])).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: `The invocation uses ${atBound}, an option this command does not declare.`,
    });
    expect(await contract.resolve(["check", overBound])).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: "The invocation uses an option this command does not declare.",
    });
    expect(await contract.resolve(["check", "--bad\topt"])).toEqual({
      ok: false,
      commandIdentity: "demo.check",
      machine: false,
      causeCode: "USAGE_INVALID_INVOCATION",
      message: "The invocation uses an option this command does not declare.",
    });
  });

  test("future input validation handles equals form options before a bound argument", async () => {
    const target = command({
      identity: "demo.target",
      route: ["target"],
      summary: "Target command.",
      input: {
        ...emptyInput,
        deadlineSupported: true,
        arguments: [
          {
            name: "count",
            summary: "Count.",
            required: true,
            value: { kind: "integer", minimum: 1, maximum: 10 },
          },
        ],
        options: [
          {
            name: "--note",
            aliases: [],
            summary: "Note.",
            required: false,
            repeatable: false,
            value: stringValue(1),
          },
        ],
      },
      capabilities: {},
      stations: [
        station(commonCauses, {
          commandIdentity: "demo.target",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Checked.",
          guidance: { next: { kind: "done" } },
          repairAction: null,
          retryDelayPolicy: { kind: "none" },
          reachability: "required",
          unreachableRationale: null,
          independentObservable: "demo.target:checked",
        }),
      ],
      run: readsUnchanged("demo.target"),
    });
    const caller = command({
      identity: "demo.caller",
      route: ["caller"],
      summary: "Caller command.",
      input: {
        ...emptyInput,
        options: [
          {
            name: "--count-text",
            aliases: [],
            summary: "Forwarded count.",
            required: true,
            repeatable: false,
            value: stringValue(1),
          },
        ],
      },
      futureBindings: { count: "--count-text" },
      capabilities: {},
      stations: [
        station(commonCauses, {
          commandIdentity: "demo.caller",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Forwards binding.",
          guidance: {
            next: {
              kind: "command",
              command: "demo.target",
              args: ["--note=ok", "--deadline-ms=500", "{binding.count}"],
            },
          },
          repairAction: null,
          retryDelayPolicy: { kind: "none" },
          reachability: "required",
          unreachableRationale: null,
          independentObservable: "demo.caller:checked",
        }),
      ],
      run: (input, context) =>
        context.result(
          {
            commandIdentity: "demo.caller",
            causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
          },
          {
            message: "Forwarded.",
            data: null,
            effects: unchanged,
            bindings: { count: String(input["--count-text"]) },
          },
        ),
    });
    const contract = contractFor({ cli: "demo", commands: [target, caller] });
    const run = runInProcess(contract);
    expect(await run(["caller", "--count-text=5", "--json"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          commandIdentity: "demo.caller",
          causeCode: "SUCCESS_UNCHANGED",
        },
      },
    });
    expect(await run(["caller", "--count-text=99", "--json"])).toMatchObject({
      kind: "envelope",
      exitCode: 2,
      envelope: {
        message:
          "A value in this invocation cannot be passed on to this command's next step.",
        result: {
          commandIdentity: "demo.caller",
          causeCode: "USAGE_INVALID_INVOCATION",
        },
      },
    });
  });
});
