import { nodeIo } from "./io.ts";
import { createDiagnostics } from "./run.ts";
import type { DiagnosticsOptions, StatusAddon } from "./run.ts";

export type {
  DiagnosticsOptions,
  SecretSources,
  StatusAddon,
  StatusAttached,
} from "./run.ts";

export function diagnosticsAddon(options: DiagnosticsOptions): StatusAddon {
  return createDiagnostics(options, nodeIo);
}
