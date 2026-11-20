# Test Proof

A test earns its name when it goes **red** for the reason the name gives. The
shared independent-oracle rule applies; this guide lists the ways this
repository broke it.

How tests start processes, fake tools, wait on time and keep their timings
is in the [test harness guide](test-harness.md).

## Refusals and bounds

- Assert the exact refusal the named guard produces. An assertion that only
  something threw stays green when another guard refuses. Witnessed: [#91-count],
  [185c90d], [5990897], [fa359ec] (the repository description parser had
  five refusals and no test), [97f9e9b] (a length check accepted any reason
  for a parse failure; take the reason from an independent call of the
  parser), [#90-inventory] (exit 1 also covered unrelated inventory errors),
  [r4624964198], [198f6ba] (a test that read the boot identity file itself
  still expected `ENOENT`, so another read failure failed it and a refusal
  that also named the filesystem passed; the fix expects the reason the test
  observed, and the boot identity as the only field that differs),
  [f8ff37f] (the author guide's brace case matched its error by substring
  with `toThrow`, and searched its own expected string for a station name),
  [kernel#53 r4639172891], [79431f5] (the cause owner refusal cases checked
  a prefix and one fragment, so a refusal without its repair or naming
  another entry passed),
  [8cbec55] (the record folder's refusal tests checked a prefix of the
  not-JSON message and left out repairs; the fix takes the parser's words
  from `JSON.parse`; Sol 6.1 review).
- Name only behaviour a caller can observe. Witnessed: [911189b] (a test
  asserted `readTimings`' map order, which nothing reads; Fable review).
- Assert the route's response when a test says a command remains available.
  Exit zero with empty output can pass without a response. Witnessed:
  [#90-routes].
- Shape the input so only the named guard can refuse it. An earlier parse or
  build check, or a neighbouring cap at the same limit, keeps the test green
  with the named guard removed. Witnessed: [640ba05], [96ab832], [c193c51],
  [f8ff37f] (an equals-sign option case used a required option, so a
  missing-option refusal could also have failed it), [0ab74b8] (a
  lying fixture's wrong stderr hid a dropped exit-code check),
  [8cbec55] (a file that was not `<id>.json` also held bad JSON; the fix
  gives it a valid record; Sol 6.1 review).
- Control each side of a boundary: the last admitted and the first refused
  value or case. Checks further out stay green under an off-by-one limit.
  Witnessed: [e07d962], [d72cd9e], [3567a81] (the author guide's example
  document case refused a document with no section, and not one that
  showed one file of two or repeated one).
- Pin a bound with a tolerance tighter than the fault it must catch. A
  first-signal kill at 550 ms passed a 500 ms bound plus its tolerance.
  Witnessed: [b8760b4], [8485278], [aa161e5] (a lower bound only, so a late
  kill still passed), [dbd196e] (a timeout message that reads the same
  constant stays green when the timer is changed, so measure the elapsed
  time), [#73-deadline] (a 2 s assertion accepted a missed 300 ms
  deadline), [0ab74b8] (the verification skill's stop case checked only
  that the target timed out, so a 600 s timeout passed).
- Require a project's evidence list to exist and contain at least one entry.
  A check against an empty array can accept a missing field. Witnessed:
  [#91-projects].
- Prove a resolution by a refusal only the right folder can give. A recorded
  hit or an empty result passes for a skipped check too, and a process
  folder with the same tail as the injected one passes for the wrong
  folder. Give the test distinct fallback and destination folders, and
  assert the destination in the refusal. Witnessed: [9ad6bf2], [#72-cwd],
  [4ca0141] (the installed cause case expected no finding in
  `src/app/typed.ts` and passed if ESLint skipped that file; it now
  asserts both files were linted).
- Assert all of what the title names. A prefix of the output passes with the
  rest missing, and a path that exists passes for a folder where the title
  says file. Witnessed: [ff0616c] (the author guide's plain-text case
  checked only the first line), [0463f35] (its link case accepted a link to
  a folder), [3567a81] (its case titled "its own tests pass, in process and
  through its real entry file" counted results, and a pin for a sentence
  naming two usage refusals checked one), [0ab74b8] (three verification
  skill cases checked a prefix, the arguments sent, or a stop request alone).
- Prove that a fixture meant to lack something lacks it, and fail loudly
  when its location supplies it. `STATE_TEST_DIR` can place a test folder
  inside the checkout, where git finds the parent repository for a case that
  expects none. Witnessed: [8946615], [0ab74b8] (the verification skill's
  case for a kernel that does not load never checked that its copy could
  not resolve the kernel).
- Require one recorded process before checking that it exited. A missing
  process ledger lets an empty-result check pass. Witnessed: [#84-ledger].
- Refuse a gate's scan that finds no file, so the gate cannot pass on
  nothing. Witnessed: [kernel#48 r4637879795], [7a3c409] (the add-on import
  scan returned no imports for an empty `kernel/src/kernel`, and the gate
  passed).
- Prove that a killed run made no outside write by checking each write's own
  target. A ledger line written after those writes cannot show they did not
  happen: a proof that reads only that line stays green when a fault makes the
  writes happen before the kill. Witnessed: [r4622139095], [f754f36] (the fix
  asserts that no outbox message and no provider log exist), [8cbec55]
  ("writes nothing" cases for planted-fault:add compared only the record
  file names, so an overwritten record passed; Sol 6.1 review).
- Show that a planted input changes the result when nothing blocks it, with
  a control, before asserting the subject ignores it. A `HOME` change under
  `GIT_CONFIG_GLOBAL=/dev/null` hides the planted `.gitconfig` whether or not
  the isolation works. Witnessed: [315de28].

## Production entry

- Build a process proof's subject through `index.ts`, the production seam
  the shared test-execution rule asks for. A test entry such as `fixture.ts`,
  or a fault-wrapped CLI, proves only the fixture. Witnessed: [e55f94a],
  [7ea1ee3], [r4624230382], [9086c3b] (the upgrade, move and history
  process proofs ran only through `fixture.ts`; the fix adds one through
  `SX_ENTRY` production).
- Start the entry from the folder a caller starts it in. `bun run <script>`
  moves the child to the package root, so a proof through a package script
  never exercises the entry's own process folder. Witnessed: [c5a554e].
- Prove a consumer lint through the call the template writes, not only a
  stronger one. Witnessed: [b146440] (the installed-kernel lint cases
  selected every add-on with no plugin, while the template passes
  `addons: []` and a plugin).

## In-process tests

- Call and assert each function a script or the CLI runs, unexported ones
  too, from the test that imports its file, beside the process proof that
  spawns the entry. Coverage cannot see into a spawned process, so a
  function proved only that way reads as untested and its mutants never
  run. Witnessed: [0ab74b8] (three verification skill functions ran
  only in spawned helpers).
- Resolve each path from the environment a function is given, not from the
  process's own folder, so an in-process call runs on what the test injects.
  Witnessed: [244b63a].

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
- Treat a surviving fault as a missing test. Witnessed: [d72cd9e], [640ba05].

[#91-count]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744321
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
[fa359ec]: https://github.com/nathanvale/bun-typescript-template/commit/fa359ece5ae03bc913393e4d80b78836c39b7ef9
[aa161e5]: https://github.com/nathanvale/bun-typescript-template/commit/aa161e5b402b55037192f9ccbcd74896e9a62d11
[9050fec]: https://github.com/nathanvale/bun-typescript-template/commit/9050fec545a21a1995b0014151b4d486c2188e06
[b8664cf]: https://github.com/nathanvale/bun-typescript-template/commit/b8664cfdcb826e3870b52b0141c0f4f2efb2eba0
[244b63a]: https://github.com/nathanvale/bun-typescript-template/commit/244b63a814ddbb60b4831cabc0e2f8cd1b73bca4
[c5a554e]: https://github.com/nathanvale/bun-typescript-template/commit/c5a554e0034342f6918775909fcd3b15e27facca
[8946615]: https://github.com/nathanvale/bun-typescript-template/commit/894661580864b423b07cd4571bdd0c9da69c1911
[315de28]: https://github.com/nathanvale/bun-typescript-template/commit/315de28d3e1da69a4e8d65923654846405a3d1c8
[dbd196e]: https://github.com/nathanvale/bun-typescript-template/commit/dbd196e8dd2dc19163d201cfb4f089952f1c471f
[#91-projects]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744327
[9ad6bf2]: https://github.com/nathanvale/bun-typescript-template/commit/9ad6bf2528f0c65fc5106e8377c469b2e48b1743
[97f9e9b]: https://github.com/nathanvale/bun-typescript-template/commit/97f9e9b82277a054b8b64ac03194a31be27e5ded
[#72-cwd]: https://github.com/nathanvale/bun-typescript-template/pull/72#discussion_r4606134426
[#73-deadline]: https://github.com/nathanvale/bun-typescript-template/pull/73#discussion_r4606053862
[#54-stale]: https://github.com/nathanvale/bun-typescript-template/pull/54#discussion_r4603739936
[#77-test]: https://github.com/nathanvale/bun-typescript-template/pull/77#discussion_r4606037347
[#84-ledger]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244520
[#90-inventory]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634930
[#90-routes]: https://github.com/nathanvale/bun-typescript-template/pull/90#pullrequestreview-5948919460
[r4622139095]: https://github.com/nathanvale/agent-cli-kernel/pull/2#discussion_r4622139095
[f754f36]: https://github.com/nathanvale/agent-cli-kernel/commit/f754f3629123ca9632fba83361a4776109459e97
[r4624230382]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230382
[9086c3b]: https://github.com/nathanvale/agent-cli-kernel/commit/9086c3b8b14bcba376aa63027abdd817c1495e53
[r4624964198]: https://github.com/nathanvale/agent-cli-kernel/pull/15#discussion_r4624964198
[198f6ba]: https://github.com/nathanvale/agent-cli-kernel/commit/198f6ba61a79539d2c03a1fbfb70b61ecc26b3d0
[kernel#48 r4637879795]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879795
[7a3c409]: https://github.com/nathanvale/agent-cli-kernel/commit/7a3c409920548ef30a9df2c89a0fac608d4704fd
[b146440]: https://github.com/nathanvale/agent-cli-kernel/commit/b146440b8fd1075791ee997ca93c59f410b9e978
[4ca0141]: https://github.com/nathanvale/agent-cli-kernel/commit/4ca014175963a134a585af49006a56d374700e33
[f8ff37f]: https://github.com/nathanvale/agent-cli-kernel/commit/f8ff37f4e31d26ce34fcc4e5b0467a2a5ed013f3
[ff0616c]: https://github.com/nathanvale/agent-cli-kernel/commit/ff0616cd9c3310bf1170e28308c3c748353fc57b
[0463f35]: https://github.com/nathanvale/agent-cli-kernel/commit/0463f35b14fd6aadced45cab40b44436fb480b33
[86749b9]: https://github.com/nathanvale/agent-cli-kernel/commit/86749b9a2dd7b2295a2405513d75299b14550db3
[3567a81]: https://github.com/nathanvale/agent-cli-kernel/commit/3567a8125e36f43eb6b3f448a5f51fb122090536
[848b6de]: https://github.com/nathanvale/agent-cli-kernel/commit/848b6de1e7b9bc0792a8ea70f6604f700a09229d
[0ab74b8]: https://github.com/nathanvale/agent-cli-kernel/commit/0ab74b894857b6b741be277e2f2fd41764e96cd2
[25c2212]: https://github.com/nathanvale/agent-cli-kernel/commit/25c2212794174aa8686028c0cb35a87515c9ca65
[kernel#53 r4639172891]: https://github.com/nathanvale/agent-cli-kernel/pull/53#discussion_r4639172891
[79431f5]: https://github.com/nathanvale/agent-cli-kernel/commit/79431f561abf1deecd55c9b1dcb91e8c1560f746
[c5ce7de]: https://github.com/nathanvale/agent-cli-kernel/commit/c5ce7de4210286905ff472706c107b35e0ef42cb
[8cbec55]: https://github.com/nathanvale/agent-cli-kernel/commit/8cbec55e65afbbba5650d447e00cac40ce0e01c3
[911189b]: https://github.com/nathanvale/agent-cli-kernel/commit/911189bb75fa97d60acaacfba6034417522804aa
