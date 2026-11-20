# `verify-cli` specification, part 9 of 11: further notes

## Further Notes

### Slices, in dependency order

Each slice can merge on its own and is verified by its criteria. Each also
meets AC36, AC39, AC40, AC41, AC43 and AC44 at its own head. The build landed
S1 to S5 as one pull request, each commit green at its own head.

| Slice | What it adds                                                                                                                                             | Criteria                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1    | The skill folder; the compiler, lint and dead-code scope with the scoped exception; the kernel-free check without the evidence step; `ready` and `probe` | AC4 to AC8, AC11 for KF1 to KF4, AC12, AC14, AC16, AC17, AC18, AC37, AC38, AC49, AC54, AC55 |
| S2    | `sweep` and `findings`; the comparison of the helper's probes with raw runs                                                                              | AC1, AC2, AC3, AC9, AC10, AC11 for KF5 and KF6, AC13, AC56                                  |
| S3    | `launch`, `cleanup`, `pending`                                                                                                                           | AC19 to AC22, AC35, AC52, AC53, AC58, AC60, and AC33 without `drive`                        |
| S4    | `drive`, evidence files, the run's index, the evidence step of the check, `report`                                                                       | AC15, AC23 to AC34, AC50, AC51, AC57, AC59, AC61, AC62                                      |
| S5    | `SKILL.md`, the seed feature map, the install case, both end-to-end runs, the cold worker                                                                | AC42, AC45, AC46, AC47                                                                      |
| S6    | The exploration report                                                                                                                                   | AC48                                                                                        |

### Gaps for the builder

Where this specification asks for something the build does not do, and a
decision of Nathan's or a kernel standard requires it. Everything else follows
the build.

| Gap                                | Required by                                                                                    | Where it shows                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The exploration report of slice S6 | Nathan, `D:9`: "explore how the author skill, design skill, could leverage the helpers itself" | Not in pull request 56. The coordinator moved it to a separate worker, so it is owed by that unit, not by the builder |

Closed since correction round 1, each checked against the build at `67b734d`:

- The dropped words are gone from the three test titles, the two fault record
  names and the three files that said "owed station" (`be55216`).
- The pull request body now gives each command's add-ons, says approval is
  left out, and records the vocabulary as decided.
- The hosted check: the pull request body records all 19 hosted checks green
  at the final head, `621d96f`, in runs 44756069579 and 44756069643. Nothing
  under the skills folder changed between that head and the merge.

Parked under the review rule that only P0 and P1 findings are fixed before
merge. None is a gap for the builder:

- `cleanup`'s read-back also asks that the index still exists (P3).
- `SKILL.md` lists no field of the envelope's result, so a second cold worker
  asserted one that does not exist; the step was unmet, so nothing false
  passed (P2).
- The reviewer's altered scratch repository, which no run of this round uses
  (P3).

### Slice S6: how the other skills could use the helper

Explore, do not build. The slice delivers a report outside the skill folder
and changes neither skill. For each idea the report gives four fields:

1. What the skill does today, as a path and line.
2. What it would call instead.
3. What that removes, or makes checkable.
4. What it costs: a dependency on a command name or a format, and anything the
   helper would have to add.

It tries one idea or more for real in a scratch generated repository and shows
the command, the output and the exit code. It keeps a decision log. AC48
judges it.

