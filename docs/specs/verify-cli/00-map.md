# `verify-cli`: a verification skill that ships with the kernel

This is the map of the specification. Status: proposed, not accepted (20
November 2026, Australia/Melbourne). It is the second version, after
correction rounds 1, 2 and 3. It describes `verify-cli` as merged into kernel
main at commit `f7f4d69`, by kernel pull request 56. Where that build has run
evidence, this specification follows it, and the first table below says where.
Once accepted, code follows this specification, never the reverse.

## In one screen

1. An agent in a generated repository gets a skill, `verify-cli`. It arrives
   with the repository's Pin and shows that the repository's command-line
   interface (CLI) works as a user meets it.
2. The skill's helper is a CLI built on the kernel. Its source lives in the
   skill's own folder, so the folder can be carried elsewhere. A small
   kernel-free check starts first, every time.
3. It judges in two layers: a sweep derived from the target's own discovery,
   and scenarios an author writes with exact expectations.
4. Evidence is plain files that outlive cleanup, each with a recorded hash.
5. Exit 70 means "do not trust this run". A target that cannot start is a
   refusal, exit 3, that quotes the target's own error.
6. There are 21 implementation decisions, 6 testing decisions, 62 acceptance
   criteria and 66 user stories. Each criterion names its test and its
   expected result.
7. The build passed its own instructions end to end on Linux and macOS, and
   its 218 tests on macOS.

## Where the inputs and the code disagreed

Each row is a place this specification follows the code, or a kernel standard,
over an input or over its own earlier text. Nathan should read these first.
The first table is where it now follows the build.

