# Single Witness: Tools and gates

How a gate, a script or a check reads a tool, its output and its inputs. A lesson seen once waits here as one bullet; the
[single witness guide](single-witness.md) says how it leaves.

- Give a list one order at both ends: a checker that requires it sorted
  must read it from a producer that sorts it. Witnessed: [bdd5e9c].
- Return a report as its owner gives it, every field kept. Witnessed:
  [0669e10].
- Make a guard against an empty gate count what the gate would run.
  Witnessed: [ac11ed9] (a test area whose tests sit only in subfolders was
  counted as empty).
- Refuse every spelling of a path but the plain one where it is read, so
  each consumer of the value matches the same files. Witnessed:
  [r4608771621] (a test area folder written as `./tests`, `tests/` or with
  `..` ran in the area runner, and the test placement check matched no file
  under it).
- Trigger a compiler check when its configuration changes. Witnessed:
  [r4608935157] (a staged `tsconfig.base.json` could change compilation
  while the hook only looked for staged source edits).
- Locate a change by the text it changes, not by unchanged text beside it,
  so an edit to that other text cannot lose the change. Witnessed:
  [r4609956051] (a hunk with two changed regions was anchored on the
  unchanged lines between them, so editing those lines made its fault
  STALE).
- Read staged Git blobs in one batch by object ID. Witnessed:
  [r4609890969] (the file-size gate started a Git process for each staged
  file).
- Report a tool that cannot start as the step's finding; `Bun.spawnSync`
  throws then instead of returning a failed result. Witnessed:
  [kernel#48 r4637879754], [69fc0bf] (the doctor's hooks check let a git
  missing from `PATH` throw, so the doctor crashed instead of warning).
- Read a path setting as its tool reads it, with `git config --path` for
  git, so a home-relative value is compared expanded. Witnessed:
  [kernel#48 r4637879781], [69fc0bf] (the doctor compared a `core.hooksPath`
  written as `~/...` without expanding it).
- Strip only the line end from a tool's output, so whitespace that belongs
  to the value survives. Witnessed: [kernel#48 r4637879764], [69fc0bf]
  (`trim()` read a `core.hooksPath` of `.githooks` with a trailing space as
  `.githooks`).
- Build a command's file list from the files a step produced, not from the
  list it started with, so a file the step skipped is not named. Witnessed:
  [kernel#48 r4637879806], [5048d5e] (the pinned-commit test's working-tree
  copy skipped a tracked file deleted from the working tree but still named
  it in `git add`'s pathspec, so setup failed).
- Make an exclude meant for folders check that the entry is a folder, so a
  file whose name starts the same way is still scanned. Witnessed:
  [kernel#49 r4637980677], [7f15a16] (the glossary scan's
  `**/lint-rule-folder-*` exclude also skipped a file with that prefix, so
  the file escaped the glossary check).
- Keep only files when a check asks whether a scan pattern names anything,
  since `node:fs` `globSync` lists folders too. Witnessed: [2c62768] (a
  glossary scope pattern that named only a folder would have passed the
  check that each pattern names something that exists).
- Declare a script that people or a document run by path as a runtime root
  in `.fallowrc.json` `entry`, so a dead-code report on it reads as a
  missing root. Witnessed: [39d64c3] (the author guide's writer lost its root
  when its `package.json` script was dropped).
- Skip only the named files a tool leaves, such as `.DS_Store`, and refuse
  every other unexpected entry, so a record cannot leave a gate through
  its name. Witnessed: [911189b] (the fault record reader skipped every
  dot-named file, so a record renamed `.x.json` was never replayed; Fable
  review of pull request 54).
- Credit coverage only from a run whose checks all passed. Witnessed:
  [044431e].
- Keep an advisory check advisory by leaving it out of the required checks,
  never by letting it continue on error, which hides a failure as green.
  Witnessed: [973abac] (the kernel trial's workflow tests passed with
  `continue-on-error` on its job or trial step; Sol 6.1 check of pull
  request 60).

[ac11ed9]: https://github.com/nathanvale/bun-typescript-template/commit/ac11ed98b7d538e8a304cac053aaefcaaf6b2cb3
[r4608771621]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608771621
[r4608935157]: https://github.com/nathanvale/bun-typescript-template/pull/101#discussion_r4608935157
[r4609956051]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956051
[r4609890969]: https://github.com/nathanvale/bun-typescript-template/pull/108#discussion_r4609890969
[kernel#48 r4637879754]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879754
[kernel#48 r4637879781]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879781
[kernel#48 r4637879764]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879764
[kernel#48 r4637879806]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879806
[69fc0bf]: https://github.com/nathanvale/agent-cli-kernel/commit/69fc0bf37518800b76c9e9b9e5b1cba6934172bd
[5048d5e]: https://github.com/nathanvale/agent-cli-kernel/commit/5048d5e01932fa8ab9c177e351f33423cb507c1e
[kernel#49 r4637980677]: https://github.com/nathanvale/agent-cli-kernel/pull/49#discussion_r4637980677
[7f15a16]: https://github.com/nathanvale/agent-cli-kernel/commit/7f15a164d817265cc6f82882ff6efa2b76a4556b
[2c62768]: https://github.com/nathanvale/agent-cli-kernel/commit/2c62768ceddd1af9a7f3b4fabf1b9d32818acf2e
[39d64c3]: https://github.com/nathanvale/agent-cli-kernel/commit/39d64c307e73a6153c572d6259df791e779efc4e
[bdd5e9c]: https://github.com/nathanvale/agent-cli-kernel/commit/bdd5e9cf017ea99cd6d63d501e0ef06a0652ca7f
[911189b]: https://github.com/nathanvale/agent-cli-kernel/commit/911189bb75fa97d60acaacfba6034417522804aa
[0669e10]: https://github.com/nathanvale/agent-cli-kernel/commit/0669e10e32c420aa077e8491818f1d1417f1a1c9
[044431e]: https://github.com/nathanvale/agent-cli-kernel/commit/044431e8b510ef9104ab7e4ade72f5d7ae980a69
[973abac]: https://github.com/nathanvale/agent-cli-kernel/commit/973abac66b578259a73b21857f5a92090f249717
