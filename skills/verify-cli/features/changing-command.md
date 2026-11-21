# A changing command

A user runs a command that changes something through the state add-on. The
change lands, a second run behaves as the command promises, and a run
stopped part way leaves an unfinished case that the CLI's report lists and
that blocks the next change to the same thing.

## Sub-features

- `first-run` makes the change: exit 0, `SUCCESS_COMPLETED`, the file
  written.
- `second-run` runs the same change again.
- `nothing-pending` shows the report command lists nothing.
- `interrupted-run` is stopped by its time limit while the change runs.
- `interruption-blocks` refuses the same change as unresolved.
- `interruption-is-listed` shows the report command lists one unfinished
  change.
- `interruption-is-narrow` makes the same change to another thing: the
  block covers only the interrupted change's scope.

## How to get to it (user POV)

- A command whose `--help` first line ends `(repository-local)` or
  `(external)`, such as `visit <planet>`.
- The report command its discovery names under `ifNoResult`, such as
  `pending`.

## Driving it with verify-cli

Preconditions: `verify.ts ready src/cli.ts` lists a command whose
`effectClass` is not `inspect`, and a run folder from `launch`. The scenario
below drives the author skill's example, `moons`: `visit <planet>` writes
the planet's page under `MOONS_HOME`, then starts the program `MOONS_OPENER`
names with that page. Here `MOONS_OPENER` names a test opener that exits 0
at once, except for venus's page, where it waits.

```json
{
  "schema": "verify-scenario/1",
  "feature": "changing-command",
  "steps": [
    {
      "name": "first-run",
      "argv": ["visit", "mars", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "commandIdentity": "moons.visit",
          "causeCode": "SUCCESS_COMPLETED",
          "transactionState": "completed",
          "effects.completed": ["planet.record", "viewer.open-request"]
        },
        "files": [
          {
            "path": "{scratch}/moons/visits/mars.txt",
            "content": "mars has 2 moons.\n"
          }
        ]
      }
    },
    {
      "name": "second-run",
      "argv": ["visit", "mars", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "causeCode": "SUCCESS_COMPLETED"
        },
        "files": [
          {
            "path": "{scratch}/moons/visits/mars.txt",
            "content": "mars has 2 moons.\n"
          }
        ]
      }
    },
    {
      "name": "nothing-pending",
      "argv": ["pending", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "causeCode": "SUCCESS_UNCHANGED",
          "data.unfinished.length": 0
        }
      }
    },
    {
      "name": "interrupted-run",
      "timeoutMilliseconds": 3000,
      "argv": ["visit", "venus", "--json"],
      "expect": {
        "exitCode": 143,
        "timedOut": true,
        "stdout": "",
        "stderr": "",
        "files": [
          {
            "path": "{scratch}/moons/visits/venus.txt",
            "content": "venus has 0 moons.\n"
          }
        ]
      }
    },
    {
      "name": "interruption-blocks",
      "argv": ["visit", "venus", "--json"],
      "expect": {
        "exitCode": 3,
        "stderr": "",
        "result": {
          "causeCode": "DOMAIN_MOONS_VISIT_UNRESOLVED"
        }
      }
    },
    {
      "name": "interruption-is-listed",
      "argv": ["pending", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "causeCode": "SUCCESS_UNCHANGED",
          "data.unfinished.length": 1,
          "data.unfinished.0.effects": ["planet.record", "viewer.open-request"]
        }
      }
    },
    {
      "name": "interruption-is-narrow",
      "argv": ["visit", "earth", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "causeCode": "SUCCESS_COMPLETED"
        }
      }
    }
  ]
}
```

```text
$ MOONS_HOME=<run folder>/scratch/moons MOONS_OPENER=<test opener> verify.ts drive <run folder> verify/scenarios/changing-command.json
7 steps met.
```

## Gotchas

- Keep the target's state under the run's `scratch/` folder, through its
  argument or its environment variable, so cleanup removes it. A target
  whose state folder is fixed inside the repository cannot be isolated yet;
  judge its change through its own read-only commands, and say so here.
- A fast change finishes before any time limit. The interrupted step needs
  a change that waits, as the test opener does for venus.
- `143` is the kernel's exit for SIGTERM, which the time limit sends.
- After the interrupted step, that change stays blocked in this run's
  target state. Use a new run folder for anything else on it.
