# Approval without state

An author who lists the approval add-on in `installedAddons` without the
state add-on gets a CLI that refuses to start: every command, `--help`
included, exits 1 and names the missing add-on on stderr. Nothing runs.

## Sub-features

- `approval-help` refuses at start on `--help`.
- `approval-command` refuses at start on a command.
- `approval-doctor` makes the doctor fail.

## How to get to it (user POV)

- `src/cli.ts` passes `installedAddons: ["approval"]` to `contractFor`,
  without `"state"`.

## Driving it with verify.ts

Preconditions:

- A repository whose `contractFor` lists approval without state. Prove this
  on a copy of the repository, never by breaking your working one.
- `verify.ts launch <run>` exits 0.

- **Help.** Run `verify.ts drive <run> approval-help '["--help"]' --expect-exit 1 --expect-stderr "Approval requires the state add-on"`. Exit 0; stdout is empty.
- **Command.** Run `verify.ts drive <run> approval-command '["status","--json"]' --expect-exit 1 --expect-stderr "Approval requires the state add-on"`. Exit 0; the evidence shows `"oneEnvelope": false`.
- **Doctor.** Run `verify.ts doctor --run <run>`. Exit 70, with `RAW FAIL target-usage` and `RAW FAIL target-discovery` lines: the CLI never reaches its kernel's refusals.

## Gotchas

- The refusal is a start-up throw with a stack trace, not an envelope, so
  `--expect-cause` has nothing to read. Match the stderr text.
- The repair is to list `"state"` too and pass the state add-on's
  descriptor to `contractFor`.
