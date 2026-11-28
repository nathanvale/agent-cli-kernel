# verify-cli glossary

This file holds the words of verify-cli; `GLOSSARY-MAP.md` lists every glossary.

### Verifying a CLI

**verify-cli**:
The skill that ships in the kernel package beside the author skill, at
`skills/verify-cli/`, and shows that a CLI built on the kernel works the way
a user meets it.
_Avoid_: verification skill (in a name)

**Kernel-free check**:
verify-cli's front door, `verify.ts`, through which every command starts.
No kernel code runs in its process: it imports the kernel in a child,
probes the helper with a command it does not declare, compares the
helper's probes of the target with raw runs, and confirms each evidence
file against its hash. A run it cannot trust prints `RAW FAIL` lines and
exits 70; a target that answers its probes differently on every run
prints `TARGET FAIL` lines and exits 3.
_Avoid_: shell, wrapper (for the kernel-free check)

**Forensic command**:
The kernel-free, read-only `forensics` command on `verify.ts` that decodes a
verification run, a state add-on journal, a diagnostics custody folder, or an
approval store without importing `agent-cli-kernel` and without mutating any
file or lock.

**Helper**:
verify-cli's own CLI, built on the kernel, which the kernel-free check
starts for every command.

**Target**:
The CLI that verify-cli judges, named by its entry file. The helper starts
it as a separate process and never imports it.
_Avoid_: app (for a target)

**Probe**:
One fixed run of the target, an undeclared option or `--discover --json`,
that `ready` judges and the kernel-free check compares with a raw run.

**Verification run**:
One folder that `launch` makes, new or empty and outside every git work
tree, bound to one target for its whole life. It holds the scratch folder,
the evidence folder and the helper's own state.
_Avoid_: session (for a verification run)

**Scratch folder**:
The folder of a verification run that steps may fill, written `{scratch}`
in a scenario. Cleanup removes it.

**Evidence folder**:
The folder of a verification run that keeps one evidence file per step,
and the run's index: a row binding the run to its target, then a row per
step with its file's SHA-256 hash. Cleanup never removes it.
_Avoid_: receipts (for the evidence folder)

**Step**:
One run of the target, or of Bun, in a scenario, with the expectations its
author wrote. `drive` judges it met or unmet and keeps it as one evidence
file.

**Scenario**:
One feature's steps, in a scenario file, each with exact expectations its
author wrote from what the feature must do, never from the target's
discovery.

**Sweep**:
The checks the target's own discovery implies for every command: help,
usage refusals, exit codes and streams. It trusts the declarations.

**Finding**:
One failed check of `ready` or of a sweep, with what it expected and what
it saw.

**Owed result**:
A required station of the target's own commands that neither the sweep nor
a met `--json` step of the verification run has reached. A run of the
sweep reaches a station only when every check on that run passed. A
station the kernel adds is left out.

**Contract check**:
A check `drive` makes unasked on every target step that ended by itself:
an envelope's exit code is the process's, `--json` prints one envelope and
nothing on stderr, and a failed run prints nothing on stdout.

**Self-verification**:
The kernel's own test area that runs verify-cli on every change against two
CLIs: the helper, which it sweeps, and the author skill's example, which it
launches, drives with the scenario verify-cli's read-only feature file
shows, and reports on. Its station record, `stations.json`, lists each
station that each run reaches, as swept, driven or owed, and the helper's
check count. It fails, printing a repair, on a run verify-cli cannot trust,
a finding (quoting each failed check), an unmet step (quoting what was
expected and observed), an unconfirmed process end, a sweep with no check,
a report with nothing driven, and any station or count that differs from
the record.
