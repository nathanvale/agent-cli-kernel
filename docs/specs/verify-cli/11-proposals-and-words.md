# `verify-cli` specification, part 11 of 11: proposals without a source, words, and this folder

This part belongs to Further Notes.

## Proposals without a source

No input asks for these. Each is this specification's own choice, or the
build's, so Nathan can strike any one alone. All are now built.

1. Every cause code name. So also the outcomes given to
   `DOMAIN_VERIFY_EXPECTATION_UNMET`, `DOMAIN_VERIFY_CHANGE_UNKNOWN` and
   `DOMAIN_VERIFY_CHANGE_UNCHANGED`.
2. The command names `ready` and `probe`, and `pending` taking a run folder.
3. The three schema names; JSON Lines for the run's index; the nine fields of
   the run row; one folder of evidence files for each feature.
4. The scenario fields `runner`, `timeoutMilliseconds`, `outputLimitBytes`,
   `stdoutIncludes`, `stderrIncludes`, `files` and `timedOut`; a dotted path
   as a `result` key; a path ending in `length`; the placeholders `{scratch}`
   and `{repository}`.
5. Every limit: 20,000 milliseconds, 1,048,576 bytes and 500 milliseconds as a
   step's defaults; 300 characters for a quoted line; 64 characters for a
   name; 200 steps; 1,048,576 bytes for a scenario file; 600,000 milliseconds
   and 8,388,608 bytes as the most a step may ask for; 3,600,000 milliseconds
   for a scenario; 16,777,216 bytes for an index; and the check's 60,000,
   600,000 and 7,200,000 milliseconds, with a grace of 10,000.
6. Every check id and every scenario rule id. Refusing a field the format does
   not name.
7. The four contract checks, and making them unasked.
8. The report states `swept` and `driven`; the report's line; `drive` running
   every step after an unmet one; refusing a second drive of a feature, and a
   drive after cleanup.
9. In the trust model: probing the helper itself; comparing the helper's
   `probe` with a raw run, and the three things compared; the ids
   `helper-usage-exit`, `observation-mismatch`, `evidence-mismatch`,
   `check-internal` and `child-timeout`; the form of an exit 70 line; exit 70
   not being an envelope; exits 130 and 143 for a stopped check.
10. KF4, KF5 and KF6 as fault classes the skill must detect, and EF1. The
    brief asks for planted kernel faults and names none.
11. The kernel-free check starting the helper in the repository root, and the
    rule that the repository root is the nearest folder with a `package.json`.
12. The helper's state inside the verification run; the refusals for a missing
    target, a missing Pin and a `git` failure.
13. A scoped lint exception in place of a recorded hit, and the rule that the
    kernel-free check may not import the kernel. This departs from the wording
    of `D:32`.
14. The `verify/` folder in a generated repository.
15. Verifying uncommitted work in place, with two git facts in the run row,
    and not by a snapshot as one ideas report proposed.
16. The fixture CLI that tells one lie, in place of a `selftest` command.
17. One test that installs the package by git ref and runs a whole
    verification run from it.
18. How four criteria are judged: the comment search of AC41, the ordered
    transcript of AC46, the "no read outside" rule of AC47, and the three
    ideas for each skill of AC48.
19. The folder `docs/specs/verify-cli/`, its map, and its split into eleven
    parts.

## Words

### `verify-cli`'s own words

The kernel's glossary owns them: Nathan split the glossaries so that the
kernel's holds the kernel's words (`D:57`), and chose the builder's words over
this specification's (`D:63`). Kernel pull request 56, which adds the skill,
adds all fourteen entries to the kernel's `GLOSSARY.md`, under "Verifying a
CLI": verify-cli, Kernel-free check, Helper, Target, Probe, Verification run,
Scratch folder, Evidence folder, Step, Scenario, Sweep, Finding, Owed result
and Contract check.

- This specification uses those words with those meanings, and keeps their
  Avoid lines: no wrapper for the kernel-free check, no app for a target, no
  session for a verification run.
- It adds no glossary entry and proposes no new word. The words of the second
  version that the glossary lacks are gone: run root, evidence index, owed
  station, host command, and the word the glossary's Evidence folder entry
  avoids. They appear only where a table says what was dropped, or inside a
  name the build still has.