| Point                                                   | The second version said                                                                                      | The build, with run evidence                                                                                                                                               | Now                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A second `cleanup`                                      | It succeeds and removes nothing                                                                              | Refused, `DOMAIN_VERIFY_RUN_CLEAN`, exit 3. The kernel's proof refuses a changing command's success that changed nothing                                                   | I8, I14, AC33       |
| Effect names                                            | Nothing; round 1 first asked for `step.run` and `step.write`                                                 | One effect for each changing command: `run.create`, `scenario.drive`, `scratch.remove`. The first build's pair is gone                                                     | I4                  |
| `pending`                                               | A required run folder                                                                                        | Optional in its declaration; a missing folder is refused                                                                                                                   | I6, AC53            |
| `findings` and AC9                                      | AC9 asked for readiness check ids among findings                                                             | The sweep's findings only. `ready` names its own failed checks                                                                                                             | I6, AC9             |
| Scenario rules                                          | Nine ids                                                                                                     | Ten: `bad-value` for a wrong field type. `path-outside-scratch` for the path rule                                                                                          | I13, AC25           |
| Step verdicts                                           | Expectations only                                                                                            | Four contract checks on every target step, listed as `contract.<name>`                                                                                                     | I13, AC50           |
| `launch` refusals                                       | Three causes, and a git failure with none                                                                    | `DOMAIN_VERIFY_TARGET_MISSING` and `DOMAIN_VERIFY_GIT_FAILED` added                                                                                                        | I8, I14, AC20, AC21 |
| The probe comparison                                    | For commands that drive a target                                                                             | For `launch` too, so a kernel fault is not blamed on the repository                                                                                                        | I18, AC11           |
| Stop signals                                            | Not covered                                                                                                  | The check stops the helper and the target, then exits 130 or 143                                                                                                           | I18, AC49           |
| Entry files                                             | Each only starts something                                                                                   | `verify.ts` holds the check's functions too, so the scoped exception stays on one file                                                                                     | I19, TD2            |
| The lint exception                                      | Two rules turned off for one file                                                                            | Only the two bans lifted; the state add-on factory ban stays                                                                                                               | I19, AC37           |
| An interrupted `launch`                                 | AC35, a `launch` stopped in process                                                                          | An interrupted `drive`, and one whose index is then removed                                                                                                                | I16, AC35           |
| Words and names                                         | Run root, `work/`, receipt, evidence index, owed station, host command; its own cause codes and schema names | The kernel glossary's words; the build's cause codes; `verify-index/1` and `verify-step/1`; `scratch/` and `{scratch}`; evidence files at `evidence/<feature>/<step>.json` | Every part; I8, I12 |
| A target that answers differently on each run (round 2) | Blamed on the kernel, exit 70                                                                                | Exit 3, `TARGET FAIL target-not-repeatable` (`0aeb3de`)                                                                                                                    | I18, AC54           |
| What a probe comparison reads (round 2)                 | Exit code, `stdout` byte count, `stderr` hash                                                                | A hash of `stdout` too (`b2dcc8f`)                                                                                                                                         | I18                 |
| A swept station (round 2)                               | The sweep observed its cause                                                                                 | Only when every check on that run passed (`044431e`)                                                                                                                       | I10, I11, AC56      |
| Evidence files (round 2)                                | No record of what stood at a file's path, or of the repository when the step ran                             | `fileKinds` and `repository` (`90162b3`, `c5a9d71`)                                                                                                                        | I12, AC57           |
| The run folder (round 2)                                | Judged by its path; git facts null when `git` says no work tree                                              | Judged through symbolic links; refused inside another run; null only with no `.git` entry (`480dec5`)                                                                      | I14, AC58           |
| The last readiness check's id (round 2)                 | `discovery-has-host-command`                                                                                 | `discovery-lists-a-command` (`06a566b`)                                                                                                                                    | I9                  |
| The example's sweep (round 3)                           | 31 checks                                                                                                    | 36: three more check ids (`3306233`)                                                                                                                                       | I10, AC1, AC9       |
| What counts as an envelope (round 3)                    | A line with a contract version and a result                                                                  | Only one whose result has a numeric exit code, a command identity and a cause code (`3ad9232`)                                                                             | I13, AC50           |
| `report` (round 3)                                      | Succeeds whenever it can read the run                                                                        | Refuses when the sweep reaches no station, and when an evidence file is not a step file that agrees with its index row (`aa593d7`, `dc128f9`)                              | I8, I11, AC61, AC62 |
| `pending` with its state folder gone (round 3)          | No unfinished changes                                                                                        | Refused, `DOMAIN_VERIFY_STATE_UNAVAILABLE` (`a3fe92f`)                                                                                                                     | I8, AC60            |

Where it follows the code or a kernel standard over an input:

| Input                                                        | What it says                                                                          | What was found                                                                                                   | What this specification does                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `D:27`                                                       | "the helper works today with `bun --cwd <folder> run`"                                | That two-word form prints Bun's usage text and exits 0, running nothing                                          | Needs no such flag. The kernel-free check starts the helper in the repository root (I7, I20)                      |
| `B:19`                                                       | "Transcripts are the diagnostics add-on"                                              | That add-on redacts each record, caps it at 64,000 bytes and prunes after seven days                             | Evidence files are plain files (I17)                                                                              |
| `D:32`                                                       | Use the repository's recorded-exception mechanism for the kernel-free check           | The glossary limits a recorded hit to a violation that existed when its gate landed                              | A scoped exception in the lint configuration, and no recorded hit (I19). `D:32` leaves this choice to the builder |
| `D:51`, and `to-spec`                                        | One test surface for behaviour                                                        | The kernel's standard requires each script function tested in-process too. `D:53` records that the standard wins | Both (TD1, TD2)                                                                                                   |
| `B:13`, and pstack, the set of agent skills this one follows | The helper has a `doctor`                                                             | The kernel repository's glossary gives Doctor one meaning: the command that checks a checkout                    | The command is `ready` (I21)                                                                                      |
| `B:29`                                                       | A generated repository made by Bootstrap, the tool that creates one, at template main | Bootstrap's command line has no kernel row                                                                       | Acceptance runs call the template's function from a script (AC46)                                                 |
| `C:15`                                                       | The programs add-on closes standard input                                             | It accepts a bounded input, writes it, then closes                                                               | Follows the code                                                                                                  |
| First version                                                | An unknown command exits 2 on every CLI                                               | A CLI whose command has an empty route takes any word as its argument and exits 0                                | The probe is an undeclared option. Commands are told apart by identity (I9, I10)                                  |
| First version, criterion 11                                  | `doctor` exits 3 on approval without state                                            | That design's check exited 70 before it could answer                                                             | Exit 3 with the kernel's sentence, never 70 (I18, AC5)                                                            |
| `CR:8`                                                       | Adopt the effect names `step.run` and `step.write`                                    | The build at its head has neither. `CB:5` replaces the item                                                      | One effect for each changing command (I4)                                                                         |

