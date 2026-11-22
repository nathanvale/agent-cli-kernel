# Keep `verify-cli` forensics strictly kernel-free

Status: accepted

`verify-cli` now includes a read-only `forensics` command (`verify.ts forensics <run|state|diagnostics|approval> <path>`) that decodes verification runs, `C3S1` state journals, diagnostics custody folders, and approval stores. We placed `forensics` on the **kernel-free** side of `verify.ts` (enforced by `kernel-free/no-kernel-import` in `config/verify-skill-lint.mjs`), routing before `kernelImport` and `helperProbe`, rather than implementing it as a Helper command on `agent-cli-kernel`.

## Considered Options

1. **Helper command on `agent-cli-kernel`** — gets Contract 3 envelopes, `--discover`, and sweep automatically, but stops working whenever `agent-cli-kernel` fails to import, throws on startup, or triggers exit `70` (`RAW FAIL`) during a kernel refactor.
2. **Kernel-free command routed by `verify.ts` (`skills/verify-cli/forensics.ts`)** — zero imports from `agent-cli-kernel` and zero write/lock syscalls; works even when the installed kernel cannot boot or the state add-on itself is broken.

## Consequences

- `skills/verify-cli/forensics.ts` duplicates minimal read-only framing/record decoding instead of importing kernel internals, preserving both `portable.test.ts` and `kernel-free/no-kernel-import`.
- `verify.ts forensics` does not emit a Command Contract 3 envelope (it emits `verify-forensics/1` JSON with `--json`), and it never acquires locks, opens descriptors for writing, or alters evidence SHA-256 hashes.
