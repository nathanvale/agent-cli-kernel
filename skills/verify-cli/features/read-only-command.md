# A read-only command

A user runs a command that only reads. With `--json` it prints one envelope
naming the command and its cause; without it, the message on stdout,
followed on a success by the result's data as indented JSON when `data` is
not `null`. A domain refusal prints one stderr line and exits 3 (a usage
refusal exits 2). Nothing changes: a `--json` envelope says
`transactionState` `unchanged`, with empty effects.

## Sub-features

- `show-known-planet` reads a known value as an envelope.
- `show-unknown-planet` is refused with the CLI's own cause.

## How to get to it (user POV)

- `bun src/cli.ts show mars --json`, and `bun src/cli.ts show pluto`.

## Driving it with verify-cli

Preconditions: `verify.ts ready src/cli.ts` exits 0, and a run folder from
`verify.ts launch <run folder> src/cli.ts`.

`verify/scenarios/read-only-command.json`:

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
    },
    {
      "name": "show-unknown-planet",
      "argv": ["show", "pluto"],
      "expect": {
        "exitCode": 3,
        "stdout": "",
        "stderr": "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n"
      }
    }
  ]
}
```

Without `--json`, each successful command prints its summary line followed
by indented JSON data:

```text
$ verify.ts drive <run folder> verify/scenarios/read-only-command.json
2 steps met.
$ verify.ts report <run folder>
Stations: 1 swept, 1 driven, 1 owed. Steps: 2 met, 0 unmet.
```

## Gotchas

- The second step runs without `--json`, so it drives no station: the
  unknown-planet refusal stays owed. Add a `--json` step for it to drive it.
- `result` compares exact values. `data` is compared whole; use a dotted
  key such as `data.moons` to compare one field.
- To show that nothing changed, expect `transactionState` and `effects` in a
  `--json` step's `result`. The helper sees only what the CLI reports and
  the files a step names; it does not watch the whole disk.
