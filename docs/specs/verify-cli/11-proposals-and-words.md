# `verify-cli` specification, part 11 of 11: proposals without a source, and words

This part belongs to Further Notes.

## Proposals without a source

No input asks for these. Each is this specification's own choice, so Nathan
can strike any one alone.

1. Every cause code name except `DOMAIN_VERIFY_FINDINGS`, which the first
   prototype used. So also the outcome given to `DOMAIN_VERIFY_UNMET`,
   `DOMAIN_VERIFY_UNCONFIRMED` and `DOMAIN_VERIFY_UNCHANGED`.
2. The command names `ready` and `probe`, and `pending` taking a run root.
3. The three schema names; JSON Lines for the index; the nine fields of the
   run row; one receipt folder for each feature.
4. The scenario fields `runner`, `timeoutMilliseconds`, `outputLimitBytes`,
   `stdoutIncludes`, `stderrIncludes`, `files` and `timedOut`; a dotted path
   as a `result` key; a path ending in `length`; the placeholders `{work}` and
   `{repository}`.
5. Every limit but three. The default time limit, the default output limit and
   the shutdown budget come from the first prototype. The others have no
   source: 300 characters for a quoted line; 64 characters for a name; 200
   steps; 1,048,576 bytes for a scenario file; 600,000 milliseconds and
   8,388,608 bytes as the most a step may ask for; 3,600,000 milliseconds for
   a scenario; and the check's 60,000, 600,000 and 7,200,000.
6. Every check id and every scenario rule id. Refusing a field the format does
   not name.
7. The report states `swept` and `driven`; the report's line; `drive` running
   every step after an unmet one; refusing a second drive of a feature.
8. In the trust model: probing the helper itself; comparing the helper's
   `probe` with a raw run, and the three things compared; the ids
   `helper-usage-exit`, `observation-mismatch`, `evidence-mismatch`,
   `check-internal` and `child-timeout`; the form of an exit 70 line; exit 70
   not being an envelope; `--help` passing through as a message.
9. KF4, KF5 and KF6 as fault classes the skill must detect, and EF1. The brief
   asks for planted kernel faults and names none.
10. The kernel-free check starting the helper in the repository root, and the
    rule that the repository root is the nearest folder with a `package.json`.
11. The helper's state root inside the run root; the `DOMAIN_VERIFY_NO_PIN`
    refusal; refusing a `git` failure that is not "no work tree".
12. A scoped lint exception in place of a recorded hit, and the rule that the
    kernel-free check may not import the kernel. This departs from the wording
    of `D:32`.
13. The `verify/` folder in a generated repository.
14. Verifying uncommitted work in place, with two git facts in the run row,
    and not by a snapshot as one ideas report proposed.
15. The fixture CLI that tells one lie, in place of a `selftest` command.
16. Extending the author guide gate's install case to run `ready`.
17. How four criteria are judged: the comment search of AC41, the ordered
    transcript of AC46, the "no read outside" rule of AC47, and the three
    ideas for each skill of AC48.
18. The folder `docs/specs/verify-cli/` and its split into eleven parts.

## Words

### Glossary words, used with their glossary meaning

Generated repository; Kernel repository; Template; Pin; Pinned commit;
Toolchain pin; Installed kernel; Add-on; Add-on selection; Add-on requirement;
Check command; Hosted check; Gate; Test surface; Test area; Process runner;
Negative control; Planted fault; Fault record; Fault replay; Recorded hit;
Refusal; Repair; Verdict; Doctor; Lint rule; Names check; Claim tag.

- Verdict keeps its meaning, the result of judging one thing once. Here a
  step's verdict is `met` or `unmet`.
- Doctor is used only for the checkout command, and once for pstack's section
  heading (I21).
- Recorded hit is used only to say that none is added (I19).
- A negative control is a break, not a test. A report test of TD4 makes a
  break and then asserts.
- "The package" means `agent-cli-kernel` as Bun installs it. The repository is
  the kernel repository, as the glossary asks.

### Words owned elsewhere

- Station, command identity, cause code, effect class, envelope and discovery
  are Command Contract 3 words. The author skill uses them the same way.
- Bootstrap is an Agent ecosystem glossary word.
- Journey and feature map are pstack's. A scenario is what pstack calls a
  journey.

### New words, proposed

Each would need an owner before it is used in a file name.

| Word                                     | Meaning                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helper                                   | The kernel-built CLI inside the skill folder                                                                                                                                      |
| Target                                   | The CLI being judged, named by its entry file                                                                                                                                     |
| Kernel-free check                        | The entry file every command starts through. No kernel code runs in its process                                                                                                   |
| Probe                                    | One fixed run of the target, or of the helper, whose result is compared and not judged                                                                                            |
| Sweep                                    | Layer 1: the checks derived from the target's discovery                                                                                                                           |
| Sweep check, readiness check             | One thing the helper tests about a target. Always qualified, since the glossary keeps the bare word for the check command and for a gate                                          |
| Finding                                  | A failed sweep check or readiness check                                                                                                                                           |
| Host command                             | A command a repository declares, as against the four the kernel adds. The kernel's source uses the word this way. The glossary asks that host be qualified, and here it always is |
| Scenario                                 | Layer 2: one feature as an ordered list of steps with exact expectations                                                                                                          |
| Step                                     | One run of the target, or of Bun, inside a scenario                                                                                                                               |
| Receipt                                  | The file that records one step: what was expected, what was observed, the verdict                                                                                                 |
| Evidence index                           | The file that lists a run's receipts with their hashes                                                                                                                            |
| Run root                                 | The folder one run owns. The template's verification skill already uses the word                                                                                                  |
| Swept, driven, owed                      | The three states the report gives a station                                                                                                                                       |
| Kernel fault class, evidence fault class | A kind of fault the skill must detect, planted in the installed kernel or in the evidence                                                                                         |
| Seed feature map                         | The feature map the skill ships, which a generated repository copies from                                                                                                         |
| Scoped exception                         | A lint rule turned off for one named owner in the lint configuration                                                                                                              |
