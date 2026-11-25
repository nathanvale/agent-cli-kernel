# Agent CLI kernel glossary

This file is the source of truth for the words this repository owns: the
kernel, its add-ons, how a repository installs them, where this source was
carried from, and how a CLI built on the kernel is verified. The template's
`GLOSSARY.md` owns the template's words. `GLOSSARY-MAP.md` names the glossary
that owns every other word. The shared tool words are the template's, copied
here from a recorded revision.

The kernel repository's workflow at `.github/workflows/ci.yml` is named
**Hosted check**. Its job names provide the required status checks. In
`package.json`, `format:check` checks formatting and `format` writes it.

## Language

An `_Avoid_` line lists words not to use for its term. A note in parentheses
says when: it covers the words before it, back to the previous note or
semicolon. The writer and the reviewer hold those words, because the names
check cannot tell what a name means. The names check refuses a word with no note
after it in every file and folder name and public declaration name. It refuses a word noted
`(unqualified)` as a whole name only when
[Words that need a qualifier](#words-that-need-a-qualifier) also lists it.

### Source and ancestry

**Kernel repository**:
The repository that is the canonical owner of the kernel and add-on source and
of their tests.
_Avoid_: core repository, kernel package (for the repository: the package is what a consumer installs)

**Carry-out**:
The single commit that brought the kernel, the add-ons, their tests and the
files they need, unedited, into this repository. It is also called the
**carry-out commit**.
_Avoid_: the move (it does not say what moved), extraction, split commit

**Prepared parent**:
The commit directly before the carry-out commit: the only parent it has. It
holds the source as it stood when it was prepared for the carry-out.
_Avoid_: base commit, parent (unqualified)

**Carry-out identity**:
The full identity of the carry-out commit on this repository's main branch.
No pin may name an earlier commit.
_Avoid_: floor (unqualified), baseline

**Kernel repository alignment**:
This repository later adopting the tooling that was carried with it, while it
stays the kernel's own source and uses no installed copy of itself.
_Avoid_: Template upgrade (for alignment)

**Recorded origin**:
The repository and the full commit this repository's source was carried from,
kept as a label for people. Tools check only its shape; no gate decides
anything else from it.
_Avoid_: citable origins, cited-commit list (for a recorded origin)

### Installation and add-ons

**Pin**:
A record of the kernel repository and one full commit in it. That commit
identifies the kernel; a pin has no version number. Say kernel pin wherever a
toolchain pin could be meant.
_Avoid_: version, release (for a kernel pin), pointer (say pin), pin record (say pin), lock (for a pin)

**Pinned commit**:
The one full commit that a pin names.
_Avoid_: tag, branch, short hash (for a pinned commit)

**Installed kernel**:
The kernel as a consuming repository holds it: installed as a package at a
pin, imported by its package name, with none of its source owned there.
_Avoid_: vendored kernel, kernel copy (for the installed kernel)

**Kernel package**:
What a consuming repository installs at a pin: the kernel, its add-ons, the
kernel's lint and the skills it ships. It is named `agent-cli-kernel`.

**Author skill**:
The guidance the kernel package ships for an agent writing and testing
commands on the kernel.
_Avoid_: author guide (for the shipped guidance)

**Add-on**:
An optional capability that uses the kernel's public interface without
importing or patching another add-on, and may have a required add-on that must
be selected alongside it. The five are the state, programs, approval,
diagnostics and menu add-ons.

**State add-on**:
The add-on that owns the journal and the state a changing command works in.

**supersedeUnresolved**:
A changing command's promise that it is safe to run again, even alongside a
leftover copy of a program an earlier run started; with it, the next run of
the same kernel command whose declared resources cover the dead case's
declared resources closes that unresolved case as outcome unknown and names
it in its result as superseded.
_Avoid_: retry, force, reclaim (for supersedeUnresolved)

**Programs add-on**:
The add-on that owns starting and stopping the programs a command runs.

**Approval add-on**:
The add-on that checks authority before a command attempts its approved
effects.

**ApprovalRejection**:
The approval add-on's public error when authority storage, exclusive
coordination or confirmation of durable consumption prevents an approved effect
from starting. Its `reason` identifies the error and `consumed` distinguishes
an unconsumed refusal from a failure after grant consumption.
_Avoid_: refusal (for every ApprovalRejection, since some follow consumption)

**Diagnostics add-on**:
The add-on that owns the diagnostic records of a run and their custody.

**Menu**:
The add-on ability to show rows on a terminal in an interactive run and hand
back the one a person picks, or `"cancelled"`. Separate from a CLI's own
command routed as `menu`.
_Avoid_: pick list, picker, chooser, prompt (for a menu)

**Menu add-on**:
The add-on that owns the menu and restoring the terminal.

**Add-on selection**:
The add-ons one consuming repository uses. The kernel is always used and is not
part of the selection.
_Avoid_: starter, profile, variant (for an add-on selection)

**Add-on requirement**:
A package an add-on needs in order to run, which the kernel carries as an
ordinary dependency. The diagnostics add-on's logging packages are add-on
requirements.
_Avoid_: optional peer (for an add-on requirement); dependency (unqualified)

**Required add-on**:
An add-on that another selected add-on needs alongside it. The state add-on
is a required add-on of the approval add-on.
_Avoid_: add-on prerequisite; add-on requirement (for another add-on, rather than a package)

**Kernel declaration**:
The kernel repository's own statement, read at one commit, of its kernel and
add-on folders and of the add-ons each add-on requires.
_Avoid_: manifest (for a kernel declaration), hand-kept list

### Command results

**Repair action**:
The fixed repair guidance a station declares for Command Contract 3's
`repairAction` field. It is `null` on success and otherwise explains the
repair or the named handoff.
_Avoid_: Repair (for a station's guidance; Repair names a tool message's Repair: line)

**Kernel station**:
A station the kernel adds to a command without an author declaration, covering
usage refusals and internal failures.
_Avoid_: built-in station (for a kernel station)

### Interactive runs

**Default command**:
The one ordinary command a CLI names, with `defaultCommand`, to run when no
words are typed after its name in an interactive run.
_Avoid_: bare-name command; root command (a root operation is Command Contract 3's route-`[]` command, which this is not); front door (in a name)

**Interactive run**:
A run that has a terminal adapter (in a process: both stdin and stdout are
terminals) and whose typed words hold no `--json`.
_Avoid_: terminal run

**Terminal adapter**:
The kernel's seam for reading keys from and drawing on a terminal: the
`/dev/tty` adapter in a process, or `scriptedTerminal` in tests.

### CLI source layout

**Subject**:
The domain noun a group of commands acts on, named by the first word of their
route.
_Avoid_: feature (for a subject), resource (a resource is a state add-on coordination lock target), domain (for a subject), slice, topic

**Shared edge**:
A module in `src/shared/` used across subjects that touches external state,
settings, child programs or the CLI's shared cause table, or holds logic those
subjects share that cannot live in one subject's `rules.ts`.
_Avoid_: util, helper, common, core (for a shared edge)

### Internal kernel names

**Directive**:
A comment a tool reads as an instruction rather than as prose, in that tool's
exact form: `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`,
`eslint-enable`, `@ts-expect-error`, `@ts-ignore`, line-only `@ts-nocheck` or
`@ts-check`, `biome-ignore` (`-all`, `-start`, `-end`),
`fallow-ignore-next-line` or `fallow-ignore-file`. The comment rule admits a
comment as a directive only when it is one in that form; prose after a
directive-looking word is refused.
_Avoid_: pragma, annotation (for a directive)

**Contract boundary**:
The public set of authority identity, resource identity and absolute path
constructors exposed as `contractFor().boundary`. Their values carry the
kernel's validated identity and path types into a command's code.

**Names check result**:
The names check's `NamesCheckResult`: stderr text and a numeric process exit
code. It is a script result, separate from Command Contract 3's Outcome.

**Validate inspect shape**:
`validateInspectShape` checks an inspect command declaration's fields before
construction or registration. It does not admit a command for a run.

**Validate changing shape**:
`validateChangingShape` checks a changing command declaration's fields before
construction or registration. It does not admit a command for a run.

**Lock probe**:
A compiler input used by the kernel's lock tests to check a type constraint
with the native and lint-view compilers. `lock-probes.ts` owns their batch
runner. This is separate from verify-cli's Probe of a target CLI.

**Diagnostics add-on**:
The optional diagnostics capability. `DiagnosticsAddon` is its public type;
`DiagnosticsAttached` is the attachment to one run, including its bounded
`freeze` operation. `StatusAddon` and `StatusAttached` remain exported as
deprecated aliases of those types under accepted decision N11.

**Rooted file**:
A path derived or given from outside under a folder root, read with
`readRootedFile` from `agent-cli-kernel/rooted-file` (implemented in
`kernel/src/shared/rooted-file.ts`). It reads regular files inside the
resolved root up to a byte limit, and refuses paths outside the root,
symbolic links, linked folders, hard links, non-regular files, over-limit
files and post-open swaps, returning a `RootedRefusal` whose message ends
with a `Repair:` line.
_Avoid_: safe path, guard (unqualified), helper (for a rooted-file module)

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

### Fault replay timings

**Fault timing**:
The seconds one planted fault took to replay, kept in its own file beside
the fault records. Fault replay's shard planner balances its parts by them,
and counts a fault with no timing as a short one.

### Shared tool words

**Toolchain pin**:
The one Bun version a repository runs on. Its doctor fails when the running Bun is
another version.

**Check command**:
The one command a repository runs to show that it is sound. The template, the
kernel repository and every generated repository each have their own.
_Avoid_: check (unqualified)

**Hosted check**:
A repository's check command and gates as its forge runs them on pull requests
and pushes.
The template's pull-request workflow is named `Hosted check`.
_Avoid_: CI (unqualified)

**Gate**:
A required validation that can refuse a change before it lands in a repository.
_Avoid_: proof, admission, guard (for a gate), check (unqualified)

**Test surface**:
An Interface that tests drive the way a caller does.
_Avoid_: test seam (a Seam is where behaviour can vary; nothing varies at a test surface)

**Test area**:
A named set of tests that runs on its own.

**Process runner**:
The module that starts a child process for a script or test, in its own process
group and under an optional time limit.

**Negative control**:
A break made on purpose to show that a test or gate can fail. It can be made once by
hand, or kept.
_Avoid_: mutation; canary (for a negative control)

**Planted fault**:
A negative control kept as a patch, which the test named in its fault record
must keep catching.
_Avoid_: mutant, mutation; canary (for a planted fault)

**Fault record**:
The entry that names a planted fault, the test that must catch it, and the
commit it undoes.

**Fault replay**:
A run that applies each selected planted fault's patch in a temporary worktree,
where its named test must pass without the patch and fail with it.

**Anchor**:
The text that places one changed region of a planted fault's patch: the lines the
region removes or, when it only adds lines, the unchanged lines next to it.

**Recorded hit**:
A violation that already existed when its gate landed. The record gives its
reason and lets the gate pass until a commit fixes it.
_Avoid_: known hit, allowlist, baseline

**Refusal**:
A tool declining to act before it changes anything. Its message names the
cause and the repair.
_Avoid_: rejection (for a refusal)

**Repair**:
The next step a failure message tells the reader to take.
_Avoid_: fix (for the step; a fix is a commit)

**Verdict**:
The result of judging one thing once: one planted fault in a fault replay, or
one commit at the per-commit gate.

**Doctor**:
The command that checks, before work starts, that a checkout can run the
repository's check command and gates, and names a repair for each failure.

**Toolchain**:
The tools a repository's check command and gates use, at the accepted versions:
Bun, the linter, the compiler and the dead-code tool.
Run `format:check` to check formatting without writing, and `format` to write it.

**Lint rule**:
One rule the linter enforces on code, with a message that names its repair. A
lint rule can be the gate of a rule row.
_Avoid_: rule (unqualified)

**Names check**:
The check that holds every tracked file and folder name to the glossary's
words, and applies the same rules to public declarations through the symbol gate.
_Avoid_: names gate (for the names check)

**Symbol gate**:
The part of the names check that applies the glossary's Avoid and Qualify rules
to public declaration names. Its refusal gives the file, line, name, rule and repair.

**Public surface**:
The per-repository file selection the symbol gate reads. The template selects
exports in Bootstrap's copied code and consumed exports in `src/*.ts`.
The kernel selects its package entry points.

**Public declaration**:
An exported name on the public surface, including immediate public members,
parameters and return properties. Private members, locals and nested members
are outside it. A recorded hit names its file and declaration independently of
line numbers, for example `CommandResult.proof` in its `declaration` field.

**Repo gardener**:
The role that keeps the rule table and the names true. Its four jobs are Sow,
Gate, Weed and Stake.
_Avoid_: steward, janitor

**Sow**:
The repo gardener's job of recording the lesson of a correction or review
finding beside its witness.

**Weed**:
The repo gardener's job of removing a rule row, guide bullet, link definition
or reference that nothing uses any more.
_Avoid_: clean up, prune

**Stake**:
The repo gardener's job of holding a file or folder name to the glossary's
words.

**Rule row**:
One coding standard in the rule table, with what enforces it today.

**Witness**:
A commit or review thread that shows a mistake: the commit that fixed it, the
review thread that caught it, or a commit that carries it.

**Gate note**:
The note, kept in a repository's standards, that says what a rule row's gates
refuse and where, what stays with the reviewer, and which witnesses taught it.

**Citable origins**:
The repositories, other than a repository itself, whose commits and review
threads a citation in that repository's standards may name.
_Avoid_: recorded origin (that is one repository and one commit), allowed hosts

**Claim tag**:
The mark on a claim in a plan that says how sure it is: passed on Linux,
passed on macOS only, designed and not run, decided by Nathan, or open.
_Avoid_: confidence, status (for a claim tag), proven (for a prototype run)

## Words that need a qualifier

Each of these words names different things in different projects. In the name
of a file, a folder, a test, a commit or a public declaration, pair it with a word that says which
one you mean, as `test-proof` does.

_Qualify_: host, project, starter, profile, proof, manifest, probe, copy, dependency, reader, checker, migration, parent, floor, owner, guard, layout
