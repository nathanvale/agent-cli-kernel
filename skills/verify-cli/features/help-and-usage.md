# Help and usage errors

A user asks for help, or types a word or an option the CLI does not know.
Help prints usage on stdout and exits 0. A wrong word or option prints one
line on stderr naming the cause, prints nothing on stdout, and exits 2.

## Sub-features

- `help` prints `Usage: ` first, exits 0, with an empty stderr.
- `command-help` prints `<commandIdentity> (<effectClass>)` first and exits 0
  (the sweep checks exit 0).
- `unknown-command` refuses a word the CLI does not know.
- `undeclared-option` refuses an option a command does not declare, as one
  stderr line, or as one envelope with `--json`.

## How to get to it (user POV)

- `bun src/cli.ts --help`, and `bun src/cli.ts <command> --help`.
- `bun src/cli.ts nope`: `moons: No declared command matches this
invocation. [USAGE_UNKNOWN_COMMAND]`, exit 2.

## Driving it with verify-cli

Preconditions: `verify.ts ready src/cli.ts` exits 0.

The sweep drives this whole feature, for every command your discovery
lists. Without `--json`, each successful command prints its summary line
followed by indented JSON data:

```text
$ verify.ts sweep src/cli.ts
62 checks passed. Stations owed: 8.
```

On exit 3, run `findings` to list every failed check (or `0 findings` when
the sweep is clean):

```text
$ verify.ts findings src/cli.ts
0 findings from 62 checks.
```

## Gotchas

- A CLI whose own command has an empty route takes any word as that
  command's argument, so the sweep skips the unknown-command checks there.
- The sweep reads your declarations and trusts them. A refusal your command
  declares as a required non-kernel station stays owed until a met `--json`
  step drives it; a refusal your command should give but does not declare is
  invisible to the sweep. Drive both in scenarios.
