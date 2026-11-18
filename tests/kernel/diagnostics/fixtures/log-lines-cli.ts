import {
  command,
  contractFor,
  runProcess,
} from "../../../../kernel/src/kernel/index.ts";
import type { JsonValue } from "../../../../kernel/src/kernel/index.ts";
import { diagnosticsAddon } from "../../../../kernel/src/addons/diagnostics/index.ts";
import { empty, input } from "./declarations.ts";

function scripted(key: string): unknown {
  const raw: unknown = JSON.parse(process.env.DXS_SCRIPT ?? "{}");
  return typeof raw === "object" && raw !== null
    ? Reflect.get(raw, key)
    : undefined;
}

const read = command({
  identity: "dxs.read",
  route: ["read"],
  summary: "Read specimen data while the host's logger writes its lines.",
  input,
  capabilities: { diagnostics: true },
  run: (parsed, context) => {
    const oversize = scripted("oversize");
    const unlisted = scripted("unlisted");
    const line = (name: string, pad = 0): JsonValue => ({
      message: `${name} line for ${parsed["--token"] ?? "nobody"}`,
      annotations: { password: "log-line-password", pad: "x".repeat(pad) },
    });
    context.diagnostics.record("log", line("unlevelled"));
    context.diagnostics.record("log", line("trace"), "trace");
    context.diagnostics.record("log", line("debug"), "debug");
    context.diagnostics.record("log", line("info"), "info");
    if (unlisted !== undefined)
      Reflect.apply(context.diagnostics.record, context.diagnostics, [
        "log",
        line("unlisted"),
        unlisted,
      ]);
    context.diagnostics.record("log", line("warning"), "warning");
    context.diagnostics.record(
      "log",
      line("error", typeof oversize === "number" ? oversize : 0),
      "error",
    );
    context.diagnostics.record("log", line("fatal"), "fatal");
    return context.result(
      { commandIdentity: "dxs.read", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read specimen data.",
        data: { lines: 7 },
        effects: empty,
      },
    );
  },
});

const contract = contractFor({
  cli: "dxs",
  commands: [read],
  installedAddons: ["diagnostics"],
});

const argv = process.argv.slice(2);
await runProcess(contract, {
  addons: {
    diagnostics: diagnosticsAddon({
      cli: "dxs",
      environment: process.env,
      argv,
      secrets: { options: ["--token"] },
    }),
  },
})(argv);
