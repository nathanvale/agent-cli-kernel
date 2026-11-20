# Single Witness: Tests

How a test is built, what it asserts and what it proves. A lesson seen once waits here as one bullet; the
[single witness guide](single-witness.md) says how it leaves.

- Prove a child ran by an output only a run produces, never by its exit code
  alone. Witnessed: [67e7adc].
- Build a test's environment without any variable the test then asserts on,
  so a value set in the parent process cannot change the result. Witnessed:
  [cd2498b] (an inherited `MARKER` changed the first output of `execute`).
- Assert any step a near-zero limit can catch, not the first one, since which
  step loses that race depends on the host. Witnessed: [27c2676] (a 1 ms
  replay limit named `git apply` instead of `git worktree add` on a hosted
  runner).
- Build an expected command from the path the code runs, not a no-space
  pattern. Witnessed: [bfc3a67] (`\S+` would have refused a Bun installed
  under a path with a space).
- When a wait joins several parts, give each part a case where it finishes
  last, or a fault that drops that part survives. Witnessed: [7c5967e]
  (CodeRabbit's [review of pull request 9][#9-add-on]: a handler that never
  ended outlasted the add-on's 300 ms settle, so the stop request case
  passed with the add-on dropped from the wait).
- Drive every route a capability offers to the same shared function, so a
  route that wraps it, such as one that admits before it starts, is proved
  too. Witnessed: [r4622712214] (the domain program route had no proof).
- Pin only what a production host can observe; a recording host whose `exit`
  returns shows state that `runProcess` ends with its process. Witnessed:
  [ef76011] (a case pinned `runProcess` keeping a finished run's identity,
  the opposite of the accepted decision's wording).
- Prove a compatibility claim with code committed in the tree, never with
  git history, which a shallow checkout or another folder lacks. Witnessed:
  [ff852e8], [e45050c] (J08.a and J08.c read version 1's store with
  `git show`, which hosted fault replay, [run 44456881408], could not
  resolve).
- Check the type of each field a test reads from a tool's JSON output instead
  of coercing it, so an unexpected value cannot pass for an expected one.
  Witnessed: [4ca0141] (`String(message.ruleId)` would have read any rule id
  value as text, and a result with no messages skipped its path check).
- Expect an order in a result only when the test fixes every input that
  sets it; an id built from a fixture commit's SHA sorts differently from
  run to run. Witnessed: [8cbec55] (a `faultsTouchedSince` case expected
  `[id, other.id]`, and once fault records came back in id order, a SHA
  that sorted after the other record's id reversed it; Sol 6.1 review).
- Observe both sides again before blaming the judge for a mismatch.
  Witnessed: [0aeb3de].

[cd2498b]: https://github.com/nathanvale/bun-typescript-template/commit/cd2498b7189a2d45d1906b9c870e8d13da6cd2dd
[27c2676]: https://github.com/nathanvale/bun-typescript-template/commit/27c26764ecac5849752fb39df5384539e60e1456
[bfc3a67]: https://github.com/nathanvale/bun-typescript-template/commit/bfc3a67b8aea06d0c630c2b9ef1ecd9f32a3266b
[7c5967e]: https://github.com/nathanvale/agent-cli-kernel/commit/7c5967e25761e72cbf1d3fb77bc166aa5aef80ae
[#9-add-on]: https://github.com/nathanvale/agent-cli-kernel/pull/9#pullrequestreview-5968740024
[r4622712214]: https://github.com/nathanvale/agent-cli-kernel/pull/4#discussion_r4622712214
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
[ff852e8]: https://github.com/nathanvale/agent-cli-kernel/commit/ff852e8f0daed7dc23fc8b092043ab2ddff68c8d
[e45050c]: https://github.com/nathanvale/agent-cli-kernel/commit/e45050c2bbcafa88b973931119a4512e45d9bfc7
[run 44456881408]: https://github.com/nathanvale/agent-cli-kernel/actions/runs/44456881408
[4ca0141]: https://github.com/nathanvale/agent-cli-kernel/commit/4ca014175963a134a585af49006a56d374700e33
[67e7adc]: https://github.com/nathanvale/agent-cli-kernel/commit/67e7adcdeda288d3199748178ef0723c212668c3
[8cbec55]: https://github.com/nathanvale/agent-cli-kernel/commit/8cbec55e65afbbba5650d447e00cac40ce0e01c3
[0aeb3de]: https://github.com/nathanvale/agent-cli-kernel/commit/0aeb3de88a7ea51e3882ff3ac30f9c0dde64614b
