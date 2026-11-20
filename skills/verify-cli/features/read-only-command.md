# A read-only command

A user runs a command that reads and reports. They get its message and data
on stdout with exit 0, the same result as one envelope with `--json`, and
nothing on stderr.

## Sub-features

- `read-human` prints the message, then the data, exit 0.
- `read-json` prints one envelope on stdout and nothing on stderr.
- `read-refusal` refuses a domain mistake, such as an unknown name, with
  exit 3 and its own cause.

## How to get to it (user POV)

- `bun src/cli.ts status`, or any command whose `--help` first line ends
  `(inspect)`.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor --run <run>` exits 0 and lists the command with
  `effectClass` `inspect`.

- **Human read.** Run `verify.ts drive <run> read-human '["status"]' --expect-exit 0 --expect-stdout "The command-line tool runs." --expect-stdout '"ready": true' --expect-empty-stderr`. Exit 0; the evidence's stdout shows the message line, then the data.
- **JSON read.** Run `verify.ts drive <run> read-json '["status","--json"]' --expect-exit 0 --expect-cause SUCCESS_UNCHANGED --expect-stdout '"ready":true' --expect-empty-stderr`. Exit 0; the evidence shows `"oneEnvelope": true`.
- **Domain refusal.** For a command that refuses a bad value, such as `show pluto` in the author skill's example, run `verify.ts drive <run> read-refusal '["show","pluto"]' --expect-exit 3 --expect-cause DOMAIN_MOONS_UNKNOWN_PLANET --expect-empty-stdout`, then `verify.ts drive <run> read-refusal-json '["show","pluto","--json"]' --expect-exit 3 --expect-cause DOMAIN_MOONS_UNKNOWN_PLANET --expect-empty-stderr`. Each exits 0. A CLI with no such refusal reports this step as not proved, with that reason.
- **Owed results.** Run `verify.ts sweep --run <run>`. The results your `--json` steps reached are gone from `owed`; other commands' results stay there.

## Gotchas

- Without `--json`, a success prints the data as indented JSON after the
  message line; match a short substring, not the whole block.
- A read-only command changes nothing. Its evidence shows
  `"transactionState":"unchanged"` in the envelope and an empty
  `scratchChanges.added`; a file there is a change the command did not
  declare.
