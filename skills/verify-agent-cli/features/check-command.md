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

- **Check.** Run `verify.ts drive <run> check-pass '["run","check"]' --bun --timeout-ms 600000 --expect-exit 0 --expect-stderr "bun test"`. Exit 0.
- **Steps.** Read the evidence file. Its stderr holds `$ eslint`, `$ biome format`, `$ tsc`, `$ bun test` and the fallow step, in that order, and its stdout holds the test summary.

## Gotchas

- `--bun` runs `bun` in the repository root, not in the scratch folder, with
  `HOME` inside the run's scratch folder.
- The check takes minutes; give `--timeout-ms` room, or the step is stopped
  and fails.
- bun prints each script's `$ <command>` line on stderr, so stderr is not
  empty here.
