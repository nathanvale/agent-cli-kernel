# `verify-cli` specification, part 9 of 11: further notes

## Further Notes

### Slices, in dependency order

Each slice merges on its own and is verified by its criteria. Each also meets
AC36, AC39, AC40, AC41, AC43 and AC44 at its own head.

| Slice | What it adds                                                                                                                                             | Criteria                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| S1    | The skill folder; the compiler, lint and dead-code scope with the scoped exception; the kernel-free check without the evidence step; `ready` and `probe` | AC4 to AC8, AC11 for KF1 to KF4, AC12, AC14, AC16, AC17, AC18, AC37, AC38 |
| S2    | `sweep` and `findings`; the comparison of the helper's probe with a raw run                                                                              | AC1, AC2, AC3, AC9, AC10, AC11 for KF5 and KF6, AC13                      |
| S3    | `launch`, `cleanup`, `pending`                                                                                                                           | AC19 to AC22, AC35, and AC33 without `drive`                              |
| S4    | `drive`, receipts, the index, the evidence step of the check, `report`                                                                                   | AC15, AC23 to AC34                                                        |
| S5    | `SKILL.md`, the seed feature map, the install case, both end-to-end runs, the cold worker                                                                | AC42, AC45, AC46, AC47                                                    |
| S6    | The exploration report                                                                                                                                   | AC48                                                                      |

### Slice S6: how the other skills could use the helper

Explore, do not build. The slice delivers a report with the pull request,
outside the skill folder, and changes neither skill. For each idea the report
gives four fields:

1. What the skill does today, as a path and line.
2. What it would call instead.
3. What that removes, or makes checkable.
4. What it costs: a dependency on a command name or a format, and anything the
   helper would have to add.

It tries one idea or more for real in a scratch generated repository and shows
the command, the output and the exit code. It keeps a decision log. AC48
judges it.

Seed ideas. Each "today" line was opened in this revision. `KR/` is the kernel
repository. `CD/` is the copy of `cli-design` named in the
[index](README.md#sources). Two were tried for real with the prototype.

| Idea | Today                                                                                                                                                                    | Would call                                                          | Removes or makes checkable                              | Costs                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `KR/skills/agent-cli-kernel/references/testing.md:86` asks for one test for each station, in words                                                                       | `sweep`, then `report` after driving                                | The stations nobody drove become a printed list         | Depends on both command names and the owed list's shape. "Owed" means not driven by the helper, not untested, and must be worded so |
| A2   | `KR/skills/agent-cli-kernel/SKILL.md:26` has five routes and none for showing a command works                                                                            | One more route line naming `verify-cli`                             | The reader no longer guesses where proof lives          | One line. Depends on the skill's name                                                                                               |
| A3   | `KR/skills/agent-cli-kernel/references/example.md:294` shows commands to try by hand                                                                                     | The read-only example scenario, driven in the kernel's own gate     | The example's printed output is checked on every change | The kernel using the helper on itself, which is a later unit                                                                        |
| A4   | `KR/skills/agent-cli-kernel/references/stations.md:138` lists start-up throws for a reader to match by eye                                                               | `ready`, which quotes the line                                      | Matching by eye                                         | Nothing beyond `ready`. The table still explains each repair                                                                        |
| C1   | `CD/references/qualification.md:81` runs a strict checker with required 2.0 rows; `CD/references/contract-core.md:25` expects `envelopeVersion: 2` and `"2.0.0"`         | `ready --json` first, then route by the contract version it returns | A checker for the wrong contract is never run           | Depends on the name of one data field. `cli-design` needs a routing rule and keeps its 2.0 route                                    |
| C2   | `CD/SKILL.md:147` asks, in words, to exercise command discovery and reject undeclared stations; `CD/references/qualification.md:93` says its checker has no row for that | `sweep` for declared causes, `report` for owed stations             | The discovery gap gets a check and a list               | Depends on both commands. Whether a required station can be reached stays a design judgement                                        |
| C3   | `CD/SKILL.md:163` asks for independent literal expectations, and `:167` asks the agent to report the evidence kept                                                       | Scenario files and the evidence index                               | Hand-written evidence tables                            | The scenario and index formats become a contract `cli-design` depends on. Its design judgement stays its own                        |

The two trials:

- A1. On the author skill's example, the sweep returned 31 checks and an owed
  list of two stations, both of `moons.show`.
- C1. `ready` returned contract version `3.0.0`. The example's envelope has
  four top-level keys and none is `envelopeVersion`. `cli-design`'s checker
  expects 2.0, so it checks the wrong contract for any CLI on this kernel.

### If kernel unit K7 lands

- A step gains two optional fields, a working folder and an environment. The
  scenario schema stays at version 1, because both are additions.
- The limits of I20 go: a step may then run elsewhere, a compiled target can
  be started, and a target with a fixed state root can be isolated.
- A receipt can then record the environment names a step was given.
- No command, exit code or cause code changes.
- K7 itself needs two fresh pilot runs of the `linux-7-btrfs` capability
  qualification and Nathan's countersignature. That cost is why it is parked.

### Ideas kept for later, with their source

- A `verify` script in the generated `package.json`, in place of the long
  command line. It is a template change and ties the template to the helper's
  path.
- A command that prints a test file with one test for each station.
- A snapshot of the working tree for development and of a commit for a release
  claim.
- A cold handover as a routine: one agent writes the scenario, another judges
  it.

### What could not be checked

- Linux. Every run was on macOS arm64 with Bun 1.4.4.
- Any helper command that uses the state or diagnostics add-on. No helper was
  built, by this task's limit. So `launch`, `drive`, `report`, `cleanup` and
  `pending` are designs. The formats were written by a scratch script, and the
  changing-command steps were run through the real programs add-on, but not by
  a helper.
- Whether `contractFor` admits every proposed cause row. One shape was
  confirmed by reading: the kernel's own table has a failed, completed domain
  row.
- The evidence step of the kernel-free check, `check-internal` and
  `child-timeout`.
- The scoped lint exception, the dead-code zone and the import coverage gate
  on the skill folder. They need the builder's files inside the kernel
  repository's check command.
- The check command driven as a step. Its three raw results were run in the
  first version, in the form with an equals sign.
- What kernel unit K5 changes in the consumer lint. It is not in the kernel at
  the commit read.
- The cold worker, and a real install by git ref.
- The Linear record behind the decisions file. The file was taken as given.
- The kernel builder's work in progress on unit K6. It is not an input and was
  not read.
