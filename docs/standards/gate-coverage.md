# Gate Coverage

Use this reference when reviewing what a gate covers or reproducing a
refusal. The [rule table](../../CODING_STANDARDS.md#rule-table) names the
gates and their witnesses.

## Refusal lint

- Lint `repository/require-to-throw-message` refuses `toThrow()`,
  `toThrowError()` and `rejects.toThrow()` in `tests/` with no argument, or
  with one that names no message: `undefined` or `void 0`, an empty string,
  or a regular expression that matches a lone NUL character, as `/.*/`,
  `/.+/`, `/^/` and `/(?:)/` do. It reads through a type-only wrapper such
  as `undefined as never`. `.not.toThrow()` passes.
- A message that another guard also throws stays review. So do an error
  class or `expect.anything()` as the argument, a refusal asserted without
  `toThrow`, and input that more than one guard refuses.
- Review only, because the argument is built at run time: `new RegExp("")`,
  `String()`, a template with an expression such as `${""}`, and
  `expect.stringContaining("")`.

## Import coverage

- `tests/standards/coverage-gaps.test.ts` runs
  `fallow health --coverage-gaps` and refuses each runtime file, and each
  export of one, that no test reaches by import, unless
  `tests/standards/coverage-gaps-recorded-hits.json` records it. It also
  refuses a recorded hit that fallow no longer reports, so the list only
  shrinks. The `test` job runs it through `bun run test`, in three shards.
- It leaves out the kernel's paths: `kernel/`, `tests/kernel/`,
  `tests/glossary/` and `config/kernel-repository-rules.mjs`.
- Fault `aaedd58-doctor` adds to `scripts/doctor.ts` an exported `doneLine`
  that only the spawned doctor calls; the test refuses it.
- Review only: a test that imports a function but never calls it, or calls
  it without asserting what it does; a function the file does not export,
  which counts as reached once a test imports its file; a gap hidden by a
  `fallow-ignore` comment, which the comments lint admits as a directive;
  and a file fallow does not count as runtime, because no entry point
  reaches it or `.fallowrc.json` ignores it.

## Timer lint

- Lint `repository/tests-no-sleep` refuses, in `tests/`: `Bun.sleep` and
  `Bun.sleepSync`, also as `Bun["sleep"]` or destructured from `Bun`; the
  `node:timers/promises` `setTimeout` import; a default, namespace, `import()`
  or `require()` of that module.
- It also refuses a `setTimeout` inside a `new Promise` executor whose
  callback is the executor's `resolve`, or a function whose only statement
  calls `resolve()`, `resolve(undefined)` or `resolve(void 0)`, or that
  passes `resolve` with no value after the delay. It traces `setTimeout` to
  the global, `globalThis` or `node:timers`, under any import name, through
  aliases, `(0, setTimeout)` and type-only wrappers.
- A `setTimeout` that rejects, aborts or resolves with a value passes as a
  bounded watchdog, as in `spawnBounded`, which resolves `"expired"`.
  `setTimeout(resolve, ms, "timeout")` resolves a value too. Clearing the
  handle does not admit a delay: an awaited delay runs to its end first.
- Review only: `setInterval`, `Atomics.wait`, a `Date.now()` poll, a race
  control too narrow to catch its fault, and `scheduler.wait` from a named
  `node:timers/promises` import.
- Also review only: a resolver from `Promise.withResolvers`, a resolver
  pulled out of its promise or aliased inside the executor, a callback that
  resolves another way (`r.bind(null)`, `() => void r()`, `(r(), 0)`, a
  body of more than one statement), and a timer reached through `window`,
  `Bun.setTimeout` or a computed key.

## Comments

- Lint `repository/no-comments` refuses every comment block in a file
  `eslint.config.mjs` lints outside the kernel: `src/`, `scripts/`, `tests/`
  outside `tests/kernel/`, `config/` and the root `.mjs` files.
  Consecutive line comments are one block. The kernel's lint rule
  covers `kernel/` and `tests/kernel/`.
- A block stays only when it is one of these:
  - `Platform:` on its first line: behaviour of a runtime, operating system
    or tool this repository cannot change, such as an errno meaning or a Bun
    limit.
  - `Interface:` on its first line: a public contract the types cannot
    state.
  - An accepted decision citation. Say "accepted decision" and give a
    Contract 3 question number, an ID such as `N4a`, or the ruling date.
    See the [CLI kernel authority](../agents/cli-kernel.md).
  - A lint or compiler directive, such as `eslint-disable-next-line` or
    `@ts-expect-error`. Other rules govern those.
  - `SAFETY:` and a justification on its first line, on its own lines
    directly above the statement that holds a type cast (`as T`, not
    `as const`), where `anti-slop/require-safety-comment-for-type-assertion`
    accepts it.
- Everything else goes into code: a name, a type, a test title, or a lint
  lint rule whose message explains the constraint. An empty `catch` says what
  happens next in code (`return`, `continue`, or a rethrow), not in prose.
- Fault `5ac4285-template-rules` admits a marker on any line of a block; the
  lint test that refuses `Platform:` on a second line kills it. Fault
  `5ac4285-eslint-rules` plants the same fault in the kernel's copy.
- Fault `bbfce9a-template-rules` admits a `SAFETY:` block anywhere; the lint
  test that refuses one above a statement with no cast kills it. Fault
  `bbfce9a-eslint-rules` plants the same fault in the kernel's copy.
- Review only: whether a `Platform:` or `Interface:` comment is true, and
  whether it names something outside this repository. A marker is easy to
  add to any note.
- Not covered: `starters/simple/`, `starters/complex/`, the bootstrap
  profiles, the `.ts.txt` fixtures, the kernel lint configuration that lints
  a materialised tree, YAML and Markdown.
