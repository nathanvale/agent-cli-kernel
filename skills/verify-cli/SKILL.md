---

name: verify-cli
description: Prove that a CLI built on agent-cli-kernel really works, the way a user meets it. Use when asked to verify, smoke-test or prove a command of a repository that installs agent-cli-kernel, before claiming a CLI change is done, or when its tests pass but nobody has run the real CLI.
---

# Verifying a CLI built on agent-cli-kernel

Your repository installs the kernel as the package `agent-cli-kernel`. This
skill ships inside it, at `node_modules/agent-cli-kernel/skills/verify-cli/`,
with its own helper: a small CLI built on the same kernel. It judges your
CLI from outside, as a user would: it starts it as a separate process and
reads the exit code, stdout, stderr, the `--json` envelope, and the files it
leaves behind. It never imports your source.

## The helper

Run every helper command from your repository's root, through its front
door:

```text
bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts <command> [arguments]
```

`verify.ts` is the kernel-free check: it does not go through the kernel. It loads the
kernel, runs the helper as a child, and compares the exit code the helper's
envelope claims with the exit code its process really had. On `doctor` it
also runs your CLI twice by hand: an unknown command must exit 2 with one
stderr line ending `[USAGE_UNKNOWN_COMMAND]`, and `--discover --json` must
exit 0 with one envelope. Any mismatch prints `RAW FAIL` lines and exits 70.
Each line names the check that failed: `kernel-*` for the installed kernel,
`target-*` for your CLI, `helper-*` for the helper. A kernel fault can break
the helper and your CLI together; exit 70 is how you see it. Treat exit 70
as a failure to diagnose from those lines, never as a pass. Ctrl-C or
SIGTERM to `verify.ts` reaches the helper, which stops its drive first; then
`verify.ts` exits 130 or 143.

| Command                                              | What it does                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `doctor [--run <run>] [--entry <file>]`              | Is the target worth driving: package, installed kernel, `--help`, discovery |
| `sweep [--run <run>]`                                | Layer 1: every check your CLI's own discovery implies                       |
| `findings [--run <run>]`                             | The same sweep as data, every finding listed                                |
| `launch <run> [--entry <file>]`                      | Make a run: a scratch folder and an evidence folder                         |
| `drive <run> <step> '<argv as JSON>' [expectations]` | Layer 2: run your CLI once and check what you expected                      |
| `evidence <run>`                                     | List the run's evidence files                                               |
| `cleanup <run>`                                      | Remove the run's scratch folder; keep its evidence                          |
| `pending`                                            | List helper changes that never finished                                     |

Add `--json` to any command for its envelope. `<command> --help` shows its
options.

## Two layers

- **Sweep** reads your CLI's discovery and checks what the kernel promises
  for every command: help exits 0, a usage refusal exits 2 with an empty
  stdout and one stderr line, each `--json` envelope's exit code equals the
  process's, and each result is a declared one. It also lists `owed`: the
  declared results nothing has reached yet. The sweep trusts the
  declarations, so it cannot catch a command declared wrongly, or one whose
  result is the wrong one.
- **Scenarios** are the steps in the [feature files](features/README.md):
  exact argv and the exit code, cause, stdout and stderr you expect, written
  by you from what the command must do. Take expectations from the
  feature's purpose, never from the CLI's own discovery output.

Run both. A feature is done when the results its steps reached leave
`owed`; the CLI as a whole is done when `owed` is empty. Drive each owed
result in a scenario, then run `sweep --run <run>` to see it counted. Only
a step run with `--json` counts: without it there is no envelope to name
the command.

## Launch

1. When `node_modules/agent-cli-kernel` is missing, run
   `bun install --frozen-lockfile` once.
2. Pick a name for the verification run that no earlier run used, such as `status-2026-11-20`, and run
   `launch <run>`. Pass `--entry <file>` when the CLI's entry is not
   `src/cli.ts`.
3. Done when `launch` exits 0 and prints the evidence folder.

Each drive starts your CLI in the run's scratch folder, with `HOME` and the
`XDG_*` folders inside it, so your real home is never touched. Two runs never
share a scratch folder, so two agents can verify side by side.

## Doctor

Run `doctor --run <run>` before driving and whenever anything looks off.
Done when it exits 0. Repair each failure it names; drive nothing while it
fails.

## Drive

1. Open the feature file for what you are proving, in
   [features/](features/README.md), and follow its steps in order.
2. Each step is one `drive`: `drive <run> <step> '<argv>' --expect-exit <n>`
   plus the expectations the step names. argv is one JSON array of strings,
   in single quotes.
3. A step passes when `drive` exits 0. Exit 3 with
   `DOMAIN_VERIFY_EXPECTATION_UNMET` means the feature failed: report it with
   the evidence file. Keep the expectation as written.

Every drive of your CLI also checks what the kernel promises every command,
without being asked: an envelope's exit code is the process's; with
`--json`, stdout holds one envelope and stderr is empty; without it, a run
that fails prints nothing on stdout. A broken promise fails the step, and
the evidence lists it under `contract`. A `--script` step, and a step its
timeout stopped, skip these checks.

Expectation options: `--expect-exit <n>`, `--expect-cause <code>` (read from
the `--json` envelope, or from the one stderr line), `--expect-stdout <text>`,
`--expect-stderr <text>` (each a substring, and each may repeat),
`--expect-empty-stdout`, `--expect-empty-stderr`, and
`--expect-file <text>` with `--read-file <path>`, which keeps a file's text
after the step (a relative path is read from the run's scratch folder).
Other options: `--stdin <text>`, `--timeout-ms <n>` (default 30000; the
target is stopped when it runs out), and `--script`, which runs a
`package.json` script in the repository root instead of your CLI: argv
starts with the script's name.

## Evidence

Each step writes one JSON file to
`${XDG_STATE_HOME:-$HOME/.local/state}/verify-cli/runs/<run>/evidence/<step>.json`:
the argv, the full command, exit code, stdout, stderr, whether it timed out,
the cause, the files the step added to or removed from the scratch folder
(`scratchChanges`), and each expectation with what was seen. `run.json` beside it
records the repository and entry. A step name is used once, so evidence is
never overwritten.

Proof standard: drive the real path a user takes, capture the action and the
resulting state, and check side effects with a second, read-only step (the
CLI's own read command, or `--read-file` on the step that made the change).

## Cleanup

Run `cleanup <run>`, then `evidence <run>`. Done when `evidence` lists every
step and reports `scratch: removed`. Cleanup removes only the run's scratch
folder, and with it what your CLI made there. A second cleanup of the same
run is refused as `DOMAIN_VERIFY_RUN_CLEAN`, exit 3: nothing is left to
remove. Every process a drive starts is stopped by that drive, so nothing is
left running; the helper never stops a process by name.

A helper stopped with Ctrl-C or SIGTERM through `verify.ts` stops its drive
and leaves the run usable. A helper killed outright leaves the run refused as
`DOMAIN_VERIFY_RUN_UNRESOLVED`: read `pending`, keep that run's evidence, and
launch a new run under another name.

## What the helper cannot do yet

- Its programs add-on takes no working folder or environment, so the helper
  starts your CLI as `env HOME=... bun --cwd=<folder> <entry>`, and a script
  as `env HOME=... bun --cwd=<repository> run <script>`. Bun reads
  `bun --cwd <folder> run <script>`, without the equals sign, as `bun run`
  with no script: it prints its help and exits 0, having run nothing.
- A program's stdin is closed after `--stdin`'s text, and its output is kept
  as text, not bytes.
