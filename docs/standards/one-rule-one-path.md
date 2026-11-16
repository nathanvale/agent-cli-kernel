# One Rule, One Path

A declaration rule holds on every route that builds or admits a command.
Review a new rule by walking each route below and finding where the rule runs
on it.

## Routes

- `command()`
- `changing()`
- raw declaration object
- spread of another declaration
- admission in `contractFor`, including station sets
- guidance command steps (`commandSteps`)
- `ifNoResult` steps

## Rules

- Put the rule in admission, where every route passes, rather than in one
  constructor. Witnessed: [d3df03e], [5bf9533], [r4580070907],
  [r4580077755].
- Give each constructor the guard its sibling runs. Witnessed: [140c1c7]
  (`command()` lacked the approval guard `changing()` ran).
- Run the declaration-time step check on `ifNoResult` and guidance command
  steps. Witnessed: [029aa83], [bdad6b0], [r4580070922], [r4580077762].
- Prove the rule on each route: one process-level test per route, or one
  table test over a test-owned route list.
- Add a new construction route to the list above in the same diff.

[d3df03e]: https://github.com/nathanvale/bun-typescript-template/commit/d3df03eccd47e3054de9e442971f778d1f13e803
[5bf9533]: https://github.com/nathanvale/bun-typescript-template/commit/5bf95338390d0ed3cd5a360855f3094f9f78d146
[140c1c7]: https://github.com/nathanvale/bun-typescript-template/commit/140c1c7dffd22edd31b15417304cca979d7fd841
[029aa83]: https://github.com/nathanvale/bun-typescript-template/commit/029aa8359bd3d1c9212a2a6996123d802b4ed0f0
[bdad6b0]: https://github.com/nathanvale/bun-typescript-template/commit/bdad6b0ac56aa99c7584786c5f913fe12ab79f22
[r4580070907]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070907
[r4580077755]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077755
[r4580070922]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070922
[r4580077762]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077762
