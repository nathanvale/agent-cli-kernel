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

## How to get to it (user POV)

- A command whose `--help` first line ends `(repository-local)` or
  `(external)`, such as `save <path> --content <text>`.
- The report command its discovery names under `ifNoResult`, such as
  `pending`.

## Driving it with verify-cli

Preconditions: `verify.ts ready src/cli.ts` lists a command whose
`effectClass` is not `inspect`, and a run folder from `launch`. The author
skill has no guidance for a changing command yet; this scenario was run on
a test CLI with a `save` command, a `pending` command, and its state folder
in the variable `NOTES_STATE`.

```json
{
  "schema": "verify-scenario/1",
  "feature": "changing-command",
  "steps": [
    {
      "name": "first-run",
      "argv": ["save", "{scratch}/note", "--content", "proof", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "commandIdentity": "notes.save",
          "causeCode": "SUCCESS_COMPLETED",
          "transactionState": "completed",
          "effects.completed": ["note.write"]
        },
        "files": [{ "path": "{scratch}/note", "content": "proof" }]
      }
    },
    {
      "name": "second-run",
      "argv": ["save", "{scratch}/note", "--content", "again", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": { "causeCode": "SUCCESS_COMPLETED" },
        "files": [{ "path": "{scratch}/note", "content": "again" }]
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
      "argv": ["save", "{scratch}/held", "--content", "hold", "--json"],
      "expect": {
        "exitCode": 143,
        "timedOut": true,
        "stdout": "",
        "stderr": "",
        "files": [{ "path": "{scratch}/held", "absent": true }]
      }
    },
    {
      "name": "interruption-blocks",
      "argv": ["save", "{scratch}/held", "--content", "again", "--json"],
      "expect": {
        "exitCode": 3,
        "stderr": "",
        "result": { "causeCode": "DOMAIN_NOTES_UNRESOLVED" }
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
          "data.unfinished.0.commandIdentity": "notes.save"
        }
      }
    }
  ]
}
```

```text
$ NOTES_STATE=<run folder>/scratch/notes-state verify.ts drive <run folder> verify/scenarios/changing-command.json
6 steps met.
```

## Gotchas

- Keep the target's state under the run's `scratch/` folder, through its
  argument or its environment variable, so cleanup removes it. A target
  whose state folder is fixed inside the repository cannot be isolated yet;
  judge its change through its own read-only commands, and say so here.
- A fast change finishes before any time limit. The interrupted step needs
  a change that waits, as the test CLI's `hold` content does.
- `143` is the kernel's exit for SIGTERM, which the time limit sends.
- After the interrupted step, that change stays blocked in this run's
  target state. Use a new run folder for anything else on it.
