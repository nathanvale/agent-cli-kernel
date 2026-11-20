# Feature map

This folder is the maintained source for proving what a CLI built on
agent-cli-kernel does for its user. Read this index, then use the matching
feature file as the recipe. Add a file when your CLI gains a feature a user
can reach; keep each file's four sections.

## Baseline

- Run every command from the repository root, once
  `node_modules/agent-cli-kernel` is installed.
- `verify.ts` below stands for
  `bun node_modules/agent-cli-kernel/skills/verify-agent-cli/verify.ts`.
  Write the full command each time.
- Launch a fresh run for each feature: `verify.ts launch <run>`, then
  `verify.ts doctor --run <run>`. Both exit 0 before any step.
- `status` is the command every generated repository starts with. Put your
  own command's name and words where a file uses it.

## Driving conventions

- Each step is one `verify.ts drive <run> <step> '<argv>' <expectations>`.
  The step name is new in its run; argv is a JSON array in single quotes.
- Write each expectation from what the feature must do for its user. Never
  copy one from the CLI's discovery or from a run you have not judged.
- A step that exits 3 with `DOMAIN_VERIFY_EXPECTATION_UNMET` is a failed
  feature. Report it with its evidence file. Keep the journey as written,
  and keep its expectations.
- Report a step whose precondition the repository lacks (no changing
  command, say) as not proved, with the reason. It is never a pass, and a
  feature with a step not proved is not proved as a whole: report which
  steps passed.

## Proof and cleanup

- Every step's evidence lands in the run's evidence folder, which
  `verify.ts evidence <run>` lists.
- Prove a change with a second, read-only step, never with the change's own
  message alone.
- Finish with `verify.ts cleanup <run>` and `verify.ts evidence <run>`:
  every step listed and `scratch: removed`.
- Run `verify.ts sweep --run <run>`: results the feature reached leave the
  `owed` list.

## Feature entry contract

Each file starts with an H1 and one paragraph on the user-visible
behaviour, then four H2 sections in order: `Sub-features` (short IDs, one
line each), `How to get to it (user POV)`, `Driving it with verify.ts`
(starts with `Preconditions:`, then one labelled bullet per step pairing the
action, the exact command and the observable result), and `Gotchas`.

## Features

- [Help and usage errors](help-and-usage.md): help, a command's help, and
  the refusals a user meets for a wrong word or a missing argument.
- [A read-only command](read-only-command.md): a read in human and `--json`
  form, with streams and exit code.
- [A changing command](changing-command.md): a change, its read-back, a
  second run, and an interrupted run.
- [Approval without state](approval-without-state.md): a CLI that lists the
  approval add-on without the state add-on refuses at start.
- [The check command](check-command.md): `bun run check` passes in the
  repository.
