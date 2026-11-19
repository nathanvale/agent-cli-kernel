# Single Witness

A lesson seen once waits here as one bullet: the lesson as an imperative,
then `Witnessed:` and its citation. When a second witness arrives, it moves
to a row in the [rule table](../../CODING_STANDARDS.md#rule-table) and leaves
this file.

- Make a guard against an empty gate count what the gate would run.
  Witnessed: [ac11ed9] (a test area whose tests sit only in subfolders was
  counted as empty).
- Build a test's environment without any variable the test then asserts on,
  so a value set in the parent process cannot change the result. Witnessed:
  [cd2498b] (an inherited `MARKER` changed the first output of `execute`).
- Make a lint rule that reads a template literal fall back to its raw text,
  so a head with an invalid escape is still checked. Witnessed: [fc4fa62]
  (`String.raw` with `\u` left the cooked value undefined, and
  `no-host-path-literal` checked an empty string).
- Give each binding a lint repair introduces a name that no binding or
  reference in the reported scope uses, so the repair compiles where it is
  pasted. Witnessed: [r4606943319] (`key in read()` beside a `key`
  parameter gave `const key = key;`).
- Build a lint repair from the source it replaces, so the code it leaves
  unchanged still finds every name it reads. Witnessed: [r4607149514] (the
  `for...in` repair named `const key`, and the loop body read `field`).
- Split the union that a type parameter's constraint resolves to, so a lint
  judges a generic target as it judges the plain union. Witnessed:
  [r4607149524] (`"a" in value` with `T extends { a: number } | { b: string }`
  was refused, and the same check on the union passed).
- Assert any step a near-zero limit can catch, not the first one, since which
  step loses that race depends on the host. Witnessed: [27c2676] (a 1 ms
  replay limit named `git apply` instead of `git worktree add` on a hosted
  runner).
- Freeze a child that outran its bound before inspecting it, and stop it
  whatever the inspection does. Witnessed: [3f6443b] (a synchronous `ps` let a
  hung child run 10 s past its bound, and a `ps` that could not start skipped
  the kill).
- Build an expected command from the path the code runs, not a no-space
  pattern. Witnessed: [bfc3a67] (`\S+` would have refused a Bun installed
  under a path with a space).
- Refuse every spelling of a path but the plain one where it is read, so
  each consumer of the value matches the same files. Witnessed:
  [r4608771621] (a test area folder written as `./tests`, `tests/` or with
  `..` ran in the area runner, and the test placement check matched no file
  under it).
- Trigger a compiler check when its configuration changes. Witnessed:
  [r4608935157] (a staged `tsconfig.base.json` could change compilation
  while the hook only looked for staged source edits).
- Read a required input file as present or refused, never as empty, so a
  missing file cannot pass for one with nothing in it. Witnessed:
  [r4609956011] (a missing patch file read as an empty patch, so replay
  reported that it held no hunk and `--changed-since` skipped its fault).
- Locate a change by the text it changes, not by unchanged text beside it,
  so an edit to that other text cannot lose the change. Witnessed:
  [r4609956051] (a hunk with two changed regions was anchored on the
  unchanged lines between them, so editing those lines made its fault
  STALE).
- Read staged Git blobs in one batch by object ID. Witnessed:
  [r4609890969] (the file-size gate started a Git process for each staged
  file).
- Put the state a run shares with an asynchronous callback in place before
  the call that can trigger that callback, since an async function runs
  synchronously up to its first `await`. Witnessed: [r4623815208]
  (`run.execution` was set only after `attached.enter()` returned, so a stop
  request delivered during handler entry waited for the add-ons alone and
  cut off the handler's clean-up).
- When a wait joins several parts, give each part a case where it finishes
  last, or a fault that drops that part survives. Witnessed: [7c5967e]
  (CodeRabbit's [review of pull request 9][#9-add-on]: a handler that never
  ended outlasted the add-on's 300 ms settle, so the stop request case
  passed with the add-on dropped from the wait).
- Keep a stopped run where the repeated-signal kill reaches it until the
  process exits, not only until its handler returns. Witnessed:
  [kernel#6 r4622839115] (a run that returned during its first-stop settle
  missed `killNow` at the second signal).
- Drive every route a capability offers to the same shared function, so a
  route that wraps it, such as one that admits before it starts, is proved
  too. Witnessed: [r4622712214] (the domain program route had no proof).
- Pin only what a production host can observe; a recording host whose `exit`
  returns shows state that `runProcess` ends with its process. Witnessed:
  [ef76011] (a case pinned `runProcess` keeping a finished run's identity,
  the opposite of the accepted decision's wording).
- Give a new folder in the state root the checks its sibling folders get.
  Witnessed: [kernel#13 r4624230267], [9086c3b] (`ensureStore` did not
  check `settled/` on a version 2 store, so a symbolic link there was
  followed and a move renamed case folders out of the state root).
- Report a record that exists but cannot be read as the store's problem on
  every read of it, never as not found. Witnessed: [kernel#13 r4624230310],
  [ff852e8] (a closer whose moved target was unreadable or corrupt would
  have reported a missing case; the fix shares `readProblem` with the first
  read).
- Prove a compatibility claim with code committed in the tree, never with
  git history, which a shallow checkout or another folder lacks. Witnessed:
  [ff852e8], [e45050c] (J08.a and J08.c read version 1's store with
  `git show` at a fixed commit, and hosted fault replay, [run 44456881408],
  could not resolve the path; the fix adds a committed version 1 reader to
  `tests/kernel/state/harness.ts`).
- Before resting a safety claim on how a file format reads damage, sweep
  every cut point of each record, alone and with a complete record after
  it. Witnessed: [6d4b46d] (the journal version 2 design said a torn tail
  cannot hide a delegate start, yet a complete record appended straight
  after torn bytes read as part of the torn tail at every cut but the three
  just after a header's newline).
- Decide only on state read while holding what excludes its writer; a
  read taken before the lock is a stale snapshot. Witnessed:
  [kernel#18 r4625198714], [d37a77f] (a closer read the case journal,
  then took the owner's lease, so an owner with an unknown scope could
  append a delegate start in between and the closure was decided on the
  stale bytes).
- Compare a request's revision with the record before any other check of
  that record, so a record changed since the caller read it refuses as
  stale, not as the later state. Witnessed: [kernel#18 r4625574054],
  [4f7712e] (a case completed after the caller's read refused as a
  conflict, "already has a different closure").
- Make a reader that collects delimited blocks refuse a block still open at
  the end of its input, so the lines in it cannot escape the checks that
  read the blocks. Witnessed: [kernel#21 r4634973490], [0800d56] (the author
  guide's fence parser dropped an unclosed code block, so a stale or untyped
  example passed the language and freshness checks).
- Make a check that a set of lines appears somewhere refuse an empty or
  blank set, since a check over no lines passes for every file. Witnessed:
  [kernel#21 review 5984293964], [fd6d26b] (an empty `ts` block in the author
  guide matched the first example file, so it passed the freshness check).
- Make a reader of a format recognise every delimiter form that format
  allows, so a block written in another form cannot escape the checks.
  Witnessed: [kernel#21 r4635908632], [f49bca3] (the author guide's fence
  parser knew only three backticks, so a `~~~ts` block's code skipped the
  language and freshness checks).

[ac11ed9]: https://github.com/nathanvale/bun-typescript-template/commit/ac11ed98b7d538e8a304cac053aaefcaaf6b2cb3
[cd2498b]: https://github.com/nathanvale/bun-typescript-template/commit/cd2498b7189a2d45d1906b9c870e8d13da6cd2dd
[fc4fa62]: https://github.com/nathanvale/bun-typescript-template/commit/fc4fa628535ecc6729048cb6fbb759f153edd040
[r4606943319]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943319
[r4607149514]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149514
[r4607149524]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149524
[27c2676]: https://github.com/nathanvale/bun-typescript-template/commit/27c26764ecac5849752fb39df5384539e60e1456
[3f6443b]: https://github.com/nathanvale/bun-typescript-template/commit/3f6443be7abaf2e0881d48a03e0d3b4072b6247f
[bfc3a67]: https://github.com/nathanvale/bun-typescript-template/commit/bfc3a67b8aea06d0c630c2b9ef1ecd9f32a3266b
[r4608771621]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608771621
[r4608935157]: https://github.com/nathanvale/bun-typescript-template/pull/101#discussion_r4608935157
[r4609956011]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956011
[r4609956051]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956051
[r4609890969]: https://github.com/nathanvale/bun-typescript-template/pull/108#discussion_r4609890969
[r4623815208]: https://github.com/nathanvale/agent-cli-kernel/pull/9#discussion_r4623815208
[7c5967e]: https://github.com/nathanvale/agent-cli-kernel/commit/7c5967e25761e72cbf1d3fb77bc166aa5aef80ae
[#9-add-on]: https://github.com/nathanvale/agent-cli-kernel/pull/9#pullrequestreview-5968740024
[kernel#6 r4622839115]: https://github.com/nathanvale/agent-cli-kernel/pull/6#discussion_r4622839115
[r4622712214]: https://github.com/nathanvale/agent-cli-kernel/pull/4#discussion_r4622712214
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
[kernel#13 r4624230267]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230267
[9086c3b]: https://github.com/nathanvale/agent-cli-kernel/commit/9086c3b8b14bcba376aa63027abdd817c1495e53
[kernel#13 r4624230310]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230310
[ff852e8]: https://github.com/nathanvale/agent-cli-kernel/commit/ff852e8f0daed7dc23fc8b092043ab2ddff68c8d
[e45050c]: https://github.com/nathanvale/agent-cli-kernel/commit/e45050c2bbcafa88b973931119a4512e45d9bfc7
[run 44456881408]: https://github.com/nathanvale/agent-cli-kernel/actions/runs/44456881408
[6d4b46d]: https://github.com/nathanvale/agent-cli-kernel/commit/6d4b46de2bb670943cadc1e8003e8f1ff74fb38d
[kernel#18 r4625198714]: https://github.com/nathanvale/agent-cli-kernel/pull/18#discussion_r4625198714
[d37a77f]: https://github.com/nathanvale/agent-cli-kernel/commit/d37a77ffc6f8f62c9c89fca2b35e8b16446ef694
[kernel#18 r4625574054]: https://github.com/nathanvale/agent-cli-kernel/pull/18#discussion_r4625574054
[4f7712e]: https://github.com/nathanvale/agent-cli-kernel/commit/4f7712e80e9ea127b4bf43b7d9f69e8cd6a8954a
[kernel#21 r4634973490]: https://github.com/nathanvale/agent-cli-kernel/pull/21#discussion_r4634973490
[0800d56]: https://github.com/nathanvale/agent-cli-kernel/commit/0800d56170e923cf87a7913092ad5c45430fdee7
[kernel#21 review 5984293964]: https://github.com/nathanvale/agent-cli-kernel/pull/21#pullrequestreview-5984293964
[fd6d26b]: https://github.com/nathanvale/agent-cli-kernel/commit/fd6d26b6cda0782605199a7f3ee5ea4ab2c52482
[kernel#21 r4635908632]: https://github.com/nathanvale/agent-cli-kernel/pull/21#discussion_r4635908632
[f49bca3]: https://github.com/nathanvale/agent-cli-kernel/commit/f49bca3dc3963ebb6fc4f5ff730e88cf08bd2c99