## What Nathan decided

Every choice is closed. None is reopened here.

| Decision                                                                 | His words, and the row                                                                                                    | Where it is applied | What it costs                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The skill is named `verify-cli`                                          | "verify CLI should be the school name" (`D:47`; "school" is "skill")                                                      | I1                  | It cannot carry a CLI's own name, as pstack's `verify-<app>` would                                                          |
| No `bin` entry                                                           | "not having a bin for now if we're not using it. It's only for humans, really" (`D:51`)                                   | I3                  | A long command line, shown in full in the skill document                                                                    |
| The programs add-on's folder and environment (K7) stays parked           | "Part K7" (`D:48`; "Part" is "Park")                                                                                      | I20                 | One working folder and one environment for a whole run                                                                      |
| The specification lives in the kernel repository's documentation         | "the spec lives in the docs project for now, in the kernel project for now" (`D:49`)                                      | This folder         | It is installed with every Pin, since the package ships every file of the repository                                        |
| No code comment cites a specification identifier                         | "don't make references in the comments to spec numbers" (`D:49`)                                                          | I19, AC41           | A reader of the code finds the requirement by its words, not its number                                                     |
| The helper's source lives in the skill folder                            | "the source code is going to be in the skills so it can be portable, moved around, and cached in other products" (`D:50`) | I2                  | A carried copy needs Bun, the `agent-cli-kernel` package and its add-on requirements beside it, and loses the Pin's promise |
| The kernel checks itself with `verify-cli` (K8) as its own later unit    | "I accept all your decisions" (`D:51`)                                                                                    | Part 8              | Until then no gate sweeps the helper's own CLI                                                                              |
| `verify-template` stays shell                                            | The same row (`D:51`)                                                                                                     | Part 8              | Two verification helpers until the parked unit returns                                                                      |
| Both layers                                                              | "both it is" (`D:10`)                                                                                                     | I10, I11            | Two things to maintain: the sweep's checks and each repository's scenarios                                                  |
| The kernel's glossary owns the kernel's words, `verify-cli`'s among them | "Yes, split them" (`D:57`)                                                                                                | Part 11             | The kernel's and the template's glossaries differ until the split lands                                                     |
| `verify-cli` uses the builder's words                                    | "Yes, all three" (`D:61`, call 1 at `D:63`)                                                                               | Every part          | Three test titles and two fault record names in the build still carry the dropped words (part 9)                            |

## Parts

The parts keep `to-spec`'s section order.

1. [Problem Statement and Solution](01-problem-and-solution.md)
2. [User Stories](02-user-stories.md)
3. [Implementation Decisions: the commands](03-implementation-commands.md) (I1
   to I10)
4. [Implementation Decisions: scenarios and
evidence](04-implementation-scenarios.md) (I11 to I17)
5. [Implementation Decisions: trust and fit](05-implementation-trust.md) (I18
   to I21)
6. [Testing Decisions](06-testing-decisions.md) (TD1 to TD6, and AC54 to AC62)
7. [Testing Decisions: acceptance criteria](07-acceptance-criteria.md) (AC1 to
   AC53)
