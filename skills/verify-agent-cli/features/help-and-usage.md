# Help and usage errors

A user asks the CLI what it can do, asks one command for its options, and
gets a plain refusal, with exit code 2 and nothing on stdout, when they type
a word the CLI does not know or leave out a required argument.

## Sub-features

- `help-root` lists every command with its identity, exit 0.
- `help-command` shows one command's arguments, options and results, exit 0.
- `usage-unknown` refuses an unknown command: exit 2, one stderr line.
- `usage-missing` refuses a command with a required argument left out.
- `usage-json` gives the same refusal as one envelope on stdout.

## How to get to it (user POV)

- `bun run start -- --help`, or `bun src/cli.ts --help`.
- `bun src/cli.ts <command> --help`.
- Any mistyped command or missing argument.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor --run <run>` exits 0.
- You know one command with a required argument, from its `--help`. If the
  CLI has none, `usage-missing` fails with that reason.

- **Root help.** Run `verify.ts drive <run> help-root '["--help"]' --expect-exit 0 --expect-stdout "Usage: " --expect-empty-stderr`. Exit 0.
- **Command help.** Run `verify.ts drive <run> help-command '["status","--help"]' --expect-exit 0 --expect-stdout "Possible results:" --expect-empty-stderr`. Exit 0.
- **Unknown command.** Run `verify.ts drive <run> usage-unknown '["no-such-command"]' --expect-exit 2 --expect-cause USAGE_UNKNOWN_COMMAND`. Exit 0; the evidence file shows an empty stdout and one stderr line ending in the cause.
- **Missing argument.** For a command with a required argument, such as `save <path>`, run `verify.ts drive <run> usage-missing '["save"]' --expect-exit 2 --expect-cause USAGE_INVALID_INVOCATION --expect-stderr "is missing"`. Exit 0.
- **Refusal as JSON.** Run `verify.ts drive <run> usage-json '["no-such-command","--json"]' --expect-exit 2 --expect-cause USAGE_UNKNOWN_COMMAND --expect-empty-stderr`. Exit 0; the evidence shows `"oneEnvelope": true`.
- **Sweep.** Run `verify.ts sweep --run <run>`. Exit 0.

## Gotchas

- `bun run start` echoes `$ bun run src/cli.ts` on stderr. The helper runs
  the entry file directly, so its stderr is the CLI's own.
- `<command> --help` answers with the command's discovery, not the root
  help.
- An option takes its value as the next word; `--name=value` is a usage
  refusal.
