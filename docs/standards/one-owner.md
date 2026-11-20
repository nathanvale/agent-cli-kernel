# One Owner

The shared rule "One owner per sealed vocabulary and per test fake" applies.
This repository also drifted on constants and helpers, so the rule covers them
here.

- Import a cause code, route token, or built-in identity from its owner
  module. Witnessed: [56aee86], [e7c771c].
- Run a format or shape rule through its one helper. A second copy of a
  constructor's shape rule gave admission a different refusal text.
  Witnessed: [892a700], [f2270b3], [04ef358] (the standards check sorted
  fault record files its own way, so it listed them in a different order
  from replay; Sol 6.1 check of pull request 54), [911189b] (it still
  walked the folder itself, without replay's refusals for a bad name, bad
  JSON or an id that is not its file name; Fable review of pull request 54),
  [d899823] (a second workflow test parsed the workflows its own way; Sol
  6.1 review).
- Import shared test fakes and fixtures from
  `tests/kernel/kernel-repair/handlers.ts` and `shapes.ts`. Witnessed:
  [810345d], [cf72627], [7fb5649] (the state fixture copied `emptyInput`,
  station words and a refused cause row).
- Give admission commands that launch Git the same isolated environment as
  direct fixture calls. Witnessed: [#91-git].
- Isolate a test's git from the caller's configuration with `gitEnv` from
  `tests/support/git-fixture.ts`, and set it on `process.env` around an
  in-process subject that runs git. The standards fixture used to inherit
  runtime configuration. Witnessed: [#85-env], [#92-git]. The shared environment
  disables the global and system files, clears `GIT_CONFIG_PARAMETERS`, and
  replaces any runtime `GIT_CONFIG_COUNT` with its own two `KEY_n` and
  `VALUE_n` pairs, `maintenance.auto=false` and `gc.auto=0`, so a fixture
  commit starts no background git maintenance. It also pins
  `GIT_DEFAULT_HASH` to `sha1`, so a caller's sha256 default cannot change a
  fixture repository's object format. A user's `diff.orderFile`
  changed what the staged readers listed. Witnessed: [f929eb7], [7a62deb],
  [#84-git] (a local copy left runtime configuration in the replay fixture),
  [#90-git] (the bootstrap fixture inherited a signing requirement),
  [#101-git] (the naming fixture inherited a setting that disabled its hook),
  [73cb18b] (a commit's background maintenance still changed `.git` while a
  test removed the folder, on macOS), [55e24d6] (a caller's sha256 default
  made fixture repositories sha256).
- Start every child and git call a hook can reach from
  `withoutRepositoryLocation` in `scripts/process-runner.ts`, so none reads
  the hook's repository through `GIT_DIR` or the variables beside it.
  Witnessed: [def3ec4] (the runner, and a bare `Bun.spawn` beside it, handed
  a hook's `GIT_DIR` to each child), [#109-git] (the fault tool's
  synchronous git reads kept it too).
- List a test's files through `treeFiles` in
  `tests/support/lint-rule-folder.ts`, the one scan helper, so every walk
  skips the lint rule folders that other tests create and delete.
  Witnessed: [9824b41] (the glossary test's frozen contract walk still used
  `Bun.Glob` `scanSync`, so it could race with tests that make and remove
  probe folders), [ff0616c] (the author guide's example reader walked its
  folder with its own recursion), [0463f35] (so did its document scan).
- Use the owner's constant, helper or matcher, or own the value outright,
  instead of a copy, which stops matching when its owner changes.
  Witnessed: [3567a81] (the author guide's install case copied
  git-fixture's private 4 s git bound into its own timeout, and its
  `thrownMessage` repeated `messageOf`, where `toThrow(new Error(message))`
  already compares the whole message), [0ab74b8] (the verification skill's
  front door resolved the target's entry its own way and ignored the entry
  a run recorded, which its doctor read; both now use `entryFor`).

[#91-git]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744335
[56aee86]: https://github.com/nathanvale/bun-typescript-template/commit/56aee86bf059fb2629819fa2b6a1664d776629d5
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[892a700]: https://github.com/nathanvale/bun-typescript-template/commit/892a7005ab00d6ffb24b8d760e9d4a2dc9e0b081
[f2270b3]: https://github.com/nathanvale/bun-typescript-template/commit/f2270b3916114f0d693544fb1dfb3ed190c92288
[810345d]: https://github.com/nathanvale/bun-typescript-template/commit/810345d01ab28f5b3108ea4b5420fb05743ec6b4
[cf72627]: https://github.com/nathanvale/bun-typescript-template/commit/cf726279ccbe1fa540745be879343c379390fdd1
[#92-git]: https://github.com/nathanvale/bun-typescript-template/pull/92#discussion_r4607819556
[#85-env]: https://github.com/nathanvale/bun-typescript-template/pull/85#discussion_r4607322049
[f929eb7]: https://github.com/nathanvale/bun-typescript-template/commit/f929eb7fe9fbba24f5990269c27cddf302deb9de
[7a62deb]: https://github.com/nathanvale/bun-typescript-template/commit/7a62deb4233ecad8b18fb1206b03f70e0d1262f3
[#84-git]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244506
[#90-git]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634940
[#101-git]: https://github.com/nathanvale/bun-typescript-template/pull/101#discussion_r4609075462
[def3ec4]: https://github.com/nathanvale/bun-typescript-template/commit/def3ec4a0b0bbe9047f9296dc0bbf6424c44a807
[#109-git]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609955976
[7fb5649]: https://github.com/nathanvale/agent-cli-kernel/commit/7fb564900cff191397fdc8d1ba6f20e6807abdde
[73cb18b]: https://github.com/nathanvale/agent-cli-kernel/commit/73cb18b9e96a5d549be88b007c194a90195aeae8
[55e24d6]: https://github.com/nathanvale/agent-cli-kernel/commit/55e24d6fe702b002de8173e05b0c21907c315422
[9824b41]: https://github.com/nathanvale/agent-cli-kernel/commit/9824b413ed3743656fef68d502086545fac6d130
[ff0616c]: https://github.com/nathanvale/agent-cli-kernel/commit/ff0616cd9c3310bf1170e28308c3c748353fc57b
[0463f35]: https://github.com/nathanvale/agent-cli-kernel/commit/0463f35b14fd6aadced45cab40b44436fb480b33
[3567a81]: https://github.com/nathanvale/agent-cli-kernel/commit/3567a8125e36f43eb6b3f448a5f51fb122090536
[0ab74b8]: https://github.com/nathanvale/agent-cli-kernel/commit/0ab74b894857b6b741be277e2f2fd41764e96cd2
[04ef358]: https://github.com/nathanvale/agent-cli-kernel/commit/04ef3587677146fa53e4cf509bdb651997907298
[911189b]: https://github.com/nathanvale/agent-cli-kernel/commit/911189bb75fa97d60acaacfba6034417522804aa
[d899823]: https://github.com/nathanvale/agent-cli-kernel/commit/d899823343fdcf4557ba08f2d64ce84a8d9a2af4
