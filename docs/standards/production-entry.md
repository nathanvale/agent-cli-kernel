# Production Entry

How a process proof starts its subject, and where an in-process test calls it. The
[test proof guide](test-proof.md) holds the rest of this guide's rules.

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
  function proved only that way reads as untested and the code changes no test detects in it
  go unreported. Witnessed: [0ab74b8] (three verification skill functions ran
  only in spawned helpers).
- Resolve each path from the environment a function is given, not from the
  process's own folder, so an in-process call runs on what the test injects.
  Witnessed: [244b63a].

[e55f94a]: https://github.com/nathanvale/bun-typescript-template/commit/e55f94a5b7dcb78f9b25f5d0a723a2196bd8c452
[7ea1ee3]: https://github.com/nathanvale/bun-typescript-template/commit/7ea1ee3853cb6251fcf93c6a6ecf683e065fbfef
[244b63a]: https://github.com/nathanvale/bun-typescript-template/commit/244b63a814ddbb60b4831cabc0e2f8cd1b73bca4
[c5a554e]: https://github.com/nathanvale/bun-typescript-template/commit/c5a554e0034342f6918775909fcd3b15e27facca
[r4624230382]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230382
[9086c3b]: https://github.com/nathanvale/agent-cli-kernel/commit/9086c3b8b14bcba376aa63027abdd817c1495e53
[b146440]: https://github.com/nathanvale/agent-cli-kernel/commit/b146440b8fd1075791ee997ca93c59f410b9e978
[0ab74b8]: https://github.com/nathanvale/agent-cli-kernel/commit/0ab74b894857b6b741be277e2f2fd41764e96cd2
