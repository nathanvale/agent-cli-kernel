# `verify-cli` specification, part 5 of 11: implementation decisions, trust and fit

Continues [part 4](04-implementation-scenarios.md). Sources are in [part
10](10-traceability.md#implementation-decisions).

## Implementation Decisions (continued)

**I18. The trust model.** The kernel-free check is the one entry file,
`verify.ts`. No kernel code runs in its own process. It starts children and
compares raw exit codes and bytes.

Exit 70 means one thing: this run's verdict cannot be trusted, because the
installed kernel or the helper is broken. A target that misbehaves while the
helper is honest is never exit 70. It is a refusal or a finding, exit 3, from
the helper.

In order, the check:

1. Turns each path argument into an absolute path and finds the repository
   root: from the target, or from the run row.
2. Starts a child that imports the kernel by its package name and does nothing
   else. A failed import is `kernel-import`.
3. Probes the helper itself with a command the helper does not declare, with
   `--json`. The helper's `stdout` must be exactly one envelope, else
   `helper-no-envelope`. The envelope's exit code must equal the process's,
   else `helper-exit-mismatch`. Both must be 2, else `helper-usage-exit`.
4. For `ready`, `probe`, `sweep`, `findings`, `launch`, `drive` and `report`,
   runs the helper's `probe` and then the same two probes raw, under the
   helper's own step limits. Each pair must agree on the exit code, the
   `stdout` byte count, the hash of `stdout` with the envelope's own run id
   blanked, and the hash of `stderr` (`b2dcc8f`). The check finds that run id
   by parsing the line, whatever the order of its fields; a run id nested in
   the target's own data is hashed like any other byte (`1c5a65d`, `6542071`).
   A pair that disagrees is probed once more. When the helper and the raw runs
   each answer the same twice, the kernel is at fault: `observation-mismatch`.
   When either side changes between runs, the target is:
   `target-not-repeatable` (`0aeb3de`).
5. For a command on a verification run, confirms that each index row's
   evidence file exists and matches its recorded hash, else
   `evidence-mismatch`. It does this before the command, and again after
   `drive` and `cleanup`.
6. Runs the requested command once, in the repository root, with `--json`
   added before any literal `--`; words after `--` pass untouched (`57a347b`).
   The same envelope rules as step 3 apply.
7. Passes the result on. With `--json` it writes the helper's envelope, byte
   for byte. Without, it writes the envelope's message, to `stdout` on exit 0
   and to `stderr` otherwise, then the data of a success as indented JSON. It
   exits with the helper's exit code.

Rules:

- Steps 2 and 3 always run. A failure in either stops the check before step 4.
- A failure prints `verify-cli: RAW FAIL <id>: <detail> Repair: <next step>`
  on `stderr`, one line for each. `stdout` stays empty, with or without
  `--json`. The exit code is 70.
- `target-not-repeatable` is the one failure that is the target's. Its line
  starts `verify-cli: TARGET FAIL`. When it is the only failure, the exit code
  is 3; with any other failure, 70 (`0aeb3de`).
- A target that runs past the helper's limit on a probe is the helper's to
  judge, exit 3. It is not a `child-timeout` of the check (`0aeb3de`, test
  `5781a53`).
- That is the documented outcome for a run that cannot be trusted. It is not
  an envelope, on purpose. The check cannot use the kernel's writer, and a
  second, hand-built writer of the envelope would be a second owner of that
  format. A reader treats 70 as it treats a signal exit: no envelope to parse.
- A throw inside the check itself is caught at the top and reported as
  `check-internal`, exit 70.
- Each child the check starts is bounded: 60,000 milliseconds for a probe,
  600,000 for a requested command, and 7,200,000 for `drive`, which is above
  the most a valid scenario can take. A child that passes its limit is sent a
  termination signal, is killed after a grace of 10,000 milliseconds if it
  ignores that, and is reported as `child-timeout`. Each child runs in its own
  process group, and the signal goes to the group, so no process a child
  started outlives the check (`1e3ac9a`).
- The check stopped by an interrupt or a termination signal stops the helper
  and the target first, then exits 130 or 143.
- The check waits for each write before it exits, so an envelope over 65,536
  bytes reaches a slow reader whole (`9214b48`).
- Without `--json`, a helper message that names the helper's own name names
  the `verify.ts` command line instead (`57a347b`).
- Probing the helper, not the target, is what keeps the blame right. A fault
  that makes every process exit 0 is caught on every command, even one whose
  honest exit is 0.
- Step 4 covers `launch` so that a kernel fault is not blamed on the
  repository. With the programs add-on dropping `stderr`, `launch` once read
  git's "not a git repository" as an empty failure and refused the launch.

Kernel fault classes the skill must detect. Each is planted in the installed
kernel of a generated repository, one at a time, and restored after.

| Class | The fault                                                | `ready` and `sweep`        | `--help` | `launch` |
| ----- | -------------------------------------------------------- | -------------------------- | -------- | -------- |
| KF1   | The kernel exits 0 from every process                    | 70, `helper-exit-mismatch` | 70       | 70       |
| KF2   | Building a contract throws                               | 70, `helper-no-envelope`   | 70       | 70       |
| KF3   | The package's entry cannot be imported                   | 70, `kernel-import`        | 70       | 70       |
| KF4   | The kernel writes each envelope twice                    | 70, `helper-no-envelope`   | 70       | 70       |
| KF5   | The programs add-on reports every child's exit code as 0 | 70, `observation-mismatch` | 0        | 70       |
| KF6   | The programs add-on drops every child's `stderr`         | 70, `observation-mismatch` | 0        | 70       |
| KF7   | The kernel writes a refusal's line to `stdout`           | 3, a finding               | 0        | 0        |

- The helper alone is blind to KF1: it found failed checks and exited 0. It is
  misled by KF5 and KF6: alone, it reported a failed check against a healthy
  target.
- KF5 and KF6 leave `--help` at 0, rightly: that command starts no target, so
  nothing was misreported. Planted after a healthy `launch`, KF5 is caught by
  `drive` and by `report`, 70.
- KF7 breaks the target's public behaviour while the helper stays honest. So
  it is a finding, and its repair names the installed kernel as well as the
  target.
- One evidence fault class, EF1: an evidence file is missing, or its bytes
  changed. Report: 70, `evidence-mismatch`.
- One target fault class, TF1: the target answers a probe differently on each
  run, such as a process id on `stderr`, or a run id nested in its discovery
  data. Report: 3, `target-not-repeatable`. Before `0aeb3de` it was blamed on
  the kernel.

Not protected against: a fault in Bun or the operating system; a hostile
target, which has the agent's rights; a wrong expectation; a command missing
from discovery that no scenario names; a fault that changes the raw run and
the helper's record in the same way.

Passed on macOS only: the seven classes in the build's own transcript and
tests, and EF1 in its tests. The healthy path passed on Linux too.

**I19. Fit with the kernel repository.** Before this work, neither the
compiler nor any lint covered TypeScript under the skills folder.

- The compiler and the linter take in the skill's TypeScript.
- The consumer lint, the same one a generated repository runs, covers every
  file of the helper. The helper is then a true first consumer: no direct
  process start, no stream write, no deep import.
- The kernel-free check is the one exception, and it is a scoped exception in
  the lint configuration, not a recorded hit. The reasoning:
  - The decisions record asks for the repository's recorded-exception route.
    It also says this choice is the builder's, judged by an independent check.
  - The glossary limits a recorded hit to a violation that existed when its
    gate landed, held until a commit fixes it. These violations are new, and
    permanent by design. Recording them would break both halves of that
    meaning, and the lint's record has no field for a reason.
  - The kernel's own lint already has a route for a rule that one named owner
    may break. It names the one file that may write the process streams, the
    one folder that may start a process, and the one file that may use the
    foreign-function interface. The kernel-free check is one more named owner.
  - So, for `verify.ts` only, the configuration lifts the ban on starting a
    process directly and the ban on writing the process streams, and adds one
    rule only that file has: no import of the kernel, as a static import, a
    dynamic import or a re-export. The reason is in that rule's message.
  - An exception lifts only the restriction it needs. The first build turned a
    whole rule off for the file, and with it the ban on authoring the state
    add-on's factory. That ban now stays on.
  - Costs: lifting a ban for a file does not count its uses, so only review
    and the file size gate bound that file. And the departure from the
    decisions record's wording needs the independent check's agreement.
- The lint's recorded hits hold no file under the skill folder.
- The dead-code tool requires every file to sit in a zone. The skills folder
  is a zone that may import the kernel and nothing else, and the two entry
  files are registered.
- The helper's entry file only starts the helper. `verify.ts` is the
  exception: it holds the kernel-free check's functions as well as its start,
  because splitting it would put the scoped exception on two files. A test
  still imports it and calls each function, since it starts the check only
  when it is the program being run (TD2).
- Every file stays under the 5,000-token file size gate. The skills folder is
  inside that gate's scan.
- No code comment cites an identifier from this specification: no decision,
  criterion, fault class, slice or story number. Test titles, fault record
  names and file names say the behaviour in words. The repository's comment
  lint already refuses most comments; this rule covers the kinds it admits.

Passed on macOS only: the repository's check command at commit `0d7c96b`, one
document-only commit before the build's head, and the build's lint tests. A
search of the build for this specification's identifiers found none.

**I20. Without the programs add-on's folder and environment (K7).** That unit
would give the programs add-on a working folder and an environment for each
program. It is parked, because any change to that add-on voids a capability
qualification record: the record of the Linux runs that qualified the state
add-on on one platform, which Nathan countersigned. Nothing here needs it.

- Working folder: the kernel-free check starts the helper in the repository
  root, and each child inherits it (I7).
- Environment: each child inherits the helper's, which is the agent's command
  line (I15).
- The check command is a `"runner": "bun"` step with the arguments `run` and
  `check`, a time limit of 600,000 milliseconds, and the expectations exit
  code 0 and `stderr` including the test runner's line for no failures: a line
  feed, ` 0 fail` and a line feed.
- What stays out of reach: a different working folder or environment for one
  step; a compiled target; a target whose state folder is fixed inside the
  repository.

Decided by Nathan: the unit stays parked. Passed on macOS only, in the build's
tests.

**I21. The skill document and the feature map.** `SKILL.md` has frontmatter
and pstack's six sections, in pstack's order: Launch, Doctor, Drive, Evidence,
Cleanup, Helpers.

- The Doctor section keeps pstack's heading and holds the `ready` command. The
  command is not named `doctor`: in this repository's glossary, Doctor is the
  command that checks a checkout can run its check command and gates.
- The Helpers section shows the full command line of I3 and every command of
  I6.
- The skill ships a seed feature map: an index and five feature files. Each
  has pstack's four headings: Sub-features; How to get to it (user POV), where
  POV is point of view; Driving it with `verify-cli`; Gotchas. The five are:
  help and usage errors; a read-only command; a changing command with state,
  with a second run and an interrupted run; approval refused without state;
  the check command.
- Each seed file says how to drive its feature: the sweep for help and usage
  errors, `ready` for approval refused without state, and a scenario for the
  other three. It shows only commands and scenarios that were run, with their
  real output. The read-only one uses the author skill's example. The changing
  one states that the author skill has no guidance for a changing command yet.
- A seed file says what a run prints as the kernel prints it. Without
  `--json`, a success prints its message on `stdout`, then its data as
  indented JSON. A cold worker once read a looser line and wrote a step no CLI
  could meet.
- The installed skill is read-only: it sits under `node_modules`. So a
  generated repository keeps its own map and scenarios in its own tree, in a
  `verify/` folder at its root: `verify/features/` for feature files and
  `verify/scenarios/` for scenario files. That folder is the repository's
  maintained verification source, in pstack's words. The seed map is what it
  is first copied from.
- `drive` takes the scenario file's path, so the helper depends on no folder
  name. The folder is a convention the skill document states.
- A scenario file is formatted as the repository's formatter formats JSON. The
  generated repository's check command covers it: the same content on one line
  fails the format step.
- If a scenario cannot pass, the feature file's Gotchas says why and the
  report shows it unmet. The scenario is never weakened.

Passed on macOS only: the build's document tests, and a cold worker that
proved the read-only feature from the installed skill alone.
