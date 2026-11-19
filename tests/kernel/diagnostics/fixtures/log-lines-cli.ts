import {
  command,
  contractFor,
  runProcess,
} from "../../../../kernel/src/kernel/index.ts";
import type {
  DiagnosticsCapability,
  JsonValue,
} from "../../../../kernel/src/kernel/index.ts";
import { diagnosticsAddon } from "../../../../kernel/src/addons/diagnostics/index.ts";
import { empty, input, scriptValue } from "./declarations.ts";

type Line = (name: string, pad?: number) => JsonValue;

function sendUnlisted(diagnostics: DiagnosticsCapability, line: Line) {
  const unlisted = scriptValue("unlisted");
  if (unlisted !== undefined)
    Reflect.apply(diagnostics.record, diagnostics, [
      "log",
      line("unlisted"),
      unlisted,
    ]);
}

function sendEachLevel(diagnostics: DiagnosticsCapability, line: Line) {
  const oversize = scriptValue("oversize");
  diagnostics.record("log", line("unlevelled"));
  diagnostics.record("log", line("trace"), "trace");
  diagnostics.record("log", line("debug"), "debug");
  diagnostics.record("log", line("info"), "info");
  sendUnlisted(diagnostics, line);
  diagnostics.record("log", line("warning"), "warning");
  diagnostics.record(
    "log",
    line("error", typeof oversize === "number" ? oversize : 0),
    "error",
  );
  diagnostics.record("log", line("fatal"), "fatal");
}

function sendBurst(
  diagnostics: DiagnosticsCapability,
  line: Line,
  lines: number,
) {
  for (let sent = 0; sent < lines; sent += 1)
    diagnostics.record("log", line("burst"), "warning");
}

const read = command({
  identity: "dxs.read",
  route: ["read"],
  summary: "Read specimen data while the host's logger writes its lines.",
  input,
  capabilities: { diagnostics: true },
  run: (parsed, context) => {
    const line: Line = (name, pad = 0) => ({
      message: `${name} line for ${parsed["--token"] ?? "nobody"}`,
      annotations: { password: "log-line-password", pad: "x".repeat(pad) },
    });
    const burst = scriptValue("burst");
    if (scriptValue("alone") === true) sendUnlisted(context.diagnostics, line);
    else if (typeof burst === "number")
      sendBurst(context.diagnostics, line, burst);
    else sendEachLevel(context.diagnostics, line);
    return context.result(
      { commandIdentity: "dxs.read", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read specimen data.",
        data: { logged: true },
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
