import { nodeIo } from "./io.ts";
import { createDiagnostics } from "./run.ts";
import type { DiagnosticsOptions, DiagnosticsAddon } from "./run.ts";

export type {
  DiagnosticsOptions,
  SecretSources,
  StatusAddon,
  StatusAttached,
  DiagnosticsAddon,
  DiagnosticsAttached,
} from "./run.ts";

export function diagnosticsAddon(
  options: DiagnosticsOptions,
): DiagnosticsAddon {
  return createDiagnostics(options, nodeIo);
}
