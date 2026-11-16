// The diagnostics add-on (CMD-16, DIAG-17): the only owner of durable
// diagnostics and of the logging dependency. It imports only the kernel's
// public index. A host installs it by listing "diagnostics" in
// `installedAddons` and passing `diagnosticsAddon(...)` as
// `addons.diagnostics`; a command that declares the capability then gets one
// private, bounded log per run and a diagnostics status in its envelope.
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
