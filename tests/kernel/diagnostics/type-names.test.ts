import { expect, test } from "bun:test";
import { join } from "node:path";
import { probeBatch } from "../locks/lock-probes.ts";

const entry = join(
  import.meta.dir,
  "../../../kernel/src/addons/diagnostics/index.ts",
);
const probe = probeBatch("diagnostics-type-names-");
const aliases = probe(`
import { diagnosticsAddon } from ${JSON.stringify(entry)};
import type {
  DiagnosticsAddon, DiagnosticsAttached, StatusAddon, StatusAttached,
} from ${JSON.stringify(entry)};
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
export const addon: Same<StatusAddon, DiagnosticsAddon> = true;
export const attached: Same<StatusAttached, DiagnosticsAttached> = true;
export const factory: Same<ReturnType<typeof diagnosticsAddon>, DiagnosticsAddon> = true;
export const attachment: Same<ReturnType<DiagnosticsAddon["attach"]>, DiagnosticsAttached> = true;
`);

test(
  "deprecated diagnostics names and new names are the same public types",
  async () => {
    for (const compiler of ["native", "lint-view"] as const)
      expect(await aliases.compile(compiler)).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
  },
  probe.timeout(),
);
