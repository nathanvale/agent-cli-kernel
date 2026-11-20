# `verify-cli` specification, part 3 of 11: implementation decisions, the commands

Implementation decisions are numbered I1 to I21 across parts 3, 4 and 5. Each
ends with what has run. Its sources, with file and line, are in [part
10](10-traceability.md#implementation-decisions), not here: this part names no
source file, so it does not go stale when one moves.

The build exists: kernel pull request 56. Where it has run evidence, these
decisions describe it as built. Where the earlier text of this specification
said something else, the
[map](00-map.md#where-the-inputs-and-the-code-disagreed) lists the difference.

Standard output and standard error are written `stdout` and `stderr`. The
words target, helper, kernel-free check, probe, verification run, scratch
folder, evidence folder, step, scenario, sweep, finding, owed result and
contract check are the kernel glossary's.

## Implementation Decisions

**I1. Name and placement.** The skill is named `verify-cli`. It sits beside
the author skill in the kernel repository's skills folder, so a generated
repository finds it at `node_modules/agent-cli-kernel/skills/verify-cli/`. The
template's pointer skill (T4) names it too; that pointer is not this work.
pstack names a generated skill `verify-<app>`. One shipped skill serves every
generated repository, so it cannot carry one CLI's name. Decided by Nathan.

**I2. The helper's source lives in the skill folder.** Every file the helper
needs to run is inside the skill folder. Each import there names the kernel
package, a runtime module, or a file in the folder. So the folder can be
copied into another product, or cached there. What that costs:

- The helper imports the kernel by its package name. Inside the installed
  kernel, that name resolves to the enclosing package. Copied to a place with
  no kernel installed above it, the kernel-free check exits 70 and names the
  import. Copied into any repository that installs the kernel, it runs, and
  can judge a target in a third folder.
- A carried copy needs three things installed where it lands: Bun at the
  kernel's toolchain pin; the `agent-cli-kernel` package, at a commit whose
  public interface the helper uses; and that package's add-on requirements,
  today the two `@logtape` packages.
- A carried copy loses the Pin's promise. Nothing checks that the kernel
  beside it is the commit it was written for.
- The helper's tests do not travel. They stay in the kernel repository's test
  area.
- The kernel imports nothing from the skill, so the skill adds no dependency
  to the kernel.

Decided by Nathan. Both copy results passed on macOS only, in the build's
tests.

**I3. Started without a `bin` entry.** The agent starts the helper by running
Bun on the kernel-free check's file, `verify.ts`, in the installed skill
folder, followed by the command and its arguments. The skill document shows
that line in full. `verify.ts <command> --help` shows one command. A `bin`
entry is for people; no agent needs one. Decided by Nathan. Passed on Linux
and on macOS.

**I4. Built on the kernel.** Read-only commands are declared with `command`,
changing commands with `changing`, and the contract with `contractFor`. The
helper selects three add-ons: state, programs and diagnostics.

- State: `launch`, `drive` and `cleanup` change files. The kernel refuses a
  changing command without the state add-on.
- Programs: the only way the helper starts a target. A read-only command uses
  the add-on's route for a program the caller supplies. `drive` starts each
  step inside its recorded effect. Every command that starts a program
  carries, in its summary, the sentence the add-on requires.
- Diagnostics: the helper's own trace, and nothing else (I17).
- Approval is left out on purpose. The helper removes nothing outside its own
  verification run.
- Each changing command declares one effect: `run.create`, `scenario.drive`
  and `scratch.remove`. The constraint behind that: the state add-on reports a
  transaction's effects in the order they ran, and its transaction proof
  refuses them unless they are sorted by name. So effect names must sort into
  the order they run. One effect for a whole drive keeps any step order valid.

Decided by Nathan. Passed on Linux and on macOS.

**I5. Judged from outside.** The helper starts the target as a separate
process and never imports it. It judges by plain JSON (JavaScript Object
Notation) parsing and literal comparison, with no kernel code in the
comparison. It reads pipes, not a terminal: pstack asks for a terminal session
for each drive, and the kernel's source never asks whether a stream is a
terminal, so a pipe shows what a terminal would. Passed on Linux and on macOS.

**I6. Commands.** Every command is reached through the kernel-free check
(I18).

| Command                              | What it changes                                          | Add-ons                      | Result on success                                           |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `ready <target>`                     | Nothing                                                  | programs                     | Contract version and the target's own commands              |
| `probe <target>`                     | Nothing                                                  | programs                     | What the helper observed for the two probes, unjudged       |
| `sweep <target>`                     | Nothing                                                  | programs                     | Check count, stations swept, owed results                   |
| `findings <target>`                  | Nothing                                                  | programs                     | Check count and every finding of the sweep                  |
| `launch <run folder> <target>`       | Makes the verification run and its run row               | state, programs, diagnostics | The binding it recorded                                     |
| `drive <run folder> <scenario file>` | Writes one evidence file and one index row for each step | state, programs, diagnostics | Each step's verdict and evidence file                       |
| `report <run folder>`                | Nothing                                                  | programs                     | Each station's state; unmet steps; unconfirmed process ends |
| `cleanup <run folder>`               | Removes the scratch folder                               | state, diagnostics           | What it removed and what it kept                            |
| `pending <run folder>`               | Nothing                                                  | state                        | The state add-on's report for that run, whole               |

- A refusal carries no data. So `sweep` gates and `findings` shows: one
  function computes the sweep, and three commands call it (`sweep`,
  `findings`, `report`).
- A finding of `findings` is a failed check of the sweep. The readiness checks
  of I9 are not sweep checks. `ready` names its failed checks in its own
  refusal message.
- `probe` exists for the kernel-free check, which compares it with a raw run.
  An agent may run it too.
- `pending` is the read-only command the state add-on requires a changing CLI
  to name. The state add-on names it with no arguments, and the kernel refuses
  guidance that does not parse. So the run folder is optional in the command's
  declaration, and a `pending` with no folder, or with a folder `launch` never
  made, is refused.
- `launch` uses the programs add-on to ask `git` for two facts (I14).

Passed on Linux and on macOS for every command but `pending`, which passed on
macOS only.

**I7. How a target is named and bound.** One rule covers every command.

- `<target>` is the path of the target's entry file. It may be absolute, or
  relative to the folder the command was started in. The kernel-free check
  turns each path argument into an absolute path before the helper sees it.
  The helper's own input accepts an absolute path only.
- The repository root is the nearest folder, at or above the target, that
  holds a `package.json`.
- `launch` is the only command that binds. It writes the repository root, as
  an absolute path, and the target, relative to that root, into the run row. A
  verification run has one target for its whole life.
- `drive`, `report`, `cleanup` and `pending` take the run folder and read the
  binding from the run row. They accept no target. A scenario file names no
  target either.
- `ready`, `probe`, `sweep` and `findings` have no verification run, so each
  takes `<target>` itself.
- A target step runs Bun on the bound entry file with the step's arguments. A
  step marked `"runner": "bun"` passes its arguments to Bun alone. Bun is the
  Bun running the helper, told not to install anything.
- The kernel-free check starts the helper in the repository root. A child
  inherits its parent's working folder, so every step starts there, wherever
  the agent started the command. No change to the programs add-on is needed.
- A step's environment is the one the agent's command line had. The helper
  records no environment, since it may hold secrets.

Passed on Linux and on macOS for a relative target and a run row. The working
folder passed on macOS only.

**I8. Exit and cause codes.** One envelope on every exit except 70, 130 and 143.
The names are the build's.

| Exit     | Cause code                                                                                  | Outcome           | Selected by                                                                         |
| -------- | ------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| 0        | `SUCCESS_UNCHANGED`                                                                         | success           | every read-only command                                                             |
| 0        | `SUCCESS_COMPLETED`                                                                         | success           | `launch`, `drive`, `cleanup`                                                        |
| 3        | `DOMAIN_VERIFY_TARGET_START`                                                                | refused           | `ready`: the target answered neither probe                                          |
| 3        | `DOMAIN_VERIFY_FINDINGS`                                                                    | refused           | `ready`, `sweep`: a check failed                                                    |
| 3        | `DOMAIN_VERIFY_TARGET_MISSING`                                                              | refused           | `launch`: no file at the target's path                                              |
| 3        | `DOMAIN_VERIFY_RUN_EXISTS`                                                                  | refused           | `launch`: the folder is not new or empty                                            |
| 3        | `DOMAIN_VERIFY_RUN_IN_WORK_TREE`                                                            | refused           | `launch`: the folder is inside a git work tree                                      |
| 3        | `DOMAIN_VERIFY_NO_PIN`                                                                      | refused           | `launch`: no `package.json` above the target, or none with a kernel Pin             |
| 3        | `DOMAIN_VERIFY_GIT_FAILED`                                                                  | refused           | `launch`: `git` failed for a reason other than "no work tree"                       |
| 3        | `DOMAIN_VERIFY_RUN_MISSING`                                                                 | refused           | `drive`, `report`, `cleanup`, `pending`: the folder holds no run that `launch` made |
| 3        | `DOMAIN_VERIFY_RUN_CLEAN`                                                                   | refused           | `cleanup`, `drive`: the scratch folder is already removed                           |
| 3        | `DOMAIN_VERIFY_SCENARIO`                                                                    | refused           | `drive`: the scenario file breaks a rule in I13                                     |
| 3        | `DOMAIN_VERIFY_ALREADY_DRIVEN`                                                              | refused           | `drive`: the index holds a row for this feature                                     |
| 3        | `DOMAIN_VERIFY_EVIDENCE_UNREADABLE`                                                         | refused           | `drive`, `report`: the index or an evidence file cannot be read                     |
| 3        | `DOMAIN_VERIFY_RUN_HELD`, `DOMAIN_VERIFY_RUN_UNRESOLVED`, `DOMAIN_VERIFY_STATE_UNAVAILABLE` | refused           | a changing command, and `pending` for the third: the state add-on refused           |
| 3        | `DOMAIN_VERIFY_EXPECTATION_UNMET`                                                           | failed, completed | `drive`: every evidence file was written and a step was unmet                       |
| 3        | `DOMAIN_VERIFY_CHANGE_UNKNOWN`                                                              | failed, unknown   | a changing command: its change started and was not confirmed                        |
| 3        | `DOMAIN_VERIFY_CHANGE_UNCHANGED`                                                            | failed, unchanged | a changing command: it failed before it touched anything                            |
| 1, 2, 4  | the kernel's own                                                                            |                   | internal, usage and schema results                                                  |
| 70       | none                                                                                        | none              | the kernel-free check: the run cannot be trusted (I18)                              |
| 130, 143 | none                                                                                        | none              | the kernel-free check was stopped by an interrupt or a termination signal (I18)     |

- `findings`, `report` and `pending` gate nothing: each succeeds whenever it
  can read what it reports.
- A refusal's message names the exact restriction that refused. Its station's
  repair action names the next step.
- A second `cleanup` is a refusal, `DOMAIN_VERIFY_RUN_CLEAN`, not a success. A
  changing command cannot return a success that changed nothing: with
  transaction state `unchanged` and outcome `success`, the kernel's proof
  allows no remaining effect, and the command's declared effect is remaining.
- The kernel's discovery lists exit meanings 0, 1, 2, 3, 4 and 75. It never
  uses 70.

Passed on macOS only, in the build's tests, for every cause. A second
`cleanup` passed on Linux too.

**I9. `ready`.** It runs two probes of the target and judges eight readiness
checks.

- The usage probe is one word, `--verify-cli-undeclared-option`, an option no
  CLI declares. It is not an unknown command: a CLI whose command has no route
  word takes any plain word as that command's argument and exits 0.
- The discovery probe is `--discover --json`.

| Check id                      | What must hold                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `bun-matches-toolchain-pin`   | The running Bun is the version in the root's `packageManager`, when that field exists     |
| `usage-probe-exit`            | The usage probe exits 2                                                                   |
| `usage-probe-stdout-empty`    | Its `stdout` is empty                                                                     |
| `usage-probe-one-stderr-line` | Its `stderr` is one line ending `[USAGE_UNKNOWN_COMMAND]` or `[USAGE_INVALID_INVOCATION]` |
| `discovery-exit`              | The discovery probe exits 0                                                               |
| `discovery-stderr-empty`      | Its `stderr` is empty                                                                     |
| `discovery-one-envelope`      | Its `stdout` is one envelope whose exit code is 0                                         |
| `discovery-has-host-command`  | It lists one command of the target's own, or more                                         |

- The target did not start when the usage probe's `stderr` is not such a line
  and the discovery probe wrote no envelope. `ready` then refuses with
  `DOMAIN_VERIFY_TARGET_START`. Its message gives the usage probe's exit code
  and quotes one line of `stderr`: the first that starts `error: `, else the
  first that is not empty. The quote is cut at 300 characters. A target that
  selects approval without state, a target that throws its own error, and a
  missing entry file all end here.
- Any other failed check refuses with `DOMAIN_VERIFY_FINDINGS`, naming each
  failed check id.
- Success prints `The target is ready: 8 readiness checks passed.` and returns
  the contract version and each of the target's own commands with its effect
  class.

Passed on Linux and on macOS for the success. The refusals passed on macOS
only.

**I10. Layer 1, the sweep.** Derived only from the target's discovery. It
trusts the declarations.

- The target's own commands are the commands its repository declares.
  Discovery lists them beside the four the kernel adds: help, discovery,
  command discovery and dispatch. The command routed `--help` has the identity
  `<cli>.help`, which gives `<cli>`. The kernel's four are `<cli>.help`,
  `<cli>.discovery`, `<cli>.command-discovery` and `<cli>.dispatch`. Every
  other listed command is the target's own. Routes cannot tell them apart: a
  command of the target's own may have an empty route, as dispatch does.
- Checks on the CLI: `--help` exits 0 with empty `stderr` and `stdout`
  starting `Usage: `. `--discover --json` exits 0 with empty `stderr` and
  lists a command of the target's own. Unless one of those has an empty route,
  an unknown command exits 2 with empty `stdout` and one `stderr` line ending
  `[USAGE_UNKNOWN_COMMAND]`.
- Checks on each of the target's own commands: its command discovery exits 0.
  An undeclared option with `--json` exits 2 with empty `stderr`, an envelope
  whose exit code equals the process's, and a cause the command declares.
  Without `--json` it exits 2 with empty `stdout` and one `stderr` line ending
  `[USAGE_INVALID_INVOCATION]`. Its `--help` exits 0.
- Each such command of effect class `inspect` that needs no input is run once
  with `--json`: empty `stderr`, an envelope whose exit code equals the
  process's, a declared cause, its own command identity. No other command is
  run.
- That is 9 checks on the CLI, 9 on each command and 4 on each command run: 31
  for the author skill's example. A CLI with one command on an empty route
  gets 15.
- A check id states what must hold. A finding is a failed check: its id, the
  arguments, what was expected and what was seen.
- Success prints `<n> checks passed. Stations owed: <n>.` A failure refuses
  with `<n> of <n> checks failed.` and the first finding.
- The sweep cannot catch a wrong declaration, a command missing from
  discovery, wrong data, a refusal that needs input, or any change.

Passed on Linux and on macOS for the example. The empty route passed on macOS
only.
