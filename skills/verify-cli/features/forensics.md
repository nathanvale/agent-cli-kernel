# Kernel-free forensics

An operator or agent inspects raw on-disk artifacts from a failed, wedged,
or post-cleanup verification run, a state add-on journal, a diagnostics
custody folder, or an approval store without importing `agent-cli-kernel`
and without writing, locking, or mutating any file.

## Sub-features

- `forensics-run` verifies `evidence/index.jsonl` SHA-256 hashes, reports
  unmet steps, `contract.*` failures, repository drift, scratch presence,
  and the helper's `state/` folder.
- `forensics-state` decodes a v1 or v2 `C3S1` state journal (`format`,
  `coordination/`, `staging/`, `operations/`, `settled/`), checks private
  permissions on the root and all subfolders, validates record shapes,
  reports torn tails and their byte offsets, mid-line records hidden in torn
  tails, `delegate-admitted` boot identities, `leaseFilePresent` (file
  existence only; forensics never acquires or probes locks), `nextAction`
  for unresolved cases, and closure `journalRevision` matches.
- `forensics-diagnostics` checks directory permissions and trusted
  ancestors, `.allocation-lock` owner PID/host, `.pending`/`.retiring`
  residue, `.closed-*` marker matches or orphans, unclosed file counts, and
  bounded JSONL line summaries. Status precedence is `"issues"` (any
  problem), then `"unknown"` (no problems, but at least one unclosed file
  whose run may still be alive or may have crashed before closing, since
  the allocation lock is released on open), then `"clean"`.
- `forensics-approval` decodes `*.consumed` markers and grant, closure, or
  stop JSON records against kernel admission and shape rules (strict UTF-8,
  single link, 16 KiB limit, exact keys), flagging expired or malformed
  entries.

## How to get to it (user POV)

- `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics run <run folder> [--json]`
- `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics state <state root> [--json]`
- `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics diagnostics <diagnostics folder> [--json]`
- `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics approval <approval folder> [--json]`

## Driving it with verify-cli

Preconditions: an existing folder for the chosen target (`run`, `state`,
`diagnostics`, or `approval`). Neither a working kernel installation nor a
passing `ready` check is required.

Without `--json`, each successful command prints its summary line followed
by indented `verify-forensics/1` JSON:

```text
$ bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics run <run folder>
Verification run (scratch removed): 2 step(s) (0 unmet), 0 problem(s).
$ bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts forensics state <run folder>/state --json
{"schema":"verify-forensics/1","target":"state",...}
```

A readable target exits 0 even when `"status"` is `"issues"` or `"unknown"`
(like `findings`, read `problems` and `status` in the output). For
`diagnostics`, `"status": "unknown"` leaves `problems` empty and means at
least one log file has no closed marker: check whether the run is still
alive before treating it as a crash. Usage errors (missing kind, unknown
kind, extra arguments, unknown option) exit 2; a missing, symlinked, or
unreadable target path exits 3.

## Gotchas

- `forensics` stays strictly kernel-free: it runs before `kernelImport` and
  `helperProbe`, so it still diagnoses artifacts when `ready` or `drive`
  exits 70 (`RAW FAIL`).
- `forensics` never creates, locks, or edits files. Running it on a
  verification run leaves every SHA-256 hash in `evidence/index.jsonl`
  unchanged so `report` still trusts the run afterward.
- Directory listings cap at 1,024 entries and diagnostics JSONL scans cap at
  2,048 lines per file; when a cap is hit, the report sets `truncated: true`.