Seed ideas. Each "today" line was opened in the second version. `KR/` is the
kernel repository. `CD/` is the copy of `cli-design` named in the
[map](00-map.md#sources). Two were tried for real with a prototype.

| Idea | Today                                                                                                                                                                    | Would call                                                          | Removes or makes checkable                              | Costs                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `KR/skills/agent-cli-kernel/references/testing.md:86` asks for one test for each station, in words                                                                       | `sweep`, then `report` after driving                                | The stations nobody drove become a printed list         | Depends on both command names and the shape of the owed results. "Owed" means not driven by the helper, not untested, and must be worded so |
| A2   | `KR/skills/agent-cli-kernel/SKILL.md:26` has five routes and none for showing a command works                                                                            | One more route line naming `verify-cli`                             | The reader no longer guesses where proof lives          | One line. Depends on the skill's name                                                                                                       |
| A3   | `KR/skills/agent-cli-kernel/references/example.md:294` shows commands to try by hand                                                                                     | The read-only example scenario, driven in the kernel's own gate     | The example's printed output is checked on every change | The kernel checking itself with `verify-cli` (K8), which is a later unit                                                                    |
| A4   | `KR/skills/agent-cli-kernel/references/stations.md:138` lists start-up throws for a reader to match by eye                                                               | `ready`, which quotes the line                                      | Matching by eye                                         | Nothing beyond `ready`. The table still explains each repair                                                                                |
| C1   | `CD/references/qualification.md:81` runs a strict checker with required 2.0 rows; `CD/references/contract-core.md:25` expects `envelopeVersion: 2` and `"2.0.0"`         | `ready --json` first, then route by the contract version it returns | A checker for the wrong contract is never run           | Depends on the name of one data field. `cli-design` needs a routing rule and keeps its 2.0 route                                            |
| C2   | `CD/SKILL.md:147` asks, in words, to exercise command discovery and reject undeclared stations; `CD/references/qualification.md:93` says its checker has no row for that | `sweep` for declared causes, `report` for owed results              | The discovery gap gets a check and a list               | Depends on both commands. Whether a required station can be reached stays a design judgement                                                |
| C3   | `CD/SKILL.md:163` asks for independent literal expectations, and `:167` asks the agent to report the evidence kept                                                       | Scenario files and the run's index                                  | Hand-written evidence tables                            | The scenario and index formats become a contract `cli-design` depends on. Its design judgement stays its own                                |

The two trials:

- A1. On the author skill's example, the prototype's sweep returned 31 checks
  and two owed results, both of `moons.show`. The merged build counts 36
  checks there, and the same two owed results.
- C1. `ready` returned contract version `3.0.0`. The example's envelope has
  four top-level keys and none is `envelopeVersion`. `cli-design`'s checker
  expects 2.0, so it checks the wrong contract for any CLI on this kernel.

### If the programs add-on's folder and environment (K7) lands

- A step gains two optional fields, a working folder and an environment. The
  scenario schema stays at version 1, because both are additions.
- The limits of I20 go: a step may then run elsewhere, a compiled target can
  be started, and a target with a fixed state folder can be isolated.
- An evidence file can then record the environment names a step was given.
- No command, exit code or cause code changes.
- That unit itself needs two fresh pilot runs of the `linux-7-btrfs`
  capability qualification and Nathan's countersignature. That cost is why it
  is parked.

### Kernel rules the build met, parked

The build changed no kernel code. It worked within these, and each may be
worth a kernel decision later.

- A changing command cannot return a success that changed nothing. With
  transaction state `unchanged` and outcome `success`, the kernel's proof
  allows no remaining effect, and the command's declared effects are
  remaining. So "already done" has to be a refusal, as the second `cleanup`
  is. A kernel rule that admitted an already-done success would let it
  succeed.
- The state add-on reports a transaction's effects in the order they ran, and
  its proof requires them sorted by name. A producer and a checker that
  disagree on order make every multi-effect command name its effects to sort.
- The build reports that the lint rule against writing the process streams
  misses a stream reached by a computed key. That was not checked here.

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

- The test suite on Linux. The build's evidence shows the skill's instructions
  end to end in a Linux container, and the tests on macOS. This revision ran
  the tests again on macOS only.
- The hosted runs themselves, and fault replay. The hosted result was read
  from the pull request body. Fault replay was read there too, 198 of 198
  killed at `621d96f`, and not run again here.
- The build's cold worker run was read from its command ledger, not repeated.
- A cause code for which no test title names it was taken from the build's
  source: `DOMAIN_VERIFY_CHANGE_UNCHANGED` is reached in process only.
- What the consumer lint rules (K5) change. They are not in the kernel at the
  commit read.
- The Linear record behind the decisions file. The file was taken as given.
- Whether pull request 55, which carries this specification, merges before or
  after pull request 56. Part 11 says what each order needs.
