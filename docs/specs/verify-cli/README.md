# `verify-cli`: a verification skill that ships with the kernel

Status: proposed, not accepted (20 November 2026, Australia/Melbourne). This
is the second version. It replaces the first, `SPEC.md` at commit `d8cae10` of
the planning record, and answers two independent reviews of it. Once accepted,
code follows this specification, never the reverse.

All runs: macOS arm64, Bun 1.4.4, the kernel at commit `5b89b1f`. Nothing here
has run on Linux.

## In one screen

1. An agent in a generated repository gets a skill, `verify-cli`. It arrives
   with the repository's Pin and shows that the repository's command-line
   interface (CLI) works as a user meets it.
2. The skill's helper is a CLI built on the kernel. Its source lives in the
   skill's own folder, so the folder can be carried elsewhere. A small
   kernel-free check starts first, every time.
3. It judges in two layers: a sweep derived from the target's own discovery,
   and scenarios an author writes with exact expectations.
4. Evidence is plain files that outlive cleanup, each receipt with a recorded
   hash.
5. Exit 70 means "do not trust this run". A target that cannot start is a
   refusal, exit 3, that quotes the target's own error.
6. There are 21 implementation decisions, 6 testing decisions, 48 acceptance
   criteria and 59 user stories. Each criterion names its test and its
   expected result.

## Where the inputs and the code disagreed

Each row is a place this specification follows the code, or a kernel standard,
over an input. Nathan should read these first.

