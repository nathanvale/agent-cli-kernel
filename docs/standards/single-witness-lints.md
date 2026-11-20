# Single Witness: Lints

How a lint rule reads code, how its repair is built and where its allowance applies. A lesson seen once waits here as one bullet; the
[single witness guide](single-witness.md) says how it leaves.

- Turn off only the restriction an exception needs; a rule turned off for a
  file drops every restriction it holds. Witnessed: [0669e10].
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
- Grant a lint allowance for a path only where that path holds what the
  allowance is for; a repository that installs the kernel lints its own
  `src/kernel/` as application code. Witnessed: [r4638567003], [096c862]
  (`kernelLint` turned host rules off for `src/kernel/**` in every
  repository, so a generated repository's file there could write to
  stdout).

[fc4fa62]: https://github.com/nathanvale/bun-typescript-template/commit/fc4fa628535ecc6729048cb6fbb759f153edd040
[r4606943319]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943319
[r4607149514]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149514
[r4607149524]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149524
[r4638567003]: https://github.com/nathanvale/bun-typescript-template/pull/116#discussion_r4638567003
[096c862]: https://github.com/nathanvale/agent-cli-kernel/commit/096c862356a1b827bdf10d860ec5d4bd33797c1d
[0669e10]: https://github.com/nathanvale/agent-cli-kernel/commit/0669e10e32c420aa077e8491818f1d1417f1a1c9
