# Gate Coverage

Use this reference when reviewing what a gate covers or reproducing a
refusal. The [rule table](../../CODING_STANDARDS.md#rule-table) names the
gates and their witnesses.

## File size

- `bun run check:file-size` counts tokens with the pinned `tiktoken`
  `o200k_base` encoding. A tracked regular UTF-8 text file can have up to
  5,000 tokens. `bun run check` and the hosted `check` job scan the working
  tree. Pre-commit checks the changed files in the active Git index using
  their staged bytes.
- Declare this gate in Fallow's `supportEntry`. This is the local exception
  to the shared `entry` rule for the file-size gate. The normal Fallow audit
  includes the gate, and the tokenizer stays in
  `devDependencies`. See [Fallow entry settings](https://fallow.tools/docs/configuration/overview/#supportentry).
- The scan excludes `kernel/`, `tests/kernel/`, files under `vendor/`
  directories, every `bun.lock`, and the generated `fallow-gate.sh` at exactly
  `.claude/hooks/` and `.codex/hooks/`.
- [The gate's recorded hits](../../scripts/file-size-recorded-hits.json) name each
  exception, its reason, and its lifetime. The standing fault-replay record
  reports its token count whenever scanned. Remove a temporary record in the
  change that brings the file within the limit or takes it out of the scan.
  The working tree scan checks every temporary record. Pre-commit checks
  temporary records for changed paths, including removals and renames. It
  reads the recorded hits from the active Git index.

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

- `tests/template/standards/coverage-gaps.test.ts` runs
  `fallow health --coverage-gaps` and refuses each runtime file, and each
  export of one, that no test reaches by import, unless
  `tests/template/standards/coverage-gaps-recorded-hits.json` records it. It also
  refuses a recorded hit that fallow no longer reports, so the list only
  shrinks, and `bun run check:names --against <base>` refuses unapproved
  additions against the merge base. The `test` job runs it through `bun run test`, in three shards.
- It leaves out the kernel's paths: `kernel/`, `tests/kernel/`,
  `tests/template/glossary/` and `config/kernel-repository-rules.mjs`.
- Fault `aaedd58-doctor` adds to `scripts/doctor.ts` an exported `doneLine`
  that only the spawned doctor calls; the test refuses it.
- Review only: a test that imports a function but never calls it, or calls
  it without asserting what it does; a function the file does not export,
  which counts as reached once a test imports its file; a gap hidden by a
  `fallow-ignore` comment, which the comments lint admits as a directive;
  and a file fallow does not count as runtime, because no entry point
  reaches it or `.fallowrc.json` ignores it.

## Process lint

- Lint `repository/tests-use-bounded-runner` refuses `Bun.spawn`,
  `Bun.spawnSync`, and `node:child_process` (`spawn`, `spawnSync`, `exec`,
  `execSync`, `execFile`, `execFileSync`, `fork`) in `tests/`, outside the
  three bounded runner owners: `tests/support/process.ts`,
  `tests/kernel/kernel-repair/swarm-process.ts` and
  `tests/kernel/lifecycle/harness.ts`.
- It traces each callee through named, renamed, default and namespace imports,
  `require()`, `import()`, destructuring, aliases, computed string keys and
  type wrappers.
- Review only: test timeouts covering the sum of sequential child bounds,
  teardown release order, process-group `SIGKILL`, and calls reached through
  dynamic keys or helper wrappers passed as parameters.

## Kernel source lint

`kernelLint` runs these rules on the source folder of the kernel
repository, of `skills/verify-cli/`, and of every repository that installs
the kernel. They are plugin rules, so a host block that sets its own
`no-restricted-syntax` options after `kernelLint` cannot replace them.

- Lint `repository/typescript-source` refuses a `.js`, `.mjs`, `.cjs`,
  `.jsx` or `.tsx` file in the source folder. Fault
  `f822a0ca-typescript-source` turns it off.
- Lint `repository/no-domain-output` refuses `process.stdout`,
  `process.stderr`, `Bun.stdout` and `Bun.stderr` by name or by a fixed
  key (string or template literal), destructured, or imported by value
  from `node:process` or `"bun"`. A type-only import passes. Fault
  `f822a0ca-no-domain-output` drops the destructured, `Bun` and `"bun"`
  matchers.
- Lint `repository/no-process-reach` works from an allowlist,
  `allowedRuntimeMembers` in `kernel/config/kernel/eslint-rules.mjs`:
  - A member that source reads or destructures from `Bun` or `process`
    passes when the list names it, or when another rule judges it: the
    stream names (`no-domain-output`) and `Bun.spawn`, `Bun.spawnSync`
    and `Bun.$` (`no-restricted-properties`). Chainable `process` listener
    methods (`on`, `once`, `off`, `addListener`, `removeListener`,
    `removeAllListeners`, `prependListener`, `prependOnceListener`,
    `setMaxListeners`) pass only as a call on `process` whose result is
    discarded (an expression statement or under `void`); importing or
    destructuring them is refused. A `console` member read passes to
    `no-console`. Every other member, a destructured `console` name, a
    rest element and a key that is not fixed are refused.
  - An import from `"bun"`, `process` or `console`, with or without
    `node:`, passes when it is type-only or names a listed member.
    `"node:module"` and `"module"` admit only type-only imports; every
    value import, re-export and side-effect import of them is refused.
    Default, namespace, `default`-named and side-effect imports,
    `export *`, and a re-export of an unlisted member are refused.
    `no-restricted-imports` refuses static `node:child_process` imports.
  - `import()`, unbound `require()` and `import.meta.require()` are
    refused when the module is one of those five, or when the argument is
    not a static string. Every other value reference to unbound `require`
    or `import.meta.require`, every computed key on `import.meta`,
    destructuring `require` or rest from `import.meta`, and using
    `import.meta` as a value are refused.
  - `Bun`, `process`, `console` and `require` read through `globalThis`,
    `global` or `self`, and any other use of those names or of
    `globalThis` as a value, are refused; a reference whose only
    definitions are ambient (`declare`) is judged as the runtime global.
    `typeof` and type positions pass.
  - Fault `f822a0ca-no-process-reach` turns the rule off.
- Review only: `Bun.file` or `Bun.write` given the stream descriptors 1
  or 2, and `eval` or `new Function` text that names a runtime global.

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
- A `setTimeout` that rejects, aborts or resolves with a value passes the
  lint rule. Review what it bounds. A watchdog such as `spawnBounded`
  races a timeout against the child's exit. Awaiting a valued timer on
  its own still waits on wall time. Clearing its handle after the wait
  leaves that delay in place.
- Review only: `setInterval`, `Atomics.wait`, a `Date.now()` poll, a race
  control too narrow to catch its fault, and `scheduler.wait` from a named
  `node:timers/promises` import.
- Also review only: a resolver from `Promise.withResolvers`, a resolver
  pulled out of its promise or aliased inside the executor, a callback that
  resolves another way (`r.bind(null)`, `() => void r()`, `(r(), 0)`, a
  body of more than one statement), and a timer reached through `window`,
  `Bun.setTimeout` or a computed key.

## Fake-tool lint

- Lint `repository/tests-stub-tools` refuses `symlink`, `symlinkSync`,
  `link`, `linkSync`, `copyFile` and `copyFileSync` from `node:fs`, `fs`,
  `node:fs/promises`, `fs/promises`, or `fs.promises` in
  `tests/**/*.{ts,mts,cts}` (both template and kernel test suites) when the
  first argument folds to a static POSIX path under `/bin/`, `/usr/bin/`,
  `/usr/local/bin/`, `/sbin/`, `/usr/sbin/` or `/usr/local/sbin/` (after
  `path.posix.normalize`).
- The rule traces named, renamed, default or namespace imports,
  `fs.promises` / `import { promises } from "node:fs"`, destructuring
  (including `{ default: fs }`), `require()`, `import()`, static string /
  template-literal / `const`-identifier computed keys, and static `+` /
  interpolated template / `const` string targets.
- Test placement (`scripts/check-names.ts` and
  `tests/template/names-check/names-check-test-placement.test.ts`) refuses
  every file Bun runs as a test outside `.test.ts` files in `repository.json`
  `testAreas`, so `.mjs`, `.js`, `.jsx`, `.tsx`, `.cjs`, `.mts`, `.cts`,
  `.spec.*`, `_test.*` and `_spec.*` test files are refused by pre-commit,
  tool-call hooks, and the hosted `test` job.
- Review only: target paths built at run time
  or passed through helper parameters (`path.join(...)`, `new URL("file:...")`),
  `.call`/`.apply`/`.bind` invocations, and shell `ln`/`cp` commands inside
  child processes.

## Untrusted-value lints

Both rules run on `.ts` files under `src/` and `scripts/`. Review other
file extensions in those directories.

- Lint `repository/no-locale-compare` refuses `localeCompare` and
  `Collator` as a property, a destructured name, or a constant string such as
  `Reflect.get(Intl, "Collator")`.
- Lint `repository/no-in-operator` in `config/payload-rules.mjs` refuses
  the `in` operator and `Reflect.has` on a key the target's type does not
  declare, and every `for...in`. A key
  declared on the target's type, or on one member of its union, passes, so
  `in` still narrows a union. A private name (`#id in value`) and
  `Object.hasOwn` pass.
- Tests stay review. The R15 locale arm in
  `tests/kernel/kernel-repair/equality.test.ts` swaps the collation on
  purpose. The `in` witnesses were source reading another program's
  payload, and a test reads values it built.
- Also review only: an index read such as `fields[key]` with a key from a
  payload, and a key the type declares that a value only inherits.
- Other source stays review in this table. The kernel's own lint covers
  `kernel/src/`.

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
  - The phrase "accepted decision" or "accepted decisions" anywhere in
    the block.
  - A directive in its exact tool syntax, single-line across every ECMAScript
    line terminator (`LF`, `CR`, `U+2028`, `U+2029`) and with every comment in
    the block judged on its own (never admitting following prose lines):
    `@ts-expect-error`, `@ts-ignore`, line-only `@ts-nocheck` and `@ts-check`,
    `biome-ignore` (`-all`, `-start`, `-end`) with a valid category and `: reason`,
    `fallow-ignore-next-line` and `fallow-ignore-file` with valid targets and
    optional `-- reason`, `eslint-disable-next-line` and `eslint-disable-line`,
    plus block-only `eslint`, `eslint-disable`, `eslint-enable`, `global`,
    `globals` and `exported`. `eslint.config.mjs` sets
    `linterOptions.noInlineConfig: true` across every linted path, so ESLint
    refuses every inline ESLint directive.
  - `SAFETY:` and a justification on its first line, on its own lines
    directly above the statement that holds a type cast (`as T`, not
    `as const`).
- Everything else goes into code: a name, a type, a test title, or a lint
  rule whose message explains the constraint. An empty `catch` says what
  happens next in code (`return`, `continue`, or a rethrow), not in prose.
- Fault `5ac4285-template-rules` admits a marker on any line of a block; the
  lint test that refuses `Platform:` on a second line kills it. Fault
  `5ac4285-eslint-rules` plants the same fault in the kernel's copy.
- Fault `bbfce9a-template-rules` admits a `SAFETY:` block anywhere; the lint
  test that refuses one above a statement with no cast kills it. Fault
  `bbfce9a-eslint-rules` plants the same fault in the kernel's copy.
- In review, verify what a `Platform:` or `Interface:` comment claims and
  whether it names something outside this repository.
- In review, verify each accepted decision citation. Require a Command
  Contract 3 question number, an ID such as `N4a`, or the ruling date.
  Consult the [CLI kernel authority](../agents/cli-kernel.md).
- Not covered: the `.ts.txt` fixtures, the kernel lint configuration that
  lints a materialised tree, YAML and Markdown.

## Recorded hits

- `eslint-suppressions.json` holds the recorded hits each lint rule found
  when it landed.
- ESLint records a count per lint rule and file. `bun run lint` fails when
  the count grows or when the count falls and leaves an unused suppression.
  Run `bunx eslint . --prune-suppressions` after fixing a recorded hit.
- `bun run check:names --against <base>` (the hosted `Recorded lists` step)
  refuses growth of `eslint-suppressions.json` by total count per lint rule
  against the merge base, unless that rule is a `repository/...` rule whose
  definition newly landed in the same change. File renames and suite splits
  that keep the rule's total unchanged pass.
- Review replacements within a file, or moves across files, that keep a lint
  rule's total count unchanged and pass lint.
- Both hosted `quality:fallow` steps in `.github/workflows/ci.yml` pass
  `--fail-on-baseline-growth`, refusing any new key in
  `fallow-health-recorded-hits.json` against the base revision.
- The lint rules for files outside the kernel live in
  `config/template-rules.mjs`, `config/platform-rules.mjs` and
  `config/payload-rules.mjs`.
  `platform-rules.mjs` owns `no-host-path-literal` and `payload-rules.mjs`
  owns `no-in-operator`. `eslint.config.mjs` joins the three under the
  `repository` plugin.
- The kernel lint rules and their recorded hits run from
  `config/kernel-repository-lint.mjs`.
- `kernel/config/kernel/` reaches generated repositories in the installed
  kernel, so it holds only the rules `kernelLint` turns on. The kernel
  repository's own lint rules, `no-comments` and the test lint rules,
  live in `config/kernel-repository-rules.mjs`.
