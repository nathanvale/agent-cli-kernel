# Single Witness: State and processes

Run state, state on disk, locks, file creation and child processes. A lesson seen once waits here as one bullet; the
[single witness guide](single-witness.md) says how it leaves.

- Keep the state a step leaves beside what it printed. Witnessed: [18894b0].
- Freeze a child that outran its bound before inspecting it, and stop it
  whatever the inspection does. Witnessed: [3f6443b] (a synchronous `ps` let a
  hung child run 10 s past its bound, and a `ps` that could not start skipped
  the kill).
- Put the state a run shares with an asynchronous callback in place before
  the call that can trigger that callback, since an async function runs
  synchronously up to its first `await`. Witnessed: [r4623815208]
  (`run.execution` was set only after `attached.enter()` returned, so a stop
  request delivered during handler entry waited for the add-ons alone and
  cut off the handler's clean-up).
- Keep a stopped run where the repeated-signal kill reaches it until the
  process exits, not only until its handler returns. Witnessed:
  [kernel#6 r4622839115] (a run that returned during its first-stop settle
  missed `killNow` at the second signal).
- Give a new folder in the state root the checks its sibling folders get.
  Witnessed: [kernel#13 r4624230267], [9086c3b] (`ensureStore` did not
  check `settled/` on a version 2 store, so a symbolic link there was
  followed and a move renamed case folders out of the state root).
- Before resting a safety claim on how a file format reads damage, sweep
  every cut point of each record, alone and with a complete record after
  it. Witnessed: [6d4b46d] (a complete record appended after torn bytes read as part of the
  torn tail at almost every cut).
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
- Create a file the tool owns with exclusive create, not a check and then
  a write, so two writers of the same name cannot both succeed.
  Witnessed: [911189b] (two `planted-fault:add` runs for one id both
  printed `Added`, and on macOS an id differing only by case overwrote
  another record; Fable review of pull request 54).

[3f6443b]: https://github.com/nathanvale/bun-typescript-template/commit/3f6443be7abaf2e0881d48a03e0d3b4072b6247f
[r4623815208]: https://github.com/nathanvale/agent-cli-kernel/pull/9#discussion_r4623815208
[kernel#6 r4622839115]: https://github.com/nathanvale/agent-cli-kernel/pull/6#discussion_r4622839115
[kernel#13 r4624230267]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230267
[9086c3b]: https://github.com/nathanvale/agent-cli-kernel/commit/9086c3b8b14bcba376aa63027abdd817c1495e53
[6d4b46d]: https://github.com/nathanvale/agent-cli-kernel/commit/6d4b46de2bb670943cadc1e8003e8f1ff74fb38d
[kernel#18 r4625198714]: https://github.com/nathanvale/agent-cli-kernel/pull/18#discussion_r4625198714
[d37a77f]: https://github.com/nathanvale/agent-cli-kernel/commit/d37a77ffc6f8f62c9c89fca2b35e8b16446ef694
[kernel#18 r4625574054]: https://github.com/nathanvale/agent-cli-kernel/pull/18#discussion_r4625574054
[4f7712e]: https://github.com/nathanvale/agent-cli-kernel/commit/4f7712e80e9ea127b4bf43b7d9f69e8cd6a8954a
[18894b0]: https://github.com/nathanvale/agent-cli-kernel/commit/18894b0852b26411e5583a7008f2feb54e459f3e
[911189b]: https://github.com/nathanvale/agent-cli-kernel/commit/911189bb75fa97d60acaacfba6034417522804aa
