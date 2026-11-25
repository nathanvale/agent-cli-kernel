import { describe, expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { CauseTable, Envelope } from "../../kernel/src/kernel/index.ts";
import {
  runInProcessOn,
  runProcessOn,
} from "../../kernel/src/kernel/lifecycle.ts";
import { emptyInput, stationWords, unchanged } from "./kernel-repair/shapes.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const expectedAllPaths = [
  "specimen.command-discovery",
  "specimen.discovery",
  "specimen.dispatch",
  "specimen.full-discovery",
  "specimen.help",
  "specimen.list",
  "specimen.read",
] as const;

const specimenCauses = {
  ...commonCauses,
  DOMAIN_MISSING: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

function streamText(
  writes: readonly {
    readonly stream: "stdout" | "stderr";
    readonly text: string;
  }[],
  stream: "stdout" | "stderr",
): string {
  return writes
    .filter((entry) => entry.stream === stream)
    .map((entry) => entry.text)
    .join("");
}

function buildContract() {
  const list = command({
    identity: "specimen.list",
    route: ["list"],
    summary: "List items.",
    input: { ...emptyInput, deadlineSupported: true },
    capabilities: {},
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: "specimen.list",
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        {
          message: "Listed items.",
          data: { items: ["alpha"] },
          effects: unchanged,
        },
      ),
  });
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read one item.",
    input: {
      ...emptyInput,
      arguments: [
        {
          name: "name",
          summary: "Item name.",
          required: true,
          value: {
            kind: "string",
            minLength: 2,
            maxLength: 32,
            choices: null,
            pattern: null,
          },
        },
      ],
    },
    capabilities: {},
    stations: [
      station(specimenCauses, {
        commandIdentity: "specimen.read",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The item exists.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: "specimen.read:ok",
        ...stationWords,
      }),
      station(specimenCauses, {
        commandIdentity: "specimen.read",
        causeCode: "DOMAIN_MISSING",
        trigger: "No item has that name.",
        guidance: {
          next: { kind: "command", command: "specimen.list", args: [] },
        },
        repairAction: "List items and choose an existing name.",
        independentObservable: "specimen.read:missing",
        ...stationWords,
      }),
    ],
    run: (input, context) => {
      if (input.name === "throw") throw new Error("Simulated handler crash.");
      if (input.name === "missing")
        return context.result(
          {
            commandIdentity: "specimen.read",
            causeCode: "DOMAIN_MISSING",
          },
          {
            message: "No item named missing.",
            data: null,
            effects: unchanged,
          },
        );
      return context.result(
        {
          commandIdentity: "specimen.read",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          message: `Read ${input.name}.`,
          data: { name: input.name },
          effects: unchanged,
        },
      );
    },
  });
  return contractFor({
    cli: "specimen",
    causes: specimenCauses,
    commands: [list, read],
  });
}

async function envelopeFor(argv: readonly string[]): Promise<Envelope> {
  const ran = await runInProcess(buildContract())(argv);
  if (ran.kind !== "envelope")
    throw new Error(`Expected envelope, got ${ran.kind}.`);
  return ran.envelope;
}

