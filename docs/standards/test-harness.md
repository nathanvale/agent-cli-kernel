# Test Harness

The test harness is the tooling that starts and observes a real CLI process.
This guide lists how this repository's test harness bounds and releases the
processes it starts, fakes the tools they call, and waits on time. It also
covers the test timings, which decide which shard of the hosted `test` job
runs each test file. What a test must prove is in the
[test proof guide](test-proof.md).

## Processes

- Bound every child below its test timeout, a fixture's git call and a
  script's synchronous git read included. Witnessed: [#85-probe], [e990da6],
  [#92-bound] (the in-process fault fixture could block on git),
  [4a32366],
  [7623343], [#91-bound] (the native admission fixture could outlive its
  case), [c77aaa9] (the production `execute` spawned tsc and fallow with
  no time limit), [24cbab3], [#84-probe] (blocking fixture commands could
  prevent the test timeout and cleanup), [#90-process] (bootstrap helpers
  could wait indefinitely for a generated repository command),
  [#109-bound] (a process-runner case started a nested child with no time
  limit), [kernel#13-readers], [9086c3b] (L08.a started its readers with no
  time limit, and only a reader that exited, not one killed or failed, went
  through the release step that frees a blocked named-pipe open),
  [kernel#18 r4625198722], [93dd83e] (K11.g and the other new state tests
  started their CLI children with no time limit; the state test harness
  now gives every `world.start` a 60 s default bound), [4ca0141] (the
  installed-kernel lint process and its cases shared one 120 s bound),
  [ff0616c] (the author skill's example bounded its process child at 20 s
  under Bun's 5 s test timeout).
- Give a test or a setup hook a timeout that covers the sum of the bounds of
  every child it runs in sequence, not only the largest one. Witnessed:
  [kernel#48 review 5987095580], [fdfa794] (setup reserved 60 s for a copy
  that ran two git staging calls bounded at 60 s each, and the copy test ran
  on the default timeout), [308d494] (the author skill's install case
  allowed 120 s for a 110 s install and up to seven 4 s git calls),
  [0ab74b8] (the verification skill's cases ran up to six 30 s helpers
  under a 60 s timeout).
- Template tests: reuse `spawnBounded` (`tests/support/process.ts`), which
  runs the child through `startChild` (`scripts/process-runner.ts`), for that
  bound. Kernel tests: reuse `spawnBounded`
  (`tests/kernel/kernel-repair/swarm-process.ts`) or `exitWithin`
  (`tests/kernel/lifecycle/harness.ts`). Witnessed: [308d494] (the author
  guide's gate, a kernel test, used the template's `spawnBounded`),
  [0ab74b8] (so did the verification skill's tests, and one started its
  helper with no limit at all).
- In `finally` or per-case teardown, release the CLI, its ledgered children,
  then its temporary folders. Witnessed: [d592b6d], [70c7280], [#84-cleanup],
  [#91-cleanup], [5533cd6], [e766237] (the pinned-commit binary case joined
  its CLI runs with `Promise.all`, so one run passing its bound could fail
  the case and let teardown remove the folder while another still ran; it
  now waits for every run to settle), [ff0616c] (the author skill's gate
  lost its temporary folder when the build that made it failed, since
  teardown read the path from the failed build).
- At teardown, send SIGKILL, and only to a pid still in its ledgered process
  group. Witnessed: [0ebe7cf], [1a29b19].

## Fake tools

- Fake a tool with a small stub script that holds its behaviour, not a
  system binary linked under the tool's name. A linked `/bin/echo` named
  `tsc` exited non-zero on GitHub's Linux runner, and a linked `/bin/sh`
  named `fallow` leaned on a file named `list` to become the script.
  Witnessed: [3729f36], [5f0c1d9] (Copilot review thread on the same pull
  request).

## Time

- Wait on an event the subject produces (a ready file, ledger line, or
  barrier), or drive the fake clock in
  `tests/kernel/lifecycle/recording-host.ts`. Witnessed: [b077b0b],
  [4386b03], [kernel#12-turns] (a count of event-loop turns is not an
  event: state tests waited one turn for a transaction to end, and failed
  on correct code that took two more; a turn count may only bound the
  wait).
- Wait for the event that finishes setup, not for the first sign of it. A
  test that moved the diagnostics log as soon as the file existed raced the
  sink's own check that the name still held the inode it opened, and the
  sink correctly refused and wrote nothing; it now waits for the first
  record byte. Witnessed: [kernel#54-run], [kernel#55-run].
- Widen a race control until it catches its fault on every run. Witnessed:
  [2b2907a] (caught in 48 of 50 runs before widening).
- Bound a duration a test reads back from output by zero below and, above,
  by the wall time it measured plus half the printed precision (0.05 s for
  one decimal). A rounded duration can read 0.0 on a fast host, so an
  assertion above zero fails there. Witnessed: [07d2d72], [e50afb6].

## Timings

- Refresh the moved suites' entries in `tests/test-timings.json` from the
  hosted timing artifacts when a slow suite moves, and drop the keys of the
  paths it left. Witnessed: [#91-timings] (the original estimate stayed on
  the smallest suite, and all five moved suites ran on one shard),
  [#99-timings], [#99-shards] (the timings kept the old
  `tests/check-commits.test.ts` key, and every moved template suite ran on
  shard 3).
- `bun run fault-replay --shard <part>/<parts>` splits the fault records by
  the seconds in `tests/planted-faults/fault-timings/<id>.json`, heaviest
  first, and counts a fault with no timing file as 0.35 s. When a hosted
  fault replay log shows a fault at 1 s or more (`KILLED <id> in <seconds>
  s`), write those seconds to its timing file, and delete the timing files
  of records that left. A part that holds no fault record fails.

[kernel#54-run]: https://github.com/nathanvale/agent-cli-kernel/actions/runs/44694912382
[kernel#55-run]: https://github.com/nathanvale/agent-cli-kernel/actions/runs/44725390642
[#92-bound]: https://github.com/nathanvale/bun-typescript-template/pull/92#discussion_r4607819546
[#85-probe]: https://github.com/nathanvale/bun-typescript-template/pull/85#discussion_r4607322041
[e990da6]: https://github.com/nathanvale/bun-typescript-template/commit/e990da67151a9c3b6a0e90c240f7e0860856c4d2
[4a32366]: https://github.com/nathanvale/bun-typescript-template/commit/4a32366bf79ea95479bda515313b33b849031507
[c77aaa9]: https://github.com/nathanvale/bun-typescript-template/commit/c77aaa9ec56157f4701db117f9aa04e736c6e5df
[#91-cleanup]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744353
[5533cd6]: https://github.com/nathanvale/bun-typescript-template/commit/5533cd63b22f8e5119969968e109af6788289e86
[d592b6d]: https://github.com/nathanvale/bun-typescript-template/commit/d592b6d1eb13754bd46e041313511e7530e9804e
[0ebe7cf]: https://github.com/nathanvale/bun-typescript-template/commit/0ebe7cf570b901653e090cb9062d0b438a5c25d1
[1a29b19]: https://github.com/nathanvale/bun-typescript-template/commit/1a29b19ac6e32452d230dcbf46ccecc4f60223fc
[b077b0b]: https://github.com/nathanvale/bun-typescript-template/commit/b077b0bc152a2ea1f9d8b17b49ba0cf61435111a
[4386b03]: https://github.com/nathanvale/bun-typescript-template/commit/4386b03503e12787b7d20062c9ae1b4f6942fbdf
[2b2907a]: https://github.com/nathanvale/bun-typescript-template/commit/2b2907a6b15e23a3ca8b8111b251ca6c68f467c3
[70c7280]: https://github.com/nathanvale/bun-typescript-template/commit/70c7280c8253b0badc173898fcb5ca44b8e2198b
[07d2d72]: https://github.com/nathanvale/bun-typescript-template/commit/07d2d72ed7c68fda55cd6b065dbb5b4e5f407763
[e50afb6]: https://github.com/nathanvale/bun-typescript-template/commit/e50afb6e27a9facc40ec0b932779ffa81a29784c
[#91-bound]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744346
[7623343]: https://github.com/nathanvale/bun-typescript-template/commit/76233438395b1e967f461ded4a34f6c1d2c8a533
[3729f36]: https://github.com/nathanvale/bun-typescript-template/commit/3729f3644cb30ea5decc9c085bc6b9c4304eaae4
[5f0c1d9]: https://github.com/nathanvale/bun-typescript-template/commit/5f0c1d99741751de14f5cb92618eda3bd92e8887
[24cbab3]: https://github.com/nathanvale/bun-typescript-template/commit/24cbab36274dd093e76f248e7d36f86a2ef12cee
[#84-probe]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244511
[#84-cleanup]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244525
[#90-process]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634935
[#91-timings]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607696012
[#99-timings]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608746456
[#99-shards]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608771631
[#109-bound]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4610027050
[kernel#12-turns]: https://github.com/nathanvale/agent-cli-kernel/pull/12#pullrequestreview-5968899725
[kernel#13-readers]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230342
[9086c3b]: https://github.com/nathanvale/agent-cli-kernel/commit/9086c3b8b14bcba376aa63027abdd817c1495e53
[kernel#18 r4625198722]: https://github.com/nathanvale/agent-cli-kernel/pull/18#discussion_r4625198722
[93dd83e]: https://github.com/nathanvale/agent-cli-kernel/commit/93dd83eec22f119674bddd8bed1f6f2e9c37bf48
[kernel#48 review 5987095580]: https://github.com/nathanvale/agent-cli-kernel/pull/48#pullrequestreview-5987095580
[fdfa794]: https://github.com/nathanvale/agent-cli-kernel/commit/fdfa7946a86df7fac0c9f29b454f3776efc8dcfe
[e766237]: https://github.com/nathanvale/agent-cli-kernel/commit/e76623703cff72cc32c30a97164243e2cc86f255
[4ca0141]: https://github.com/nathanvale/agent-cli-kernel/commit/4ca014175963a134a585af49006a56d374700e33
[ff0616c]: https://github.com/nathanvale/agent-cli-kernel/commit/ff0616cd9c3310bf1170e28308c3c748353fc57b
[308d494]: https://github.com/nathanvale/agent-cli-kernel/commit/308d4943bbc78d9852e116ac334cb30c2b8d7a8b
[0ab74b8]: https://github.com/nathanvale/agent-cli-kernel/commit/0ab74b894857b6b741be277e2f2fd41764e96cd2
