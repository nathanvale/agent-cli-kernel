import { command } from "../../../../starters/contract3/src/kernel/index.ts";

const token = {
  name: "--token",
  aliases: [],
  summary: "A synthetic secret.",
  required: false,
  repeatable: false,
  value: {
    kind: "string",
    minLength: 1,
    maxLength: 4096,
    choices: null,
    pattern: null,
  },
} as const;
const tokenFile = {
  ...token,
  name: "--token-file",
  summary: "A file holding a synthetic secret.",
} as const;
export const input = {
  arguments: [],
  options: [token, tokenFile],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
export const none = { ...input, options: [] } as const;
export const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const plain = command({
  identity: "dxs.plain",
  route: ["plain"],
  summary: "Read specimen data without diagnostics.",
  input: none,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "dxs.plain", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read plain specimen data.",
        data: { plain: true },
        effects: empty,
      },
    ),
});

export function readData(records: number): {
  records: number;
  padding?: string;
} {
  const raw: unknown = JSON.parse(process.env.DXS_SCRIPT ?? "{}");
  const bytes: unknown =
    typeof raw === "object" && raw !== null
      ? Reflect.get(raw, "dataBytes")
      : undefined;
  return typeof bytes === "number"
    ? { records, padding: "y".repeat(bytes) }
    : { records };
}