- Its pull request, kernel pull request 55, therefore depends on pull request 56.
  Merge 56 first, or rebase 55 onto it. Merged alone, 55 would use fourteen
  words the glossary does not yet define.
- Plain phrases, not terms: the run's index, the run row, an evidence file,
  the target's own commands, a readiness check, a kernel fault class, a scoped
  exception, the seed feature map. Each is built from glossary words or from
  the entries' own wording.

### The kernel's recorded unused terms

The kernel records each glossary term that no tracked file uses yet. Its
glossary files test fails when a tracked file starts to use a recorded term.
The second version tripped it on four. Each is now settled, and checked by
running that test in a scratch copy of the kernel with these files in place.
The ledger's rows from the second version are not edited, and one of them
quotes a review that named the third term.

| Term                                                      | Settled as                                                                                                                 | What pull request 55 does                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Test surface                                              | Used. `D:51` decides the test surface, and the term's record calls it "a word for the plan"                                | Removes its entry from the recorded unused terms, as the repo gardener's rule for a term now in use asks |
| Claim tag                                                 | Used. Every claim here carries one, and the record calls it "a word for the plan"                                          | Removes its entry, the same way                                                                          |
| The term for the add-ons one generated repository selects | Not used. The helper is not a generated repository; part 3 says which add-ons it selects                                   | Nothing                                                                                                  |
| The term for a break made on purpose                      | Used, in one place only: the ledger's row for the review finding that named it. The parts themselves say it in plain words | Removes its entry, the same way                                                                          |

- With the list unchanged, the test fails with exactly three problems: those
  three terms.
- With those three entries removed, it passes: 20 of 20.
- The second version, put through the same test first, gave the four problems
  the review reported. So the test was able to fail.

### Other glossary words, used with their glossary meaning

Generated repository; Kernel repository; Template; Pin; Pinned commit;
Toolchain pin; Installed kernel; Add-on; Add-on requirement; Check command;
Hosted check; Gate; Test surface; Test area; Planted fault; Fault record;
Fault replay; Recorded hit; Refusal; Repair; Verdict; Doctor; Lint rule; Names
check; Claim tag.

- Verdict keeps its meaning, the result of judging one thing once. Here a
  step's verdict is `met` or `unmet`.
- Doctor is used only for the checkout command, and once for pstack's section
  heading (I21).
- Recorded hit is used only to say that none is added (I19).
- "The package" means `agent-cli-kernel` as Bun installs it. The repository is
  the kernel repository, as the glossary asks.

### Words owned elsewhere

- Station, command identity, cause code, effect class, envelope and discovery
  are Command Contract 3 words. The author skill uses them the same way.
- Bootstrap is an Agent ecosystem glossary word.
- Journey and feature map are pstack's. A scenario is what pstack calls a
  journey.

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
- The map is `00-map.md`, not a README. Nathan's conditions for merging rule
  out a README change, and a new README is read as one.
- The second version asked for a route line in `docs/agents/README.md`. That
  is a README change too, so it is dropped. The map is found by its folder.

Each file is formatted by the kernel repository's formatter, which lays out
tables and JSON snippets, and passes the kernel's file size gate, which allows
5,000 tokens. The counts are the gate's own, from running it over this folder,
formatted, in a scratch copy of the kernel repository at the merged commit
(`E/33`). The kernel's names check passes every path here too.

| File                             | Tokens | Limit |
| -------------------------------- | ------ | ----- |
| `00-map.md`                      | 4,053  | 5,000 |
| `01-problem-and-solution.md`     | 720    | 5,000 |
| `02-user-stories.md`             | 2,408  | 5,000 |
| `03-implementation-commands.md`  | 4,283  | 5,000 |
| `04-implementation-scenarios.md` | 4,455  | 5,000 |
| `05-implementation-trust.md`     | 3,555  | 5,000 |
| `06-testing-decisions.md`        | 3,239  | 5,000 |
| `07-acceptance-criteria.md`      | 4,831  | 5,000 |
| `08-out-of-scope.md`             | 561    | 5,000 |
| `09-further-notes.md`            | 2,405  | 5,000 |
| `10-traceability.md`             | 4,596  | 5,000 |
| `11-proposals-and-words.md`      | 2,521  | 5,000 |
| `findings.tsv`                   | 4,455  | 5,000 |
