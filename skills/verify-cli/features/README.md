# Feature map

The seed of a generated repository's own feature map. Copy this folder to
`verify/features/` at your repository's root, and write each feature's
scenario to `verify/scenarios/<feature>.json`. That `verify/` folder is
your maintained verification source; this copy under `node_modules` is
read-only, and changes whenever the pin names another commit.

## Baseline

- `verify.ts` below stands for
  `bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts`, run from
  the repository root. Write the full command each time.
- `ready src/cli.ts` exits 0 before any feature is driven.
- Each feature gets its own run folder from `launch`, so a feature driven
  twice never shares evidence.
- The examples use the author skill's example CLI, `moons`. Put your own
  command's words where a file uses it.

## Driving conventions

- Write each expectation from what the feature must do for its user. Never
  copy one from the CLI's discovery or from a run you have not judged.
- A step that is unmet is a failed feature. Report it with its evidence
  file. Keep the scenario as written.
- When a scenario cannot pass, its feature file's Gotchas says why, and
  `report` shows the step unmet. The scenario is never weakened.
- Format each scenario file as your repository formats JSON, so the check
  command covers it.

## Proof and cleanup

- `report <run folder>` after the last drive: each station of your
  commands is swept, driven or owed.
- Prove a change with a second, read-only step, never with the change's own
  message alone.
- Finish with `cleanup <run folder>`, then `report <run folder>` again: the
  evidence outlives the scratch folder.

## Feature entry contract

Each file starts with an H1 and one paragraph on the user-visible
behaviour, then four H2 sections in order: `Sub-features` (short IDs, one
line each), `How to get to it (user POV)`, `Driving it with verify-cli`
(starts with `Preconditions:`, then the commands with their real output),
and `Gotchas`.

## Features

- [Help and usage errors](help-and-usage.md): help, a command's help, and
  the refusals a user meets for a wrong word or a wrong option. Driven by
  the sweep.
- [A read-only command](read-only-command.md): a read in `--json` and human
  form, with streams and exit code. Driven by a scenario.
- [A changing command](changing-command.md): a change, a second run, and an
  interrupted run. Driven by a scenario.
- [Approval without state](approval-without-state.md): a CLI that selects
  approval without the state add-on refuses at start. Driven by `ready`.
- [The check command](check-command.md): `bun run check` passes in the
  repository. Driven by a scenario.
- [Kernel-free forensics](forensics.md): read-only inspection of a
  verification run, state journal, diagnostics custody folder, or approval
  store, even when the kernel cannot start. Driven by `forensics`.
