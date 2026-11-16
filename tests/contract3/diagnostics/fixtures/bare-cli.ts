// LABELLED TEST-ONLY SPECIMEN CLI "dxs" WITHOUT the diagnostics add-on. It
// mirrors specimen-cli.ts (same routes, inputs, messages and data) with no
// diagnostics capability, no add-on import and no logging import, so its
// envelopes are the "diagnostics disabled" twin. Never registered, never ships.
import {
  command,
  contractFor,
  runProcess,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { empty, input, none, plain } from "./declarations.ts";

function records(): number {
  const raw: unknown = JSON.parse(process.env.DXS_SCRIPT ?? "{}");
  const value: unknown =
    typeof raw === "object" && raw !== null
      ? Reflect.get(raw, "records")
      : undefined;
  return typeof value === "number" ? value : 1;
}

const read = command({
  identity: "dxs.read",
  route: ["read"],
  summary: "Read specimen data.",
  input,
  capabilities: {},
  run: (_input, context) =>
    process.env.DXS_THROW === "1"
      ? Promise.reject(new Error("specimen handler fault"))
      : context.result(
          { commandIdentity: "dxs.read", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Read specimen data.",
            data: { records: records() },
            effects: empty,
          },
        ),
});

const spawn = command({
  identity: "dxs.spawn",
  route: ["spawn"],
  summary: "Run one child program.",
  input: none,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "dxs.spawn", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Ran the specimen program.",
        data: { exitCode: 0 },
        effects: empty,
      },
    ),
});

const contract = contractFor({
  cli: "dxs",
  commands: [read, plain, spawn],
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
