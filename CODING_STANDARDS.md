# Coding Standards

Read at review. This file extends the global standards at
`$HOME/code/dotfiles/docs/standards/CODING_STANDARDS.md` and holds only lessons
this repository witnessed at least twice in review feedback or repair commits.

Each row names what enforces it today:

- **Review only**: nothing fails on its own; the reviewer applies the
  judgement guide.
- **Partial**: a gate covers the part named in the gate notes; the reviewer
  applies the guide to the rest.
- **Planned (parked)**: agreed future work that does not exist yet.

When a planned gate lands, move it to "Today" and cut the guide bullets it
now enforces.

## Rule table

| Rule                                          | Today         | Planned (parked)                                | Guide                                                               |
| --------------------------------------------- | ------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Each test fails for the reason its name gives | Review only   | Lint `require-to-throw-message`; typed rule ids | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)      |
| Each new refusal or bound has a planted fault | Review only   | `bun run faults` replay                         | [Test proof](docs/standards/test-proof.md#planted-faults)           |
| Process proofs use the production entry       | Partial       | None                                            | [Test proof](docs/standards/test-proof.md#production-entry)         |
| Test processes are bounded and released       | Review only   | Lint `tests-use-bounded-runner`                 | [Test proof](docs/standards/test-proof.md#processes)                |
| Tests wait on events, not wall time           | Review only   | Lint `tests-no-sleep`                           | [Test proof](docs/standards/test-proof.md#time)                     |
| One rule holds on every construction route    | Review only   | `AdmittedCommand` brand                         | [One rule, one path](docs/standards/one-rule-one-path.md)           |
| Every exit path emits exactly one envelope    | Partial       | None                                            | [Failure envelopes](docs/standards/failure-envelopes.md)            |
| Untrusted values are read once, as own data   | Review only   | Lint `no-in-operator`, `no-locale-compare`      | [Untrusted values](docs/standards/untrusted-values.md#object-model) |
| Delays, waits, and work have stated bounds    | Review only   | `Milliseconds` and `Bound` brands               | [Untrusted values](docs/standards/untrusted-values.md#bounds)       |
| Behaviour holds on Linux and macOS            | Partial       | Lint `no-host-path-literal`                     | [Platform parity](docs/standards/platform-parity.md)                |
| Glossary terms only                           | Glossary test | Lint `glossary-term`                            | [Glossary authority](AGENTS.md#authority)                           |
| One owner per constant, fake, and helper      | Review only   | Shared `tests/support/` module                  | Global standards                                                    |

## Gate notes

- Production entry: lint limits starter source outside the state add-on to
  its `index.ts`. Tests have no such rule.
- Envelopes: lint `repository/no-domain-output` keeps stream access in the
  output owner.
- Linux and macOS: `.github/workflows/ci.yml` runs on every pull request.
  `caseTest` titles and `R1.platform-outcomes-pinned` make unproved cases
  visible. `.github/workflows/macos-nightly.yml` runs on schedule once it
  reaches `main`.
- Glossary: `tests/glossary/glossary.test.ts` with its shrinking
  `known-hits.json`, over the scope in `term-table.json`.
- Processes: lint bans `Bun.spawn` in `starters/contract3/src` only.
- One owner: the global rule "One owner per sealed vocabulary and per test
  fake".
- Planted faults: a `RED:` line in the commit body records the fault by
  convention.

## Review routine

1. List the rows the diff touches.
2. For each row with a gate, confirm the gate ran green on hosted CI at this
   head.
3. For each Review only or Partial row, open its guide and apply every bullet
   to the diff.
4. Report each finding with its row and the guide bullet it breaks.