8. [Out of Scope](08-out-of-scope.md)
9. [Further Notes](09-further-notes.md): slices, gaps for the builder, the
   exploration, parked ideas, what could not be checked
10. [Further Notes: traceability](10-traceability.md): the source of each
    decision, criterion, slice and story
11. [Further Notes: proposals, words, and this
folder](11-proposals-and-words.md)

[findings.tsv](findings.tsv) answers every finding of the two reviews and of
correction rounds 1, 2 and 3, one row each.

## Sources

These are planning records. Like the records the CLI kernel authority lists,
they live outside the kernel repository. Their owner is MAG-114, an issue in
Linear, the issue tracker. A citation gives a letter, then a file and line.

| Letter     | Source                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D`        | The decisions record, `inputs/DECISIONS.md`. The authority                                                                                                                         |
| `B`        | The brief, `inputs/BRIEF.md`                                                                                                                                                       |
| `C`        | The comparison of the two ideas reports, `inputs/COMPARISON.md`                                                                                                                    |
| `IF`, `IS` | The two blind ideas reports: `IF` by a Fable 5.2 worker, `IS` by a Sol 6.1 worker. Both are model names                                                                            |
| `RF`, `RS` | The two blind reviews of the first version, by the same two models                                                                                                                 |
| `CR`, `CB` | Correction round 1, `inputs/corrections/round-1.md`, and its addendum on the build's differences                                                                                   |
| `CN`       | Correction round 2, the builder's note, `inputs/corrections/round-2-build.md`                                                                                                      |
| `CT`       | Correction round 3, `inputs/corrections/round-3-build.md`                                                                                                                          |
| `BW`       | The build: kernel pull request 56, branch `skills/verify-agent-cli`, at commit `4169ded` for round 1, `67b734d` for round 2 and `f7f4d69`, the merge into kernel main, for round 3 |
| `PB`       | That pull request's body                                                                                                                                                           |
| `BE`       | The build's evidence folder, `redesign/` in the builder's notes                                                                                                                    |
| `E`        | The evidence folder of the planning record. Files 16 to 25 are the second version's runs, 26 and 27 round 1's, 28 to 30 round 2's, 31 to 33 round 3's                              |
| `FW`       | The earlier trial's scratch work, the first prototype                                                                                                                              |
| `KR`       | The kernel repository at commit `5b89b1f`                                                                                                                                          |
| `TP`       | The template repository at commit `5292c0d`                                                                                                                                        |
| `CD`       | A copy of Nathan's user-level `cli-design` skill, taken for the instruction review                                                                                                 |
| `P`        | pstack's `create-verification-skill`, version 0.15.32. pstack is a set of agent skills; this one says what a verification skill must hold                                          |
| `R`        | The cold-start trial: a fresh agent built two commands, one changing, in a generated repository                                                                                    |
| `TS`       | The `to-spec` skill, whose section order this follows                                                                                                                              |

Queued work is named by what it does, with its tag in brackets: the consumer
lint rules (K5); building `verify-cli` (K6); the programs add-on's folder and
environment (K7); the kernel checking itself with `verify-cli` (K8); the
template's pointer skill and Bootstrap's kernel row (T4). A capability
qualification record is the record of the Linux runs that qualified the state
add-on on one platform. Nathan countersigned it, and any change to the
programs add-on voids it.

## Claim tags

Each claim carries one of the glossary's claim tags: passed on Linux; passed
on macOS only; designed and not run; decided by Nathan; open. None is open.
"Passed on Linux" here means the build's end-to-end run in a container on the
Mac mini, with the same run on macOS. "Passed on macOS only" means the build's
tests and transcripts on macOS; correction round 3 ran its 218 tests again, at
the merged commit. "Read in the kernel's source" marks a fact taken from a
file and not from a run.
