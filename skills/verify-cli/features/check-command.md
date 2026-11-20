# The check command

A developer runs `bun run check` in the repository, and every gate passes.

## Sub-features

- `check-passes` runs the check command: exit 0, and the test runner
  reports no failure.

## How to get to it (user POV)

- `bun run check` in the repository root.

## Driving it with verify-cli

Preconditions: a run folder from `launch`.

```json
{
  "schema": "verify-scenario/1",
  "feature": "check-command",
  "steps": [
    {
      "name": "check-passes",
      "runner": "bun",
      "timeoutMilliseconds": 600000,
      "argv": ["run", "check"],
      "expect": { "exitCode": 0, "stderrIncludes": ["\n 0 fail\n"] }
    }
  ]
}
```

```text
$ verify.ts drive <run folder> verify/scenarios/check-command.json
1 steps met.
```

## Gotchas

- The step runs in the repository root, where `bun run check` finds its
  script. Never write `["--cwd", "{repository}", "run", "check"]`: Bun
  reads a working folder given as two words as `bun run` with no script,
  prints its usage, and exits 0, having run nothing. The `stderrIncludes`
  expectation is what makes that step unmet.
- A check command takes minutes; its time limit is the most a step may ask
  for.
