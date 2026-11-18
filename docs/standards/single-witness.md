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
- Refresh the split suites' entries in `tests/test-timings.json` from hosted
  timing artifacts when a slow suite moves. Witnessed: [r4607696012]
  (the original estimate stayed on the smallest suite, and all five moved
  suites ran on one shard).

[ac11ed9]: https://github.com/nathanvale/bun-typescript-template/commit/ac11ed98b7d538e8a304cac053aaefcaaf6b2cb3
[cd2498b]: https://github.com/nathanvale/bun-typescript-template/commit/cd2498b7189a2d45d1906b9c870e8d13da6cd2dd
[fc4fa62]: https://github.com/nathanvale/bun-typescript-template/commit/fc4fa628535ecc6729048cb6fbb759f153edd040
[r4606943319]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943319
[r4607149514]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149514
[r4607149524]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149524
[r4607696012]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607696012
