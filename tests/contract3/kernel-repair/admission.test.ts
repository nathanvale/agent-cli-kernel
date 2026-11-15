import { expect } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  CauseTable,
  CommandDeclaration,
  DeclaredStation,
  Handoff,
  InputSchema,
  NextStep,
} from "../../../starters/contract3/src/kernel/index.ts";
import { frozenInputs } from "./cases.ts";
import { runFamily, stateFixture } from "./harness.ts";

const empty = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const withOperand = {
  ...empty,
  arguments: [
    {
      name: "item",
      summary: "Item.",
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
} as const;
const withFlag = {
  ...empty,
  options: [
    {
      name: "--all",
      aliases: [],
      summary: "All.",
      required: false,
      repeatable: false,
      value: null,
    },
  ],
} as const;
const stationWordsBase = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "repair-admission",
} as const;
const hostWords = "HOST-WORDS";

let changingObservations: Promise<unknown> | undefined;
async function changingObserved(id: string): Promise<unknown> {
  changingObservations ??= stateFixture("admission-changing");
  return Reflect.get(Object(await changingObservations), id);
}

function refusal(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
const table: CauseTable = commonCauses;
// Host stations whose handoffs name no command, so a widened declaration list
// still satisfies the registered-guidance type of contractFor.
type HostStation = Omit<DeclaredStation, "guidance"> & {
  readonly guidance:
    | { readonly next: NextStep; readonly handoff?: never }
    | { readonly handoff: Handoff<never>; readonly next?: never };
};
type HostDeclaration = Omit<CommandDeclaration, "stations"> & {
  readonly stations: readonly HostStation[];
};
function literal(identity: string, causeCode: string): HostStation {
  const row = table[causeCode];
  if (!row) throw new Error("Unknown cause.");
  const words = {
    commandIdentity: identity,
    causeCode,
    row,
    trigger: `${hostWords} trigger.`,
    repairAction: `${hostWords} repair.`,
    ...stationWordsBase,
  };
  return row.guidance === "handoff"
    ? {
        ...words,
        guidance: {
          handoff: {
            owner: "operator",
            reason: `${hostWords} reason.`,
            inspect: [{ kind: "instruction", text: `${hostWords} inspect.` }],
          },
        },
      }
    : {
        ...words,
        guidance: {
          next: { kind: "instruction", text: `${hostWords} next.` },
        },
      };
}
function raw(
  identity: string,
  stations: readonly HostStation[] = [],
  route: readonly string[] = ["read"],
  input: InputSchema = empty,
): HostDeclaration {
  return {
    commandIdentity: identity,
    route,
    summary: "Read.",
    input,
    capabilities: {},
    stations,
    effectClass: "inspect",
  };
}
function executable(
  identity: string,
  stations: readonly HostStation[],
  route: readonly string[] = ["read"],
  input: InputSchema = empty,
): HostDeclaration {
  return command({
    identity,
    route,
    summary: "Read.",
    input,
    capabilities: {},
    stations,
    run: () => {
      throw new Error("Admission tests never enter a handler.");
    },
  });
}
function admit(commands: readonly HostDeclaration[]) {
  return contractFor({ cli: "specimen", commands });
}
function stationWords(
  contract: ReturnType<typeof admit>,
  identity: string,
  causeCode: string,
): unknown {
  return contract
    .discoverCommand(identity)
    ?.stations.find((item) => item.causeCode === causeCode);
}

runFamily("R03", {
  "R03.station-builder-refused": () => {
    for (const causeCode of frozenInputs.reservedCauses) {
      const spec = literal("specimen.read", causeCode);
      const { row, ...input } = spec;
      void row;
      expect(
        refusal(() => Reflect.apply(station, undefined, [commonCauses, input])),
      ).toMatch(/reserved/i);
    }
  },
  "R03.command-literal-refused": () => {
    for (const causeCode of frozenInputs.reservedCauses) {
      const declaration = executable("specimen.read", [
        literal("specimen.read", causeCode),
      ]);
      expect(refusal(() => admit([declaration]))).toMatch(/reserved/i);
    }
  },
  "R03.changing-literal-refused": async () => {
    expect(await changingObserved("R03.changing-literal-refused")).toEqual(
      frozenInputs.reservedCauses.map((cause) => ({
        cause,
        refused: true,
        reserved: true,
      })),
    );
    expect(await changingObserved("entered")).toBe(0);
  },
  "R03.raw-declaration-refused": () => {
    for (const causeCode of frozenInputs.reservedCauses)
      expect(
        refusal(() =>
          admit([raw("specimen.read", [literal("specimen.read", causeCode)])]),
        ),
      ).toMatch(/reserved/i);
  },
  "R03.base-words-retained": () => {
    const twin = admit([raw("specimen.read", [], ["read"], withOperand)]);
    for (const causeCode of frozenInputs.reservedCauses) {
      let attempt: ReturnType<typeof admit> | undefined;
      try {
        attempt = admit([
          raw(
            "specimen.read",
            [literal("specimen.read", causeCode)],
            ["read"],
            withOperand,
          ),
        ]);
      } catch {
        attempt = undefined;
      }
      if (attempt)
        expect(stationWords(attempt, "specimen.read", causeCode)).toEqual(
          stationWords(twin, "specimen.read", causeCode),
        );
      expect(
        JSON.stringify(twin.discoverCommand("specimen.read")),
      ).not.toContain(hostWords);
    }
  },
  "R03.schema-station-twin": () => {
    const schema = station(commonCauses, {
      commandIdentity: "specimen.read",
      causeCode: "SCHEMA_INVALID_INPUT",
      trigger: `${hostWords} schema trigger.`,
      repairAction: `${hostWords} schema repair.`,
      guidance: { next: { kind: "instruction", text: "Fix the item." } },
      ...stationWordsBase,
    });
    const contract = admit([
      executable("specimen.read", [schema], ["read"], withOperand),
    ]);
    expect(
      stationWords(contract, "specimen.read", "SCHEMA_INVALID_INPUT"),
    ).toMatchObject({
      trigger: `${hostWords} schema trigger.`,
      repairAction: `${hostWords} schema repair.`,
      guidance: { next: { kind: "instruction", text: "Fix the item." } },
    });
  },
});

runFamily("R04", {
  "R04.command-builder-refused": () => {
    for (const token of frozenInputs.optionLikeTokens)
      expect(
        refusal(() => executable("specimen.read", [], [token])),
      ).toBeTypeOf("string");
  },
  "R04.changing-builder-refused": async () =>
    expect(await changingObserved("R04.changing-builder-refused")).toEqual(
      frozenInputs.optionLikeTokens.map((token) => ({ token, refused: true })),
    ),
  "R04.raw-declaration-refused": () => {
    for (const token of frozenInputs.optionLikeTokens)
      expect(
        refusal(() => admit([raw("specimen.read", [], [token], withFlag)])),
      ).toContain(JSON.stringify(token));
  },
  "R04.builtins-exempt": () => {
    const contract = admit([]);
    expect(
      contract
        .discover()
        .commands.map((item) => [item.commandIdentity, item.route]),
    ).toEqual([
      ["specimen.command-discovery", ["--discover-command"]],
      ["specimen.discovery", ["--discover"]],
      ["specimen.dispatch", []],
      ["specimen.help", ["--help"]],
    ]);
  },
  "R04.apply-twin-selectable": async () => {
    const contract = admit([raw("specimen.apply", [], ["apply"], withFlag)]);
    expect(
      contract
        .discover()
        .commands.some(
          (item) =>
            item.commandIdentity === "specimen.apply" &&
            JSON.stringify(item.route) === '["apply"]',
        ),
    ).toBe(true);
    for (const argv of [["apply"], ["apply", "--all"]])
      expect(await contract.resolve(argv)).toMatchObject({
        ok: true,
        value: { commandIdentity: "specimen.apply" },
      });
  },
});
