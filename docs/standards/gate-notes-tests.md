# Test Gate Notes

What the gates of the test rows refuse and where, what stays with the reviewer, and which witnesses taught each note. The [rule table](../../CODING_STANDARDS.md#rule-table) links each note.

## Test proof

- The lint checks for a message argument. Review which guard
  refused the input. See [the gate's coverage](gate-coverage.md#refusal-lint).
- Witnessed: [185c90d].

## In-process tests

- The coverage-gaps test checks which runtime files and exports
  tests reach by import. Review what the tests assert. See [the gate's coverage](gate-coverage.md#import-coverage).
- Witnessed: [9f3c666], [fa8b6f5].

## Planted faults

- `bun run fault-replay` replays each record in
  `tests/planted-faults/fault-records/` in a temporary worktree.
- A pull request's `fault-replay-shard` jobs replay each record whose test
  is outside `tests/template/`, and each other record its change touches;
  `fault-replay` passes when all of them do. The Linux nightly
  replays every record. Pre-push replays those its push
  touches (`--changed-since <base>`).
- Fault replay fails on a fault record whose named test passes with the
  planted fault applied or fails without it, or whose patch file is
  missing. A patch also fails replay when it creates or deletes a whole
  file, or when a changed region's anchor is in no file replay searches, or
  is at more than one place and its context lines do not choose one.
- Replay places each changed region of a hunk by its anchor: the lines it
  removes, or, for a region that only inserts, the context lines next to
  it. A region lands wherever its anchor occurs once, even if its other
  context moved. Only a region that removes lines is searched for in
  other tracked files when its recorded file lacks the anchor; a region
  that only inserts stays in its recorded file. Context chooses between
  places only when one matches at least as far as every other on both
  sides, and further on one.
- Whether the chosen place is the one the fault meant stays review: a
  fault in the wrong place still fails its test.
- A new refusal or bound with no fault record stays review. So does a fault
  record whose test title matches more tests than the planted fault reaches.
- Witnessed: [d72cd9e], [640ba05].

## Fake tools

- The lint catches `symlink`, `symlinkSync`, `link`, `linkSync`, `copyFile`,
  and `copyFileSync` from `node:fs` or `node:fs/promises` (including aliased
  and destructured imports, and `const` string or template-literal targets)
  pointing at a system binary path (`/bin/*`, `/usr/bin/*`, `/usr/local/bin/*`,
  `/sbin/*`, `/usr/sbin/*`) in template and kernel tests. See
  [the gate's coverage](gate-coverage.md#fake-tool-lint).
- Faults `f7adacc-template-stub-tools` and `f7adacc-kernel-stub-tools` skip
  the system-binary path guard in `config/template-rules.mjs` and
  `config/kernel-repository-rules.mjs`; the `tests-stub-tools` witness tests
  kill each.
- Review only: dynamic target paths computed at runtime, shell commands that
  link system binaries, and stub scripts that still delegate to an unrelated
  host binary.
- Witnessed: [3729f36], [5f0c1d9].

## Time

- The lint catches delay-only waits. Review the timing controls
  outside its matcher. See [the gate's coverage](gate-coverage.md#timer-lint).
- Witnessed: [d1436c0].

## Finish cases

- Each fault breaks forgetting an in-process run's identity
  (`kernel/src/kernel/lifecycle.ts`), and its `IP08` case kills it: never
  forgetting, forgetting before a handler past its deadline returns, and
  skipping a run that never enters its handler or that rejects.
- Review only: other finish work, and other ways to finish, such as a
  signal.
- Witnessed: [7fb5649], [ef76011].

## Forgotten entries

- Each fault makes `recordedEffect` (`kernel/src/kernel/state-seam.ts`)
  read its run through the identity lookup, the first always and the second
  outside its transaction. A seam case that reuses a forgotten run's
  identity kills each.
- Review only: other guards, and a missing entry whose key no run reused.
- Witnessed: [7fb5649], [c02caae].

[185c90d]: https://github.com/nathanvale/bun-typescript-template/commit/185c90d11dd167ee4874e383ba26cd7d64a70964
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[d1436c0]: https://github.com/nathanvale/bun-typescript-template/commit/d1436c0c13b2906e5eee1c08dfcea41c611f0bef
[9f3c666]: https://github.com/nathanvale/bun-typescript-template/commit/9f3c66623003b3ef1dd355b6b7ef93882cd937a2
[fa8b6f5]: https://github.com/nathanvale/bun-typescript-template/commit/fa8b6f5ac1733b1eedc1e8d78d267414ebc5c4cb
[7fb5649]: https://github.com/nathanvale/agent-cli-kernel/commit/7fb564900cff191397fdc8d1ba6f20e6807abdde
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
[c02caae]: https://github.com/nathanvale/agent-cli-kernel/commit/c02caae41a3100ab2c8d5272d21a60acb7a0b992
[3729f36]: https://github.com/nathanvale/bun-typescript-template/commit/3729f3644cb30ea5decc9c085bc6b9c4304eaae4
[5f0c1d9]: https://github.com/nathanvale/bun-typescript-template/commit/5f0c1d99741751de14f5cb92618eda3bd92e8887
