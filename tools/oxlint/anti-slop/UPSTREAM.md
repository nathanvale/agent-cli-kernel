# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
`13909c9e07590f5a85d93c62712259fe14a883f7` (14 October 2026), MIT.

Copied from `skills/install-anti-slop/assets/anti-slop/` at that commit, the
bundle the upstream install skill copies. It matched upstream `src/` byte for
byte, apart from the RuleTester files, which the bundle leaves out.

Installed paths:

- `tools/oxlint/anti-slop/`: the generic plugin and the opt-in Effect plugin.
  Only the generic plugin is registered; this repository does not depend on
  Effect.
- `tools/oxlint/package.json`: marks the folder as ES modules so Node loads
  the plugin without a module-type warning.

Configuration:

- `.oxlintrc.json` registers the generic plugin, enables every generic rule
  and `oxc/no-accumulating-spread` at `error`, and turns the default Oxlint
  `correctness` category off so ESLint stays the owner of general lint.
- `bun run lint:anti-slop` runs it. `bun run check` does not run it yet.
- `oxlint` and `@oxlint/plugins` are pinned to the same exact version.

Local deviations: none in the vendored files.

To update, follow the upstream skill's update procedure
(`skills/install-anti-slop/references/update.md`) against the commit above
as the base.
