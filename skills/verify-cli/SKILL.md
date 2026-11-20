---

name: verify-cli
description: Prove that a CLI built on agent-cli-kernel really works, the way a user meets it. Use when asked to verify, smoke-test or prove a command of a repository that installs agent-cli-kernel, before claiming a CLI change is done, or when its tests pass but nobody has run the real CLI.
---

# Verifying a CLI built on agent-cli-kernel

Your repository installs the kernel as the package `agent-cli-kernel`. This
skill ships inside it, at `node_modules/agent-cli-kernel/skills/verify-cli/`,
with its own helper: a small CLI built on the same kernel. It judges your
CLI, the target, from outside: it starts it as a separate process and reads
the exit code, stdout, stderr, the `--json` envelope, and the files it
leaves. It never imports your source.

Two layers:

- **Sweep**: every check the target's own discovery implies. It trusts the
  declarations, so it cannot catch a wrong declaration or wrong data.
- **Scenarios**: one JSON file per feature, each step with exact
  expectations you wrote from what the feature must do. Never copy an
  expectation from the CLI's discovery or from a run you have not judged.

Every command below goes through `verify.ts`, the kernel-free check, shown
in full under [Helpers](#helpers). Exit 70 means the run cannot be trusted:
the installed kernel or the helper is broken. Each `RAW FAIL` line on
stderr names the failure and its repair; stdout is empty. Treat exit 70 as
a failure to diagnose, never as a pass. A target that misbehaves while the
helper is honest is exit 3, never 70. One such case comes from `verify.ts`
itself: a target whose probes answer differently on every run, such as a
process id on stderr, prints `TARGET FAIL target-not-repeatable` lines and
exits 3, since the helper's probes of it cannot be confirmed.

## Launch

1. When `node_modules/agent-cli-kernel` is missing, run
   `bun install --frozen-lockfile` once.
2. Choose a new folder for the run, outside every git work tree and every
   other run, such as `"$(mktemp -d)/run"`, which works where `$TMPDIR` is
   not set, as on most Linux hosts. Symbolic links are followed: the folder
   is judged where it really is. Run `launch <run folder> <target entry file>`.
3. Done when `launch` exits 0. The run folder now holds `scratch/`, which a
   run may fill and cleanup removes; `evidence/`, with the run's
   `index.jsonl`; and `state/`, the helper's own state. The index's first
   row binds the run to the target, the repository root, the pinned commit,
   Bun, the platform, and the repository's head commit and count of
   uncommitted paths, untracked files included. Both are null when the
   repository has no `.git` at or above it; any other git failure refuses
   the launch as `DOMAIN_VERIFY_GIT_FAILED`.

A target that keeps state takes its state folder from an argument or an
environment variable. Point it under the run's `scratch/` folder: put
`{scratch}` in the argument, or set the variable on the command line that
runs `drive`, since every step inherits it.

## Doctor

Run `ready <target entry file>` before driving, and whenever anything looks
off. It runs two probes, an undeclared option and `--discover --json`, and
judges eight readiness checks: Bun matches the toolchain pin, the usage
refusal exits 2 with one stderr line and nothing on stdout, and discovery
exits 0 with one envelope that lists a command of your own.

- Exit 0: `The target is ready: 8 readiness checks passed.`
- Exit 3, `DOMAIN_VERIFY_TARGET_START`: the target did not start. The
  message quotes its first error line, such as a missing entry file, an
  error the CLI throws before its kernel runs, or `Approval requires the
state add-on`.
- Exit 3, `DOMAIN_VERIFY_FINDINGS`: the message names each failed check.
  Repair them before driving anything.

Then run `sweep <target entry file>`: `<n> checks passed. Stations owed:
<n>.` Each owed result is a
required station of your own commands the sweep cannot reach. Drive each
one in a scenario. On exit 3, run `findings` with the same target for
every failed check.

## Drive

1. Keep scenario files in your repository's `verify/scenarios/` folder,
   and feature files in `verify/features/`. Copy the
   [seed feature map](features/README.md) there first: this folder is
   read-only under `node_modules`.
2. Run `drive <run folder> <scenario file>`. It checks the whole file,
   then runs every step in order, whatever the earlier verdicts.
3. Exit 0 prints `<n> steps met.` Exit 3 with
   `DOMAIN_VERIFY_EXPECTATION_UNMET` names the first unmet step and what it
   missed: the feature failed. Report it with that step's evidence file.
   Keep the scenario as written; never weaken it to pass.

A scenario file:

```json
{
  "schema": "verify-scenario/1",
  "feature": "read-only-command",
  "steps": [
    {
      "name": "show-known-planet",
      "argv": ["show", "mars", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "commandIdentity": "moons.show",
          "causeCode": "SUCCESS_UNCHANGED",
          "data": { "planet": "mars", "moons": 2 }
        }
      }
    }
  ]
}
```

- A step has `name`, `argv` and `expect`, and may have `runner`,
  `timeoutMilliseconds` (default 20000) and `outputLimitBytes` (default
  1048576 for each stream).
- A step runs Bun on the bound target with its `argv`, in the repository
  root. `"runner": "bun"` passes `argv` to Bun alone, such as
  `["run", "check"]`.
- `expect` needs `exitCode` and at least one of: exact `stdout` or
  `stderr`; `result`, whose keys are fields of the envelope's result or
  dotted paths into it, ending in `length` for a list's size; `files`, each
  a `{scratch}/` path with exact `content` or `"absent": true`; and, on a
  `"runner": "bun"` step only, `stdoutIncludes` and `stderrIncludes`, for
  output with timings. An empty `result`, `files` or includes list does not
  count, and an empty string in an includes list is refused. `timedOut` may
  be added to any of them. A word of `argv` may not hold a NUL.
- `{scratch}` becomes the run's scratch folder and `{repository}` the
  repository root, in every string of `argv` and `expect`.
- A step that passes its time limit is unmet unless it expects
  `"timedOut": true`. A cut output is always unmet.
- On every target step that ended by itself, drive also checks what the
  kernel promises: an envelope's exit code is the process's; with `--json`,
  one envelope and an empty stderr; without it, a failed run prints nothing
  on stdout. A broken promise is listed as `contract.<name>`.
- A broken rule refuses the whole file with `DOMAIN_VERIFY_SCENARIO`,
  naming the rule; nothing runs. A feature already driven in this run is
  refused with `DOMAIN_VERIFY_ALREADY_DRIVEN`: launch a new run.

## Evidence

Each step writes `evidence/<feature>/<step>.json` in the run folder: the
argv, the limits, what was expected, what was observed (exit code,
`timedOut`, `outputTruncated`, `terminationConfirmed`, byte counts, stdout
or the expected result keys, stderr, each expected file's content, and in
`fileKinds` what stood at its path: `file`, `absent`, `folder`, `other`,
`too-large` (over 1,048,576 bytes, not read) or `unreadable`), the `unmet`
list, and the verdict. An expected file holds only as a regular file, and
an absent one only when nothing stands at its path. `evidence/index.jsonl` lists each step with
its verdict, the command and cause its envelope named, and the SHA-256 of
its file. Evidence is never overwritten.

Run `report <run folder>`: `Stations: <n> swept, <n> driven, <n> owed.
Steps: <n> met, <n> unmet.`, then the count of the sweep's failed checks
when there are any. Its data gives each station of your commands one
state, the step or check that gave it, each unmet step, and each step
whose process end was not confirmed. Only a met target step run with
`--json` drives a station, and the sweep sweeps a station only when every
check on the run that reached it passed.

## Cleanup

Run `cleanup <run folder>`. Done when it exits 0 and `report` still exits
0: `scratch/` is gone, and `evidence/` and `state/` remain. A second
cleanup is refused as `DOMAIN_VERIFY_RUN_CLEAN`, exit 3: nothing is left to
remove. Each step's process group is ended before the step returns, so
cleanup stops nothing.

A helper stopped with Ctrl-C or SIGTERM through `verify.ts` stops its
children first, then `verify.ts` exits 130 or 143. A helper killed outright
leaves its change unfinished: the next change to that run is refused as
`DOMAIN_VERIFY_RUN_UNRESOLVED`. Read `pending <run folder>`, keep the run
folder as evidence, and launch a new run.

## Helpers

Run from the repository root; relative paths are read from the folder you run in:

```text
bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts <command> <arguments> [--json]
```

| Command                              | What it does                                                    |
| ------------------------------------ | --------------------------------------------------------------- |
| `ready <target>`                     | Two probes and eight readiness checks                           |
| `probe <target>`                     | What the helper observed for the two probes, unjudged           |
| `sweep <target>`                     | Every check the target's discovery implies; the owed results    |
| `findings <target>`                  | The same sweep as data, every finding listed                    |
| `launch <run folder> <target>`       | Make a run folder bound to one target                           |
| `drive <run folder> <scenario file>` | Run one scenario; one evidence file and index row for each step |
| `report <run folder>`                | Each station's state, unmet steps, unconfirmed process ends     |
| `cleanup <run folder>`               | Remove the run's scratch folder; keep evidence and state        |
| `pending <run folder>`               | The helper's unfinished changes to that run                     |

`<target>` is the target's entry file, such as `src/cli.ts`. Add `--json`
for the helper's envelope, before any `--`. `verify.ts <command> --help`
shows one command. The helper calls itself `verify-cli`; there is no
command of that name, so read it as the `verify.ts` line above. Without
`--json`, its messages already name that line.

What the helper cannot do yet: a step cannot run in another folder or with
its own environment, a compiled target cannot be started, and a target
whose state folder is fixed inside the repository cannot be isolated. Its
feature file says so under Gotchas; drive its change through its own
read-only commands.
