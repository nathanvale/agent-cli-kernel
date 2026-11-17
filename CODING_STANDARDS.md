# Coding Standards

Read at review. This file holds only lessons this repository witnessed in
review feedback or repair commits. It extends Engineering's shared coding
standard. The guides call it the shared standard and cite its rules by title.

Use the first copy of the shared standard you can reach:

1. The copy your task brief supplies.
2. Its current source, `docs/standards/CODING_STANDARDS.md` in
   `nathanvale/dotfiles-private`, pinned at [6bcadfd][shared-standard]. This
   pin is a bridge until your domain selects an approved version.

If you can reach neither, apply this file and its guides alone, and report the
shared standard as missing context. No approved route delivers the shared
standard to a fresh checkout yet. [MAG-65] owns preparing that route,
[MAG-88] owns source adoption, and [MAG-78] owns the deployment repository.

A row enters with at least two witnesses. Its guide cites them, or its gate
note does when the row has no guide in `docs/standards/`. A guide bullet cites
the witnesses that taught it, one or more. A bullet with no citation is the
check that applies its row's lesson. A lesson with one witness waits in
[Single witness](docs/standards/single-witness.md) until a second arrives.

Each row names what enforces it today:

- **Review only**: no gate; the reviewer applies the guide.
- **Partial**: the gates in its Gates cell cover the part its gate note
  names; the reviewer applies the guide to the rest.

