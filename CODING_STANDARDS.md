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

The Gates cell names each gate as `script`, `lint` or `job` with its id, and
links the gate note. **Planned (parked)** names agreed gates that do not exist
yet. Plan units U4 to U6 in the description of [#8] first named them. The
lints and the fault replay have landed. The rest has no slot, and [MAG-98],
the Contract 3 scope issue, does not list them.

When a planned gate lands, name it in the Gates cell, mark the row Partial,
and cut the guide bullets it now enforces. `bun run test:area standards`
checks that every cited commit, link and named gate exists.

## Rule table

| Rule                                          | Today       | Gates                                                                                        | Planned (parked)                  | Guide                                                               |
| --------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| Each test fails for the reason its name gives | Partial     | [lint `repository/require-to-throw-message`](#test-proof)                                    | Typed rule ids                    | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)      |
| Each new refusal or bound has a planted fault | Partial     | [script `faults`, job `faults`](#planted-faults)                                             | None                              | [Test proof](docs/standards/test-proof.md#planted-faults)           |
| Process proofs use the production entry       | Review only | None                                                                                         | None                              | [Test proof](docs/standards/test-proof.md#production-entry)         |
| Test processes are bounded and released       | Review only | None                                                                                         | Lint `tests-use-bounded-runner`   | [Test proof](docs/standards/test-proof.md#processes)                |
| Tests wait on events, not wall time           | Partial     | [lint `repository/tests-no-sleep`](#time)                                                    | None                              | [Test proof](docs/standards/test-proof.md#time)                     |
| One rule holds on every construction route    | Review only | None                                                                                         | `AdmittedCommand` brand           | [One rule, one path](docs/standards/one-rule-one-path.md)           |
| Every exit path emits exactly one envelope    | Partial     | [lint `repository/no-domain-output`](#envelopes)                                             | None                              | [Failure envelopes](docs/standards/failure-envelopes.md)            |
| Untrusted values are read once, as own data   | Partial     | [lint `repository/no-locale-compare`, lint `repository/no-in-operator`](#untrusted-values)   | None                              | [Untrusted values](docs/standards/untrusted-values.md#object-model) |
| Delays, waits, and work have stated bounds    | Review only | None                                                                                         | `Milliseconds` and `Bound` brands | [Untrusted values](docs/standards/untrusted-values.md#bounds)       |
| Behaviour holds on Linux and macOS            | Partial     | [job `check`](#linux-and-macos)                                                              | Lint `no-host-path-literal`       | [Platform parity](docs/standards/platform-parity.md)                |
| Glossary terms only                           | Partial     | [job `check`](#glossary)                                                                     | Lint `glossary-term`              | [Glossary authority](AGENTS.md#authority)                           |
| One owner per constant, fake, and helper      | Partial     | [lint `repository/cause-literal-owner`, lint `repository/tests-use-test-folder`](#one-owner) | None                              | [One owner](docs/standards/one-owner.md)                            |
| Each commit is green at its own head          | Partial     | [script `check:commits`, job `commits`](#commits)                                            | None                              | None                                                                |

## Gate notes

### Envelopes

- Lint `repository/no-domain-output` keeps stream access in the output owner.
- It runs on `src/domains/` and `starters/contract3/src/` only.
- `starters/simple/` and `starters/complex/` have no such gate.

### Linux and macOS

- `.github/workflows/ci.yml` runs on every pull request.
- `R1.platform-outcomes-pinned` pins unproved diagnostics rows only.
- State `caseTest` titles can show `UNPROVED` off their platform, but no test
  pins their count.
- `tests/contract3/approval/component.test.ts` still reports unproved cases
  through `test.skip`.
- `.github/workflows/macos-nightly.yml` runs on schedule once it reaches
  `main`.

### Glossary

- `tests/glossary/glossary.test.ts`, with its shrinking `known-hits.json`,
  checks the `scope` listed in `tests/glossary/term-table.json`.
- That scope is Contract 3 source, Contract 3 tests, and the Contract 3 lint
  config. `src/`, the other starters, and docs are review only.
- Witnessed: [2784de0], [356cce9].

### Test proof

- Lint `repository/require-to-throw-message` refuses `toThrow()`,
  `toThrowError()` and `rejects.toThrow()` with no argument in `tests/`.
  `.not.toThrow()` passes.
- A message that another guard also throws stays review. So do a refusal
  asserted without `toThrow`, and input that more than one guard refuses.
- Witnessed: [185c90d].

### Planted faults

- `bun run faults` replays each record in `tests/faults/manifest.json` in a
  temporary worktree. The `faults` job in `.github/workflows/ci.yml` runs it
  on every pull request.
- It fails on a record whose named test passes with the fault applied, fails
  without it, or whose patch no longer applies.
- A new refusal or bound with no record stays review. So does a record whose
  test title matches more tests than the fault reaches.
- Witnessed: [d72cd9e], [640ba05].

### Time

- Lint `repository/tests-no-sleep` refuses `Bun.sleep`, `Bun.sleepSync`,
  the `node:timers/promises` `setTimeout`, and a `setTimeout` that only
  resolves a promise, in `tests/`.
- A `setTimeout` that rejects, aborts or resolves with a sentinel passes as
  a bounded watchdog. A poll on `Date.now()` and a race control too narrow to
  catch its fault stay review.
- Witnessed: [d1436c0].

### Untrusted values

- Lint `repository/no-locale-compare` refuses `localeCompare` and
  `Intl.Collator` in `src/`, `scripts/` and `starters/contract3/src/`.
- Tests stay review. The R15 locale arm in
  `tests/contract3/kernel-repair/equality.test.ts` swaps the collation on
  purpose.
- Lint `repository/no-in-operator` refuses the `in` operator in
  `starters/contract3/src/`. A private `#name in value` check passes.
- The `in` operator outside Contract 3 source stays review. So do a bracket
  read of an inherited name, a second read of a value, and a spread that
  drops properties.
- Witnessed: [b456208], [5cbff3a].

### One owner

- Lint `repository/cause-literal-owner` refuses a string literal shaped like
  a cause code in `starters/contract3/src/`, outside `kernel/causes.ts`,
  `kernel/state-causes.ts` and `kernel/stations.ts`. The shape is `SUCCESS_`,
  `USAGE_`, `SCHEMA_`, `DOMAIN_`, `TRANSIENT_` or `INTERNAL_`, then upper
  snake case.
- A cause literal in a type position passes. Route tokens, built-in
  identities, shape helpers and test fakes stay review.
- Lint `repository/tests-use-test-folder` refuses `tmpdir()`, `mkdtemp()`
  and `mkdtempSync()` in `tests/`, outside `tests/support/test-folder.ts`.
  That shared `tests/support/` module owns test folders through
  `testFolder()`, which honours `STATE_TEST_DIR`.
- Witnessed: [e7c771c], [c0b4bf5].

### Commits

- `bun run check:commits <base>` installs, type-checks and lints each commit
  in `<base>..HEAD` at its own head, in a temporary worktree. The `commits`
  job in `.github/workflows/ci.yml` runs it against the pull request base.
- It never checks `f20777f` or an older commit. Some of those are red.
- Format and tests at each commit stay review.
- Witnessed: [2d0c390], [258365e], [59d45c1], [de45f44], [d3df03e],
  [4737c48], [e07d962].

### Recorded hits

- `eslint-suppressions.json` records the hits each lint found when it
  landed. They are existing violations, not reviewed exceptions.
- `bun run lint` fails on a new hit. It also fails when a recorded hit is
  fixed and the file is not pruned. Run
  `bunx eslint . --prune-suppressions` after the fix.

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
