# Test Proof

A test earns its name when it goes **red** for the reason the name gives. The
shared independent-oracle rule applies; this guide lists the ways this
repository broke it.

## Refusals and bounds

- Assert the exact refusal the named guard produces. An assertion that only
  something threw stays green when another guard refuses. Witnessed:
  [185c90d], [5990897], [fa359ec] (the repository description parser had
  five refusals and no test).
- Shape the input so only the named guard can refuse it. An earlier parse or
  build check, or a neighbouring cap at the same limit, keeps the test green
  with the named guard removed. Witnessed: [640ba05], [96ab832], [c193c51].
- Control each side of a boundary: the last admitted and the first refused
  value or case. Checks further out stay green under an off-by-one limit.
  Witnessed: [e07d962], [d72cd9e].
- Pin a bound with a tolerance tighter than the fault it must catch. A
  first-signal kill at 550 ms passed a 500 ms bound plus its tolerance.
  Witnessed: [b8760b4], [8485278], [aa161e5] (a lower bound only, so a late
  kill still passed).

## Production entry

- Build a process proof's subject through `index.ts`, the production seam
  the shared test-execution rule asks for. A test entry such as `fixture.ts`,
  or a fault-wrapped CLI, proves only the fixture. Witnessed: [e55f94a],
  [7ea1ee3].

## In-process tests

- Call and assert each function a script or the CLI runs, unexported ones
  too, from the test that imports its file, beside the process proof that
  spawns the entry. Coverage cannot see into a spawned process, so a
  function proved only that way reads as untested and its mutants never
  run.

## Planted faults

- Apply the shared RED-then-GREEN rule to every new refusal or bound.
- Record each planted fault in `tests/planted-faults/fault-records.json`.
  After the fix commit, run
  `bun run planted-fault:add <fix sha> <source path> <test file> <title>`,
  then `bun run fault-replay <id>` until it prints `KILLED`. Witnessed:
  [9050fec], [b8664cf] (each recorded faults for refusals that had landed
  with no record).
- Treat a surviving fault as a missing test. Witnessed: [d72cd9e], [640ba05].

## Processes

- Bound every child below its test timeout. Witnessed: [e990da6], [4a32366].
- Template tests: reuse `spawnBounded` (`tests/support/process.ts`), which
  runs the child through `startChild` (`scripts/process-runner.ts`), for that
  bound. Kernel tests: reuse `spawnBounded`
  (`tests/kernel/kernel-repair/swarm-process.ts`) or `exitWithin`
  (`tests/kernel/lifecycle/harness.ts`).
- Release in `finally`: the CLI, then each ledgered child, then the temporary
  folder. Witnessed: [d592b6d], [70c7280] (released in `afterAll`, so a
  failing case left its process group alive).
- At teardown, send SIGKILL, and only to a pid still in its ledgered process
  group. Witnessed: [0ebe7cf], [1a29b19].

## Time

- Wait on an event the subject produces (a ready file, ledger line, or
  barrier), or drive the fake clock in
  `tests/kernel/lifecycle/recording-host.ts`. Witnessed: [b077b0b],
  [4386b03].
- Widen a race control until it catches its fault on every run. Witnessed:
  [2b2907a] (caught in 48 of 50 runs before widening).

[185c90d]: https://github.com/nathanvale/bun-typescript-template/commit/185c90d11dd167ee4874e383ba26cd7d64a70964
[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[96ab832]: https://github.com/nathanvale/bun-typescript-template/commit/96ab832e7e7aa6fb992a0762fba6f833c172f800
[5990897]: https://github.com/nathanvale/bun-typescript-template/commit/5990897fadd6e452119666769b96d72452a197ab
[c193c51]: https://github.com/nathanvale/bun-typescript-template/commit/c193c5148054184659d921150f714603a72d48d0
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[b8760b4]: https://github.com/nathanvale/bun-typescript-template/commit/b8760b478768ab711252b16f9a4a2c97a0dd6d44
[e07d962]: https://github.com/nathanvale/bun-typescript-template/commit/e07d962f016dc07ca442724621fd0406084521cc
[8485278]: https://github.com/nathanvale/bun-typescript-template/commit/8485278bf38a457d7d1823ba98daa153a9bb35a8
[e55f94a]: https://github.com/nathanvale/bun-typescript-template/commit/e55f94a5b7dcb78f9b25f5d0a723a2196bd8c452
[7ea1ee3]: https://github.com/nathanvale/bun-typescript-template/commit/7ea1ee3853cb6251fcf93c6a6ecf683e065fbfef
[e990da6]: https://github.com/nathanvale/bun-typescript-template/commit/e990da67151a9c3b6a0e90c240f7e0860856c4d2
[4a32366]: https://github.com/nathanvale/bun-typescript-template/commit/4a32366bf79ea95479bda515313b33b849031507
[d592b6d]: https://github.com/nathanvale/bun-typescript-template/commit/d592b6d1eb13754bd46e041313511e7530e9804e
[0ebe7cf]: https://github.com/nathanvale/bun-typescript-template/commit/0ebe7cf570b901653e090cb9062d0b438a5c25d1
[1a29b19]: https://github.com/nathanvale/bun-typescript-template/commit/1a29b19ac6e32452d230dcbf46ccecc4f60223fc
[b077b0b]: https://github.com/nathanvale/bun-typescript-template/commit/b077b0bc152a2ea1f9d8b17b49ba0cf61435111a
[4386b03]: https://github.com/nathanvale/bun-typescript-template/commit/4386b03503e12787b7d20062c9ae1b4f6942fbdf
[2b2907a]: https://github.com/nathanvale/bun-typescript-template/commit/2b2907a6b15e23a3ca8b8111b251ca6c68f467c3
[fa359ec]: https://github.com/nathanvale/bun-typescript-template/commit/fa359ece5ae03bc913393e4d80b78836c39b7ef9
[aa161e5]: https://github.com/nathanvale/bun-typescript-template/commit/aa161e5b402b55037192f9ccbcd74896e9a62d11
[9050fec]: https://github.com/nathanvale/bun-typescript-template/commit/9050fec545a21a1995b0014151b4d486c2188e06
[b8664cf]: https://github.com/nathanvale/bun-typescript-template/commit/b8664cfdcb826e3870b52b0141c0f4f2efb2eba0
[70c7280]: https://github.com/nathanvale/bun-typescript-template/commit/70c7280c8253b0badc173898fcb5ca44b8e2198b