| Input                                                        | What it says                                                                                       | What was found                                                                                                                                                  | What this specification does                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D:27`                                                       | "the helper works today with `bun --cwd <folder> run`"                                             | That two-word form prints Bun's usage text and exits 0, running nothing. The form with an equals sign runs the script. Both reviewers reproduced it             | Needs neither. The kernel-free check starts the helper in the repository root, and each step inherits it (I7, I20). It still works without kernel unit K7 |
| `B:19`                                                       | "Transcripts are the diagnostics add-on"                                                           | That add-on redacts each record, caps it at 64,000 bytes and prunes after seven days                                                                            | Receipts are plain files. Diagnostics holds the helper's trace only (I17)                                                                                 |
| `D:32`                                                       | The consumer lint refuses the kernel-free check; use the repository's recorded-exception mechanism | In the kernel repository no lint covers the skills folder at all. The glossary limits a recorded hit to a violation that existed when its gate landed           | Brings the skill under the lint, with a scoped exception in the lint configuration and no recorded hit (I19). `D:32` leaves this choice to the builder    |
| `D:51`, and `to-spec`                                        | One test surface for behaviour                                                                     | The kernel's standard requires each script function tested in-process too. `D:53` records that the standard wins                                                | One process surface as the proof of behaviour, with in-process tests of each function beside it (TD1, TD2)                                                |
| `B:13`, and pstack, the set of agent skills this one follows | The helper has a `doctor`                                                                          | The kernel repository's glossary gives Doctor one meaning: the command that checks a checkout                                                                   | The command is `ready`. The skill document keeps pstack's Doctor heading (I21)                                                                            |
| `B:29`                                                       | A generated repository made by Bootstrap, the tool that creates one, at template main              | Bootstrap's command line has no kernel row                                                                                                                      | Acceptance runs call the template's function from a script, until template unit T4 (AC46)                                                                 |
| `C:15`                                                       | The programs add-on closes standard input                                                          | It accepts a bounded input, writes it, then closes                                                                                                              | Follows the code. Standard input held open is out of scope                                                                                                |
| First version, I6 and I13                                    | An unknown command exits 2 on every CLI; a host command has a route word                           | A host command may have an empty route. That CLI takes any word as its argument and exits 0. The first prototype then reported a kernel fault for a healthy CLI | Host commands are told apart by identity. The probe is an undeclared option. The check probes the helper, not the target (I9, I10, I18)                   |
| First version, criterion 11                                  | `doctor` exits 3 on approval without state                                                         | The first design's check exited 70 before `ready` could answer                                                                                                  | Redesigned and run: exit 3 with the kernel's sentence, never 70 (I18, AC5)                                                                                |

## What Nathan decided

All six open choices are closed. None is reopened here.

| Decision                                                         | His words, and the row                                                                                                    | Where it is applied  | What it costs                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The skill is named `verify-cli`                                  | "verify CLI should be the school name" (`D:47`; "school" is "skill")                                                      | I1                   | It cannot carry an app's name, as pstack's `verify-<app>` would                                                                       |
| No `bin` entry                                                   | "not having a bin for now if we're not using it. It's only for humans, really" (`D:51`)                                   | I3                   | A long command line, shown in full in the skill document                                                                              |
| Kernel unit K7 stays parked                                      | "Part K7" (`D:48`; "Part" is "Park")                                                                                      | I20                  | One working folder and one environment for a whole run                                                                                |
| The specification lives in the kernel repository's documentation | "the spec lives in the docs project for now, in the kernel project for now" (`D:49`)                                      | This folder          | It is installed with every Pin, since the package ships every file of the repository. Nothing reads it there                          |
| No code comment cites a specification identifier                 | "don't make references in the comments to spec numbers" (`D:49`)                                                          | I19, AC41            | A reader of the code finds the requirement by its words, not its number                                                               |
| The helper's source lives in the skill folder                    | "the source code is going to be in the skills so it can be portable, moved around, and cached in other products" (`D:50`) | I2                   | A carried copy needs Bun, the `agent-cli-kernel` package and its add-on requirements installed beside it, and loses the Pin's promise |
| The kernel uses `verify-cli` on itself as its own later unit     | "I accept all your decisions" (`D:51`)                                                                                    | Out of scope, part 8 | Until then no gate sweeps the helper's own CLI                                                                                        |
| `verify-template` stays shell                                    | The same row (`D:51`)                                                                                                     | Out of scope, part 8 | Two verification helpers, one shell and one on the kernel, until K7 returns                                                           |
| Both layers                                                      | "both it is" (`D:10`)                                                                                                     | I10, I11             | Two things to maintain: the sweep's checks and each repository's scenarios                                                            |

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
6. [Testing Decisions](06-testing-decisions.md) (TD1 to TD6)
7. [Testing Decisions: acceptance criteria](07-acceptance-criteria.md) (AC1 to
   AC48)
8. [Out of Scope](08-out-of-scope.md)
9. [Further Notes](09-further-notes.md): slices, the exploration, K7, what
   could not be checked
10. [Further Notes: traceability](10-traceability.md): the source of each
    decision, criterion, slice and story
11. [Further Notes: proposals without a source, and
words](11-proposals-and-words.md)

[findings.tsv](findings.tsv) answers every finding of both reviews, one row
each.

## Sources

These are planning records. Like the records the CLI kernel authority lists,
they live outside the kernel repository. Their owner is MAG-114, an issue in
Linear, the issue tracker. A citation gives a letter, then a file and line.

| Letter     | Source                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `D`        | The decisions record, `inputs/DECISIONS.md`. The authority                                                                                |
| `B`        | The brief, `inputs/BRIEF.md`                                                                                                              |
| `C`        | The comparison of the two ideas reports, `inputs/COMPARISON.md`                                                                           |
| `IF`, `IS` | The two blind ideas reports: `IF` by a Fable 5.2 worker, `IS` by a Sol 6.1 worker. Both are model names                                   |
| `RF`, `RS` | The two blind reviews of the first version, by the same two models                                                                        |
| `E`        | The evidence folder of the planning record. Files 16 to 25 and `format-examples/` are output of this revision's runs                      |
| `FW`       | The earlier trial's scratch work, the first prototype                                                                                     |
| `KR`       | The kernel repository at commit `5b89b1f`                                                                                                 |
| `TP`       | The template repository at commit `5292c0d`                                                                                               |
| `CD`       | A copy of Nathan's user-level `cli-design` skill, taken for the instruction review                                                        |
| `P`        | pstack's `create-verification-skill`, version 0.15.32. pstack is a set of agent skills; this one says what a verification skill must hold |
| `R`        | The cold-start trial: a fresh agent built two commands, one changing, in a generated repository                                           |
| `TS`       | The `to-spec` skill, whose section order this follows                                                                                     |

Unit labels name queued work, not sources: K5 (lint rules for code that
consumes the kernel), K6 (building this skill), K7 (a working folder and an
environment for the programs add-on) and T4 (the template's pointer skill and
Bootstrap's kernel row). A capability qualification record is the record of
the Linux runs that qualified the state add-on on one platform. Nathan
countersigned it, and any change to the programs add-on voids it.

## Claim tags

Each claim carries one of the glossary's claim tags: passed on Linux; passed
on macOS only; designed and not run; decided by Nathan; open. None is open,
and none passed on Linux. "With the prototype" means a scratch helper of four
commands, not the product. "Read in the kernel's source" marks a fact taken
from a file and not from a run.

## Where this folder sits, and why

`docs/specs/verify-cli/` in the kernel repository.

- `docs/` has one folder for each kind of document: `agents/` for workflow
  guides and `standards/` for review guides. A specification is neither, so it
  gets a folder of its own kind, with one folder for each subject.
- The kernel's design notes sit beside what they describe: the state add-on's
  beside its code, the diagnostics add-on's beside its tests. The state
  add-on's are split into parts "to keep each under 5,000 tokens", and open
  with a status line and a map of the parts. This folder follows those habits.
- It does not sit beside its code, for two reasons. Nathan placed it in the
  documentation. And the skill folder is carried into other products; a
  specification should not travel with it.
- `specs` is the word the kernel's documentation already uses for a
  specification folder, in the CLI kernel authority.
- When this folder is copied in, `docs/agents/README.md` gains one route line
  to it. That edit belongs to the builder's first slice.

Each file passes the kernel's file size gate, which allows 5,000 tokens. The
counts are the gate's own, from running it over this folder in a scratch copy
of the kernel repository (`E/25`). The kernel's names check passes every path
here too.

| File                             | Tokens | Limit |
| -------------------------------- | ------ | ----- |
| `README.md`                      | 2,964  | 5,000 |
| `01-problem-and-solution.md`     | 701    | 5,000 |
| `02-user-stories.md`             | 2,122  | 5,000 |
| `03-implementation-commands.md`  | 3,288  | 5,000 |
| `04-implementation-scenarios.md` | 3,356  | 5,000 |
| `05-implementation-trust.md`     | 2,624  | 5,000 |
| `06-testing-decisions.md`        | 1,985  | 5,000 |
| `07-acceptance-criteria.md`      | 3,675  | 5,000 |
| `08-out-of-scope.md`             | 508    | 5,000 |
| `09-further-notes.md`            | 1,748  | 5,000 |
| `10-traceability.md`             | 3,343  | 5,000 |
| `11-proposals-and-words.md`      | 1,483  | 5,000 |
| `findings.tsv`                   | 2,312  | 5,000 |
