# Planted Faults

The [test proof guide](test-proof.md) holds the rule that every new refusal or
bound has a planted fault. This guide holds how to record one and how to keep
its record current.

## Planted faults

- Apply the shared RED-then-GREEN rule to every new refusal or bound.
- Record each planted fault in its own file,
  `tests/planted-faults/fault-records/<id>.json`. After the fix commit, run
  `bun run planted-fault:add <fix sha> <source path> <test file> <title>`,
  then `bun run fault-replay <id>` until it prints `KILLED`. Witnessed:
  [9050fec], [b8664cf] (each recorded faults for refusals that had landed
  with no record), [86749b9] (so did the author skill's eight), [848b6de] (two
  gate checks ran only on the real documents, so a fault that dropped them
  could not fail), [25c2212] (the verification skill's missing-tool
  refusal, help check, budgets, contract checks and stop forwarding landed
  with no record), [c5ce7de] (the fault record folder's readers added
  five refusals with no record; Sol 6.1 review).
- Replay affected fault records when you edit or move a test that catches
  a planted fault, or change the source its patch targets. Keep the patch
  and test selector current in the same commit and require `KILLED`.
  A split guard left a patch stale, and the original changed-file selector
  missed test-only edits. Witnessed: [#54-stale], [#77-test].
- Treat a surviving fault as a missing test. Witnessed: [d72cd9e], [640ba05],
  [3779b5e] (eleven trust-check guards each changed alone left every test
  green; Fable review of pull request 56).
- `KILLED` requires every patched code file (`.ts`, `.mts`, `.js`, `.mjs`) and
  `.json` file to parse, and at least one failing test's full name to match the
  record's `title` regex. A patch that leaves a file unparseable gets
  `UNPARSED` and exits non-zero; re-plant the fault so the patched file parses.
  A faulted run that fails with no failing test matching `title` (including a
  test file that fails to load) gets `UNMATCHED` and exits non-zero; re-plant
  the fault so a matching test fails, or update the record's `title`.
- `bun run fault-replay` copies the working tree once into a temporary folder
  under the system temp directory, gives that copy its own `.git` (`git init`
  and one commit) so tests that call `git` work without writing to the
  checkout's `.git`, installs dependencies once, then replays each fault in
  turn and restores the patched files between faults. The temporary copy is
  removed on every exit.

[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[9050fec]: https://github.com/nathanvale/bun-typescript-template/commit/9050fec545a21a1995b0014151b4d486c2188e06
[b8664cf]: https://github.com/nathanvale/bun-typescript-template/commit/b8664cfdcb826e3870b52b0141c0f4f2efb2eba0
[#54-stale]: https://github.com/nathanvale/bun-typescript-template/pull/54#discussion_r4603739936
[#77-test]: https://github.com/nathanvale/bun-typescript-template/pull/77#discussion_r4606037347
[86749b9]: https://github.com/nathanvale/agent-cli-kernel/commit/86749b9a2dd7b2295a2405513d75299b14550db3
[848b6de]: https://github.com/nathanvale/agent-cli-kernel/commit/848b6de1e7b9bc0792a8ea70f6604f700a09229d
[25c2212]: https://github.com/nathanvale/agent-cli-kernel/commit/25c2212794174aa8686028c0cb35a87515c9ca65
[c5ce7de]: https://github.com/nathanvale/agent-cli-kernel/commit/c5ce7de4210286905ff472706c107b35e0ef42cb
[3779b5e]: https://github.com/nathanvale/agent-cli-kernel/commit/3779b5e0e4e5653217c14115c0025e6fd2197c30