describe("availablePaths", () => {
  test("help carries every declared command identity sorted", async () => {
    for (const argv of [["--help"], ["--help", "--json"]]) {
      const envelope = await envelopeFor(argv);
      expect(envelope.contractVersion).toBe("3.0.0");
      expect(envelope.result.commandIdentity).toBe("specimen.help");
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.availablePaths).toEqual([...expectedAllPaths]);
    }
  });

  test("discover carries every declared command identity sorted", async () => {
    for (const argv of [["--discover"], ["--discover", "--json"]]) {
      const envelope = await envelopeFor(argv);
      expect(envelope.contractVersion).toBe("3.0.0");
      expect(envelope.result.commandIdentity).toBe("specimen.discovery");
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.availablePaths).toEqual([...expectedAllPaths]);
    }
  });

  test("discover-command carries every declared command identity sorted", async () => {
    for (const argv of [
      ["--discover-command", "specimen.list"],
      ["--discover-command", "specimen.list", "--json"],
    ]) {
      const envelope = await envelopeFor(argv);
      expect(envelope.contractVersion).toBe("3.0.0");
      expect(envelope.result.commandIdentity).toBe(
        "specimen.command-discovery",
      );
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.availablePaths).toEqual([...expectedAllPaths]);
    }
  });

  test("discover-all carries every declared command identity sorted", async () => {
    const envelope = await envelopeFor(["--discover-all", "--json"]);
    expect(envelope.contractVersion).toBe("3.0.0");
    expect(envelope.result.commandIdentity).toBe("specimen.full-discovery");
    expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(envelope.availablePaths).toEqual([...expectedAllPaths]);
  });

  test("unknown-command refusal carries every declared command identity sorted", async () => {
    for (const argv of [["nosuch"], ["nosuch", "--json"]]) {
      const envelope = await envelopeFor(argv);
      expect(envelope.contractVersion).toBe("3.0.0");
      expect(envelope.result.commandIdentity).toBe("specimen.dispatch");
      expect(envelope.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
      expect(envelope.availablePaths).toEqual([...expectedAllPaths]);
    }
  });

  test("declared command results, invalid invocation, kernel stations and --json carry empty availablePaths", async () => {
    const cases: readonly (readonly [readonly string[], string, string])[] = [
      [["list"], "specimen.list", "SUCCESS_UNCHANGED"],
      [["list", "--json"], "specimen.list", "SUCCESS_UNCHANGED"],
      [["read", "missing"], "specimen.read", "DOMAIN_MISSING"],
      [["read", "missing", "--json"], "specimen.read", "DOMAIN_MISSING"],
      [[], "specimen.dispatch", "USAGE_INVALID_INVOCATION"],
      [["--json"], "specimen.dispatch", "USAGE_INVALID_INVOCATION"],
      [["list", "--unexpected"], "specimen.list", "USAGE_INVALID_INVOCATION"],
      [
        ["list", "--unexpected", "--json"],
        "specimen.list",
        "USAGE_INVALID_INVOCATION",
      ],
      [["read", "x"], "specimen.read", "USAGE_INVALID_INVOCATION"],
      [["read", "x", "--json"], "specimen.read", "USAGE_INVALID_INVOCATION"],
    ];
    for (const [argv, identity, causeCode] of cases) {
      const envelope = await envelopeFor(argv);
      expect(envelope.contractVersion).toBe("3.0.0");
      expect(envelope.result.commandIdentity).toBe(identity);
      expect(envelope.result.causeCode).toBe(causeCode);
      expect(Object.hasOwn(envelope, "availablePaths")).toBe(true);
      expect(envelope.availablePaths).toEqual([]);
    }
    for (const argv of [
      ["list", "--deadline-ms", "100"],
      ["list", "--deadline-ms", "100", "--json"],
    ]) {
      const clockHost = recordingHost();
      let calls = 0;
      const ran = await runInProcessOn(buildContract(), {}, () => ({
        ...clockHost.host,
        now: () => (calls++ === 0 ? 0 : 1_000),
      }))(argv);
      if (ran.kind !== "envelope")
        throw new Error(`Expected envelope, got ${ran.kind}.`);
      expect(ran.envelope.contractVersion).toBe("3.0.0");
      expect(ran.envelope.result.commandIdentity).toBe("specimen.list");
      expect(ran.envelope.result.causeCode).toBe(
        "DOMAIN_DEADLINE_BEFORE_START",
      );
      expect(Object.hasOwn(ran.envelope, "availablePaths")).toBe(true);
      expect(ran.envelope.availablePaths).toEqual([]);
    }
    const jsonHost = recordingHost();
    await runProcessOn(
      buildContract(),
      {},
      () => jsonHost.host,
    )(["list", "--json"]);
    const parsed: unknown = JSON.parse(streamText(jsonHost.writes, "stdout"));
    expect(parsed).toMatchObject({
      contractVersion: "3.0.0",
      availablePaths: [],
      result: {
        commandIdentity: "specimen.list",
        causeCode: "SUCCESS_UNCHANGED",
      },
    });
    const humanHost = recordingHost();
    await runProcessOn(buildContract(), {}, () => humanHost.host)(["list"]);
    expect(humanHost.exits).toEqual([0]);
    expect(streamText(humanHost.writes, "stdout")).toContain("Listed items.");
    expect(streamText(humanHost.writes, "stderr")).toBe("");
  });

  test("fallback result carries empty availablePaths", async () => {
    const envelope = await envelopeFor(["read", "throw"]);
    expect(envelope.contractVersion).toBe("3.0.0");
    expect(envelope.result.commandIdentity).toBe("specimen.read");
    expect(envelope.result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED");
    expect(Object.hasOwn(envelope, "availablePaths")).toBe(true);
    expect(envelope.availablePaths).toEqual([]);
  });

  test("validator accepts both full availablePaths and empty availablePaths on every result", async () => {
    const contract = buildContract();
    const listEnvelope = await envelopeFor(["list"]);
    const helpEnvelope = await envelopeFor(["--help"]);
    for (const base of [listEnvelope, helpEnvelope]) {
      expect(
        (
          await contract.validate({
            ...base,
            availablePaths: [...expectedAllPaths],
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await contract.validate({
            ...base,
            availablePaths: [],
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await contract.validate({
        ...listEnvelope,
        availablePaths: ["specimen.invented"],
      }),
    ).toMatchObject({
      ok: false,
      path: "availablePaths",
    });
  });
});
