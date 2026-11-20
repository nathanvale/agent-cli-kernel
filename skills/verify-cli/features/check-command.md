# The check command

The repository's check command, `bun run check`, lints, checks formatting,
type-checks, tests and runs the dead-code check. It passes on a sound
repository and fails, naming the step, on one that is not.

## Sub-features

- `check-pass` runs `bun run check` to exit 0.
- `check-steps` shows each step ran: lint, format, typecheck, test, fallow.

## How to get to it (user POV)

- `bun run check` in the repository root.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor --run <run>` exits 0.
- The working tree holds the change you are proving.

- **Check.** Run `verify.ts drive <run> check-pass '["check"]' --script --timeout-ms 600000 --expect-exit 0 --expect-stderr "bun test"`. Exit 0.
- **Steps.** Read the evidence file. Its stderr holds bun's `$ eslint`, `$ biome format`, `$ tsc` and `$ bun test` lines in that order, then the test summary; its stdout holds the fallow step's JSON report.

## Gotchas

- `--script` runs `bun run <script>` in the repository root, not in the
  scratch folder, with `HOME` inside the run's scratch folder.
- The check takes minutes; give `--timeout-ms` room, or the step is stopped
  and fails.
- bun prints each script's `$ <command>` line, and `bun test` its summary,
  on stderr, so stderr is not empty here. The fallow step runs with
  `--silent`, so it has no `$` line.
- An exit 0 alone proves nothing: a `bun` that ran no script also exits 0.
  The `--expect-stderr "bun test"` expectation is what shows the check ran.
