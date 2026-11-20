import { writeFile, readFile } from "node:fs/promises";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runProcess,
  station,
} from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";
import { stateAddon } from "agent-cli-kernel/addons/state";

const handoff = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

const causes = {
  ...commonCauses,
  DOMAIN_NOTES_HELD: handoff,
  DOMAIN_NOTES_UNRESOLVED: handoff,
  DOMAIN_NOTES_UNAVAILABLE: handoff,
} as const satisfies CauseTable;

const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const text = {
  kind: "string",
  minLength: 1,
  maxLength: 4096,
  choices: null,
  pattern: null,
} as const;

const look = {
  owner: "operator",
  reason: "The note's change needs a look.",
  inspect: [{ kind: "command", command: "notes.pending", args: [] }],
} as const;

const state = stateAddon({
  root: process.env.NOTES_STATE ?? "notes-state-is-unset",
  report: "notes.pending",
});

const save = changing({
  identity: "notes.save",
  route: ["save"],
  summary: "Write a note's content to a file.",
  input: {
    ...noInput,
    arguments: [
      {
        name: "path",
        summary: "The note's file.",
        required: true,
        value: text,
      },
    ],
    options: [
      {
        name: "--content",
        aliases: [],
        summary:
          "The note's text. The text hold makes the change wait until it is stopped.",
        required: true,
        repeatable: false,
        value: text,
      },
    ],
  },
  capabilities: {},
  effectClass: "repository-local",
  effects: ["note.write"],
  ifNoResult: state.descriptor.ifNoResult,
  heldLockCause: "DOMAIN_NOTES_HELD",
  unresolvedCaseCause: "DOMAIN_NOTES_UNRESOLVED",
  stations: [
    station(causes, {
      ...words,
      commandIdentity: "notes.save",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "The note was written.",
      repairAction: null,
      guidance: {
        next: {
          kind: "instruction",
          text: "Read the note's file to see the change.",
        },
      },
      independentObservable: "notes.save:written",
    }),
    ...(
      [
        ["DOMAIN_NOTES_HELD", "Another change to this note is running."],
        [
          "DOMAIN_NOTES_UNRESOLVED",
          "An earlier change to this note never finished.",
        ],
        [
          "DOMAIN_NOTES_UNAVAILABLE",
          "The notes' state cannot take the change.",
        ],
      ] as const
    ).map(([causeCode, trigger]) =>
      station(causes, {
        ...words,
        commandIdentity: "notes.save",
        causeCode,
        trigger,
        repairAction: "Read the pending command's report.",
        guidance: { handoff: look },
        independentObservable: `notes.save:${causeCode}`,
      }),
    ),
  ],
  run: async (input, context) => {
    const outcome = await state.transaction(
      context.state,
      {
        command: "notes.save",
        scope: { resources: [{ resource: "note", key: input.path }] },
        facts: { path: input.path },
      },
      async (transaction) => {
        await transaction.record(
          "note.write",
          async () => {
            if (input["--content"] === "hold")
              await new Promise(() => setInterval(() => undefined, 1_000));
            await writeFile(input.path, input["--content"]);
          },
          async () =>
            (await readFile(input.path, "utf8")) === input["--content"],
        );
      },
    );
    if (outcome.kind !== "ran") {
      const causeCode =
        outcome.kind === "held-lock"
          ? "DOMAIN_NOTES_HELD"
          : outcome.kind === "unresolved-case"
            ? "DOMAIN_NOTES_UNRESOLVED"
            : "DOMAIN_NOTES_UNAVAILABLE";
      return context.result(
        { commandIdentity: "notes.save", causeCode },
        {
          message: `The change was refused: ${outcome.kind}.`,
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      );
    }
    return context.result(
      { commandIdentity: "notes.save", causeCode: "SUCCESS_COMPLETED" },
      {
        message: `Wrote ${input.path}.`,
        data: null,
        transaction: outcome.proof,
      },
    );
  },
});

const pending = command({
  identity: "notes.pending",
  route: ["pending"],
  summary: "List the changes that never finished.",
  input: noInput,
  capabilities: {},
  stations: [
    station(causes, {
      ...words,
      commandIdentity: "notes.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The notes' state was read.",
      repairAction: null,
      guidance: {
        next: {
          kind: "instruction",
          text: "Read each unfinished change before another.",
        },
      },
      independentObservable: "notes.pending:listed",
    }),
  ],
  run: (_input, context) => {
    const report = state.report();
    return context.result(
      { commandIdentity: "notes.pending", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Unfinished changes.",
        data: {
          unfinished: report.ok
            ? report.unfinished.map((entry) => ({
                operationId: entry.operationId,
                commandIdentity: entry.commandIdentity,
              }))
            : [],
        },
        effects: {
          completed: [],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        },
      },
    );
  },
});

await runProcess(
  contractFor({
    cli: "notes",
    commands: [save, pending],
    causes,
    state: state.descriptor,
    installedAddons: ["state"],
  }),
  { emergencyRecord: state.emergencyRecord },
)(process.argv.slice(2));