The Gates cell names each gate as `script`, `lint`, `job` or `fault` with its
id, and links the gate note. A `fault` id is a record id in
`tests/faults/records.json`. **Planned (parked)** names agreed gates that do not exist
yet. Plan units U4 to U6 in the description of [#8] first named them. The
lints and the fault replay have landed. The rest has no slot, and [MAG-98],
the Contract 3 scope issue, does not list them.

When a planned gate lands, name it in the Gates cell, mark the row Partial,
and cut the guide bullets it now enforces. `bun run test:area standards`
checks that every cited commit, link and named gate exists, and that each
row's guide or gate note cites two distinct witnesses.

## Rule table

| Rule                                          | Today       | Gates                                                                                                      | Planned (parked)                  | Guide                                                               |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| Each test fails for the reason its name gives | Partial     | [lint `repository/require-to-throw-message`](#test-proof)                                                  | Typed rule ids                    | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)      |
| Each new refusal or bound has a planted fault | Partial     | [script `faults`, job `faults`](#planted-faults)                                                           | None                              | [Test proof](docs/standards/test-proof.md#planted-faults)           |
| Process proofs use the production entry       | Review only | None                                                                                                       | None                              | [Test proof](docs/standards/test-proof.md#production-entry)         |
| Test processes are bounded and released       | Review only | None                                                                                                       | Lint `tests-use-bounded-runner`   | [Test proof](docs/standards/test-proof.md#processes)                |
| Tests wait on events, not wall time           | Partial     | [lint `repository/tests-no-sleep`](#time)                                                                  | None                              | [Test proof](docs/standards/test-proof.md#time)                     |
| One rule holds on every construction route    | Review only | None                                                                                                       | `AdmittedCommand` brand           | [One rule, one path](docs/standards/one-rule-one-path.md)           |
| Every exit path emits exactly one envelope    | Review only | None                                                                                                       | None                              | [Failure envelopes](docs/standards/failure-envelopes.md)            |
| Untrusted values are read once, as own data   | Partial     | [lint `repository/no-locale-compare`](#untrusted-values)                                                   | None                              | [Untrusted values](docs/standards/untrusted-values.md#object-model) |
| Delays, waits, and work have stated bounds    | Review only | None                                                                                                       | `Milliseconds` and `Bound` brands | [Untrusted values](docs/standards/untrusted-values.md#bounds)       |
| Behaviour holds on Linux and macOS            | Partial     | [job `check`](#linux-and-macos)                                                                            | Lint `no-host-path-literal`       | [Platform parity](docs/standards/platform-parity.md)                |
| Glossary terms only                           | Partial     | [job `check`](#glossary)                                                                                   | Lint `glossary-term`              | [Glossary authority](AGENTS.md#authority)                           |
| One owner per constant, fake, and helper      | Partial     | [lint `repository/tests-use-test-folder`](#one-owner)                                                      | None                              | [One owner](docs/standards/one-owner.md)                            |
| Each commit is green at its own head          | Partial     | [script `check:commits`, job `commits`](#commits)                                                          | None                              | None                                                                |
| Say it in code, not in a comment              | Partial     | [lint `repository/no-comments`, fault `5ac4285-template-rules`, fault `bbfce9a-template-rules`](#comments) | None                              | None                                                                |

## Gate notes

### Linux and macOS

- `.github/workflows/ci.yml` runs on every pull request.
- `R1.platform-outcomes-pinned` pins unproved diagnostics rows only.
- State `caseTest` titles can show `UNPROVED` off their platform, but no test
  pins their count.
- `tests/kernel/approval/component.test.ts` still reports unproved cases
  through `test.skip`.
- `.github/workflows/macos-nightly.yml` runs on schedule once it reaches
  `main`.

### Glossary

- `tests/glossary/glossary.test.ts`, with its shrinking `known-hits.json`,
  checks the `scope` listed in `tests/glossary/term-table.json`.
- That scope is Contract 3 source, Contract 3 tests, and the Contract 3 lint
  config. `src/`, the starters, and docs are review only.
- Witnessed: [2784de0], [356cce9].

### Test proof

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
- Witnessed: [185c90d].

### Planted faults

- `bun run faults` replays each record in `tests/faults/records.json` in a
  temporary worktree. The `faults` job in `.github/workflows/ci.yml` runs it
  on every pull request.
- It fails on a record whose named test passes with the fault applied, fails
  without it, or whose patch no longer applies.
- A new refusal or bound with no record stays review. So does a record whose
  test title matches more tests than the fault reaches.
- Witnessed: [d72cd9e], [640ba05].

### Time

- Lint `repository/tests-no-sleep` refuses, in `tests/`: `Bun.sleep` and
  `Bun.sleepSync`, also as `Bun["sleep"]` or destructured from `Bun`; the `node:timers/promises` `setTimeout` import; a
  default, namespace, `import()` or `require()` of that module.
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
- Witnessed: [d1436c0].

### Untrusted values

- Lint `repository/no-locale-compare` refuses `localeCompare` and
  `Collator` in `src/` and `scripts/`: as a
  property, a destructured name, or a constant string such as
  `Reflect.get(Intl, "Collator")`.
- Tests stay review. The R15 locale arm in
  `tests/kernel/kernel-repair/equality.test.ts` swaps the collation on
  purpose.
- Other source stays review in this table. The kernel's own lint covers
  `kernel/src/`.
- Witnessed: [b456208], [5cbff3a].

### One owner

- Lint `repository/tests-use-test-folder` refuses `tmpdir()`, `mkdtemp()`
  and `mkdtempSync()` in `tests/`, outside `tests/support/test-folder.ts`.
  That shared `tests/support/` module owns test folders through
  `testFolder()`, which honours `STATE_TEST_DIR`.
- The lint traces a callee to the name it was imported or read as: a named,
  renamed, default or namespace import, `require()`, `import()`,
  destructuring, an alias, or a member with a string key. A key built at
  runtime, a function passed in as a parameter, and a helper module that
  re-exports one under another name stay review.
- Witnessed: [e7c771c], [c0b4bf5].

### Commits

- `bun run check:commits <base>` installs, type-checks and lints each commit
  in `<base>..HEAD` at its own head, in a temporary worktree. The `commits`
  job in `.github/workflows/ci.yml` runs it against the pull request base.
- It never checks `f20777f` or an older commit. Some of those are red.
- Format and tests at each commit stay review.
- Witnessed: [2d0c390], [258365e], [59d45c1], [de45f44], [d3df03e],
  [4737c48], [e07d962].

### Comments

- Lint `repository/no-comments` refuses every comment block in a file
  `eslint.config.mjs` lints outside the kernel: `src/`, `scripts/`, `tests/`
  outside `tests/kernel/`, `config/` and the root `.mjs` files.
  Consecutive line comments are one block. The kernel's copy of the rule
  covers `kernel/` and `tests/kernel/`.
- A block stays only when it is one of these:
  - `Platform:` on its first line: behaviour of a runtime, operating system
    or tool this repository cannot change, such as an errno meaning or a Bun
    limit.
  - `Interface:` on its first line: a public contract the types cannot
    state.
  - A citation of an accepted decision, as [Authority](AGENTS.md#authority)
    describes.
  - A lint or compiler directive, such as `eslint-disable-next-line` or
    `@ts-expect-error`. Other rules govern those.
  - `SAFETY:` and a justification on its first line, on its own lines
    directly above the statement that holds a type cast (`as T`, not
    `as const`), where `anti-slop/require-safety-comment-for-type-assertion`
    accepts it.
- Everything else goes into code: a name, a type, a test title, or a lint
  rule whose message explains the constraint. An empty `catch` says what
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
  profiles, the `.ts.txt` fixtures, the Contract 3 lint configuration that
  lints a materialised tree, YAML and Markdown.
- Witnessed: [08284b7], [887b514].

### Recorded hits

- `eslint-suppressions.json` records the hits each lint found when it
  landed. They are existing violations, not reviewed exceptions.
- `bun run lint` fails on a new hit. It also fails when a recorded hit is
  fixed and the file is not pruned. Run
  `bunx eslint . --prune-suppressions` after the fix.
- The template's rules live in `config/template-rules.mjs`. Kernel rules and
  their recorded hits run from `config/kernel-repository-lint.mjs` and leave
  with the kernel.
- `kernel/config/kernel/` is stamped, so it holds only the rules
  `kernelLint` turns on. The kernel repository's own rules (`no-comments`
  and the three test rules) live in `config/kernel-repository-rules.mjs`.

## Review routine

1. List the rows the diff touches.
2. For each Partial row, find each of its gates in the hosted CI result for
   this head that your caller passed in the prompt. Report a gate the result
   does not show green as **unproved**, never as a pass.
3. For each Review only or Partial row, open its guide, or its gate note when
   it has no guide, and apply every bullet to the diff.
4. Report each finding with its row and the guide bullet it breaks.

[MAG-98]: https://linear.app/myagentdojo/issue/MAG-98/command-contract-30-foundation-accepted-implementation-scope
[#8]: https://github.com/nathanvale/bun-typescript-template/pull/8
[MAG-65]: https://linear.app/myagentdojo/issue/MAG-65/define-coordinator-privacy-and-composable-task-execution
[MAG-88]: https://linear.app/myagentdojo/issue/MAG-88/epic-reproducible-repository-foundations
[MAG-78]: https://linear.app/myagentdojo/issue/MAG-78/name-and-create-the-deployment-repository
[shared-standard]: https://github.com/nathanvale/dotfiles-private/blob/6bcadfd752107a980ce4f0a8982ff18399dc78f2/docs/standards/CODING_STANDARDS.md
[185c90d]: https://github.com/nathanvale/bun-typescript-template/commit/185c90d11dd167ee4874e383ba26cd7d64a70964
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[d1436c0]: https://github.com/nathanvale/bun-typescript-template/commit/d1436c0c13b2906e5eee1c08dfcea41c611f0bef
[c0b4bf5]: https://github.com/nathanvale/bun-typescript-template/commit/c0b4bf5e77558cc08922d5b303f5d9ba0af87066
[b456208]: https://github.com/nathanvale/bun-typescript-template/commit/b456208a45baa1f912a27a60eb70353c1e64d251
[5cbff3a]: https://github.com/nathanvale/bun-typescript-template/commit/5cbff3a87746defffd2672320038c48fbd1ddbc6
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[2784de0]: https://github.com/nathanvale/bun-typescript-template/commit/2784de083f90d5f72f1b10037bfc64a8eeccff3f
[356cce9]: https://github.com/nathanvale/bun-typescript-template/commit/356cce90dd2c4a75c7462f5d8f789b52bdaefaed
[2d0c390]: https://github.com/nathanvale/bun-typescript-template/commit/2d0c3902e6ca538b1e9dfd64c97458bd4b4f88ae
[258365e]: https://github.com/nathanvale/bun-typescript-template/commit/258365ed51313b4b190361d79609bc93bfc13d6a
[59d45c1]: https://github.com/nathanvale/bun-typescript-template/commit/59d45c1b84d347e3a8b2d617ac73e36096790dc9
[de45f44]: https://github.com/nathanvale/bun-typescript-template/commit/de45f443c1c71221a29ae03c203bd00ef1a4bffb
[d3df03e]: https://github.com/nathanvale/bun-typescript-template/commit/d3df03eccd47e3054de9e442971f778d1f13e803
[4737c48]: https://github.com/nathanvale/bun-typescript-template/commit/4737c4869802bb53893387df9919171855e83b11
[e07d962]: https://github.com/nathanvale/bun-typescript-template/commit/e07d962f016dc07ca442724621fd0406084521cc
[08284b7]: https://github.com/nathanvale/bun-typescript-template/commit/08284b762cf58a08777c846637a427e84caf0fe9
[887b514]: https://github.com/nathanvale/bun-typescript-template/commit/887b5140efe57411a674f872c1269d40b7bf019b
