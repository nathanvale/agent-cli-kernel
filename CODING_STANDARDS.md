# Coding Standards

Read at review. This file extends the global standards at
`$HOME/code/dotfiles/docs/standards/CODING_STANDARDS.md` and holds only lessons
this repository witnessed in review feedback or repair commits.

A row enters with at least two witnesses. Its guide cites them, or its gate
note does when the guide lives outside `docs/standards/`. A guide bullet cites
the witnesses that taught it, one or more. A bullet with no citation is the
check that applies its row's lesson.

Each row names what enforces it today:

- **Review only**: no gate; the reviewer applies the guide.
- **Partial**: a gate covers the part its gate note names; the reviewer
  applies the guide to the rest.
- **Planned (parked)**: agreed future work that does not exist yet. These
  gates are plan units U4 to U6, parked until the Contract 3 coordinator gives
  them a slot. [MAG-98] is the Contract 3 scope issue; it does not list them
  yet.

When a planned gate lands, move it to "Today" and cut the guide bullets it
now enforces.

## Rule table

| Rule                                          | Today       | Planned (parked)                                | Guide                                                               |
| --------------------------------------------- | ----------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Each test fails for the reason its name gives | Review only | Lint `require-to-throw-message`; typed rule ids | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)      |
| Each new refusal or bound has a planted fault | Review only | `bun run faults` replay                         | [Test proof](docs/standards/test-proof.md#planted-faults)           |
| Process proofs use the production entry       | Review only | None                                            | [Test proof](docs/standards/test-proof.md#production-entry)         |
| Test processes are bounded and released       | Review only | Lint `tests-use-bounded-runner`                 | [Test proof](docs/standards/test-proof.md#processes)                |
| Tests wait on events, not wall time           | Review only | Lint `tests-no-sleep`                           | [Test proof](docs/standards/test-proof.md#time)                     |
| One rule holds on every construction route    | Review only | `AdmittedCommand` brand                         | [One rule, one path](docs/standards/one-rule-one-path.md)           |
| Every exit path emits exactly one envelope    | Partial     | None                                            | [Failure envelopes](docs/standards/failure-envelopes.md)            |
| Untrusted values are read once, as own data   | Review only | Lint `no-in-operator`, `no-locale-compare`      | [Untrusted values](docs/standards/untrusted-values.md#object-model) |
| Delays, waits, and work have stated bounds    | Review only | `Milliseconds` and `Bound` brands               | [Untrusted values](docs/standards/untrusted-values.md#bounds)       |
| Behaviour holds on Linux and macOS            | Partial     | Lint `no-host-path-literal`                     | [Platform parity](docs/standards/platform-parity.md)                |
| Glossary terms only                           | Partial     | Lint `glossary-term`                            | [Glossary authority](AGENTS.md#authority)                           |
| One owner per constant, fake, and helper      | Review only | Shared `tests/support/` module                  | [One owner](docs/standards/one-owner.md)                            |

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

## Review routine

1. List the rows the diff touches.
2. For each Partial row, confirm its gate ran green on hosted CI at this head.
3. For each Review only or Partial row, open its guide and apply every bullet
   to the diff.
4. Report each finding with its row and the guide bullet it breaks.

[MAG-98]: https://linear.app/myagentdojo/issue/MAG-98/command-contract-30-foundation-accepted-implementation-scope
[2784de0]: https://github.com/nathanvale/bun-typescript-template/commit/2784de083f90d5f72f1b10037bfc64a8eeccff3f
[356cce9]: https://github.com/nathanvale/bun-typescript-template/commit/356cce90dd2c4a75c7462f5d8f789b52bdaefaed
