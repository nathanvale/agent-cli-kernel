# `verify-cli` specification, part 6 of 11: testing decisions

Testing decisions are numbered TD1 to TD6. The acceptance criteria are in
[part 7](07-acceptance-criteria.md). Sources are in [part
10](10-traceability.md#testing-decisions).

## Testing Decisions

**TD1. One process test surface is the proof of behaviour.** Test surface is
the glossary's word for what `to-spec` calls a seam. The surface is the real
helper, started through its kernel-free check, as a process, in a generated
repository that has the kernel installed by its Pin. Decided by Nathan.

- In the kernel repository's own tests, that repository is laid out the way
  the author guide's gate lays out its example: a scratch tree whose
  `node_modules/agent-cli-kernel` is this checkout.
- The gate already has one case that installs the package from the checkout's
  head by git ref. That case is extended to run `ready` once from the real
  install, so the Pin route itself is exercised.
- A test on this surface asserts the exit code, `stdout`, `stderr` and the
  files under the run root. It reads nothing else.
- It starts the production entry, the kernel-free check, from the folder a
  caller starts it in. It does not go through a package script, which would
  move the child to the package root.

**TD2. In-process tests of each function sit beside it.** The kernel's
standard requires both. It overrides `to-spec`'s advice to keep to one seam,
and the decisions record says so.

- Each function the helper or the kernel-free check runs, unexported ones too,
  is called and asserted from a test that imports its file.
- Each command is also run through the kernel's in-process runner against the
  helper's contract, as the author skill teaches.
- So each entry file only starts something, and every function lives in a
  module a test can import (I19).
- A function that starts a process, reads a folder or reads the clock takes
  that as a parameter, so a test passes its own. It does not resolve a path
  from the process's own folder.
- Why both. Coverage cannot see into a spawned process, so a function proved
  only on the process surface reads as untested and a fault planted in it is
  never run. An in-process test cannot see the exit code a real process gives:
  KF1 is invisible in process.

**TD3. What a good test is here.**

- It asserts the exact refusal: the cause code, and the rule id or check id in
  the message. An assertion that something was refused stays green when
  another guard refuses.
- Its input is shaped so that only the named guard can refuse it.
- It controls both sides of each bound: the last admitted value and the first
  refused one.
- It asserts all of what its title names.
- It proves that a fixture meant to lack something lacks it. A test folder may
  sit inside the checkout, where git finds a work tree for a case that expects
  none.
- It bounds each child below its own time limit, through the repository's
  process runner, and waits on events, not on wall time.
- It fakes a tool with a stub script. The `git` failure case of I14 uses a
  stub `git`.
- It pairs each green with a red.
- Its title says the behaviour in words, with no identifier from this
  specification.

**TD4. Planted faults.** Each new refusal or bound has a planted fault: a kept
patch that removes or weakens the guard, with a fault record naming the test
that must go red. Fault replay must print `KILLED` for each. A surviving fault
is a missing test. This covers every row below, not only the kernel fault
classes.

Kernel fault classes. Each has two things.

| Class      | Fault record: the patch, and the test it must turn red                                                                     | Report test                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| KF1 to KF7 | The patch makes that break in the kernel's source. The test is the healthy case: `ready` passes the author guide's example | A test makes the same break in a copy of the installed kernel and asserts the report I18 gives |

The helper's own refusals and bounds. One fault record for each row; where a
row names a list, one for each member.

| Guard                                                                                                                                                                                                        | Planted fault                                                | Test that must go red                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Each failure id of the kernel-free check: `kernel-import`, `helper-no-envelope`, `helper-exit-mismatch`, `helper-usage-exit`, `observation-mismatch`, `evidence-mismatch`, `check-internal`, `child-timeout` | The check skips that comparison                              | The report test of the fault class, or the in-process case, that only that id catches         |
| `observation-mismatch`, each compared field: exit code, `stdout` byte count, `stderr` hash                                                                                                                   | The check drops that field                                   | KF5 for the exit code, KF6 for the hash, an in-process case for the byte count                |
| `evidence-mismatch`, each case: receipt missing, receipt changed                                                                                                                                             | The check accepts that case                                  | The two EF1 cases                                                                             |
| `DOMAIN_VERIFY_TARGET_START`                                                                                                                                                                                 | `ready` treats a target that did not start as a failed check | The approval and own-error cases                                                              |
| The 300-character cut of the quoted line                                                                                                                                                                     | The cut is removed                                           | The case with a line of 301 characters                                                        |
| Each check id of `ready` and of `sweep`                                                                                                                                                                      | That check always passes                                     | The table case in which a fixture CLI breaks only that behaviour                              |
| The host command rule                                                                                                                                                                                        | A command with an empty route is skipped                     | The empty-route case                                                                          |
| The kernel-added station rule                                                                                                                                                                                | Every station is listed as owed                              | The case that counts the example's owed stations                                              |
| `DOMAIN_VERIFY_RUN_ROOT_TAKEN`, `DOMAIN_VERIFY_RUN_ROOT_IN_WORK_TREE`, `DOMAIN_VERIFY_NO_PIN`, the `git` failure refusal                                                                                     | `launch` skips that guard                                    | The `launch` refusal case of that name                                                        |
| `DOMAIN_VERIFY_NOT_LAUNCHED`, on each of four commands                                                                                                                                                       | That command skips the guard                                 | The table case over the four commands                                                         |
| Each scenario rule of I13                                                                                                                                                                                    | `drive` skips that rule                                      | The table case over the rule ids, with both sides of each numeric bound                       |
| `DOMAIN_VERIFY_ALREADY_DRIVEN`                                                                                                                                                                               | `drive` overwrites                                           | The second-drive case, which compares the first receipts' bytes                               |
| The default time limit and the `timedOut` verdict                                                                                                                                                            | A timed-out step is met                                      | The timed-out step case                                                                       |
| The output limit and the `outputTruncated` verdict                                                                                                                                                           | A cut output is met                                          | The cut-output case                                                                           |
| The credit rule: no envelope, or a `"runner": "bun"` step, credits nothing                                                                                                                                   | Such a step credits a station                                | The report case on the example scenario                                                       |
| `cleanup` removes `work/` only                                                                                                                                                                               | It removes the run root                                      | The cleanup case, which reads each receipt afterwards                                         |
| `DOMAIN_VERIFY_HELD`, `DOMAIN_VERIFY_UNRESOLVED`, `DOMAIN_VERIFY_UNAVAILABLE`                                                                                                                                | The helper reports that state refusal as a success           | A case that makes each real: a live owner, an interrupted change, a state root that is a file |

- A check id of the sweep is reached by a fixture CLI that tells one lie: a
  small CLI, built without the kernel, kept with the tests. This is the idea
  one ideas report called a self-test, kept as a test fixture and not shipped
  as a command.
- The kernel fault classes need no fixture CLI. They break the real kernel
  under the real example.

**TD5. Platforms.**

- Every process test runs on hosted Linux for each pull request and in the
  macOS nightly.
- A case that cannot run on a platform is registered as unproved there, with a
  title that says so, as the platform parity guide asks.
- Child time limits are sized for hosted Linux, where a stopped CLI was seen
  gone only after 24 to 27 seconds.
- Nothing in this specification has run on Linux. Every "passed" claim tag
  here says macOS only.

**TD6. Prior art in the kernel repository.**

- The author guide's gate, `tests/kernel/author-guide/author-guide.test.ts`:
  it lays out a consuming repository, links the kernel, compiles, lints and
  tests it, and installs the package by git ref.
- Fault replay and its records, `tests/planted-faults/fault-records.json`.
- The author skill's two kinds of test,
  `skills/agent-cli-kernel/references/testing.md`: in process, and through the
  real process.
- The lint tests that prove a rule on each shape it can meet, under
  `tests/template/lint/`.
- The shared test folder and process helpers under `tests/support/`.
- Outside the kernel repository: `verify-template`'s green and red pairs, and
  the cold-start trial's state tests, which reach a held, an unresolved and an
  unavailable refusal through real processes.
