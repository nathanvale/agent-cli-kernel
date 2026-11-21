# Coding Standards

Read at review. This file holds only lessons this repository witnessed in
review feedback or repair commits. It extends Engineering's shared coding
standard. The guides call it the shared standard and cite it by title.

Read the shared standard from the first available source.

1. The copy your task brief supplies.
2. Its current source, `docs/standards/CODING_STANDARDS.md` in
   `nathanvale/dotfiles-private`, pinned at [6bcadfd][shared-standard]. This
   pin is a bridge until your domain selects an approved version.

If you can reach neither, apply this file and its guides alone, and report the
shared standard as missing context. No approved route delivers the shared
standard to a fresh checkout yet. [MAG-65] owns preparing that route,
[MAG-88] owns source adoption, and [MAG-78] owns the deployment repository.

A rule row enters with at least two witnesses. Its guide cites them, or its gate
note does when the row has no guide. A guide bullet cites
one or more witnesses that taught it. An uncited guide bullet tells the reviewer
how to apply its row. A lesson with one witness waits in
[Single witness](docs/standards/single-witness.md) until a second arrives.

Each rule row names what enforces it today:

- **Review only**: no gate; the reviewer applies the guide.
- **Partial**: the gates in its Gates cell cover the part its gate note
  names; the reviewer applies the guide to the rest.

The Gates cell names each gate as `script`, `lint`, `job` or `fault` with its
id, and links the gate note in a gate notes guide. A `fault` id is a record id in
`tests/planted-faults/fault-records/`. **Planned (parked)** names agreed
gates that do not exist yet. Plan units U4 to U6 of [#8] first named some;
none has a slot, and the Contract 3 scope issue, [MAG-98], omits them.

`bun run test:area standards` checks that every cited commit, link and named
gate exists, and that each row's guide or gate note cites two distinct
witnesses.

The names check area, `tests/template/names-check/`, runs with
`bun run test:area names-check`.

## Rule table

| Rule                                                        | Today       | Gates                                                                                                                                                                                             | Planned (parked)                         | Guide                                                                                       |
| ----------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Each test fails for the reason its name gives               | Partial     | [lint `repository/require-to-throw-message`](docs/standards/gate-notes-tests.md#test-proof)                                                                                                       | Typed rule ids                           | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)                              |
| Each new refusal or bound has a planted fault               | Partial     | [script `fault-replay`, job `fault-replay`](docs/standards/gate-notes-tests.md#planted-faults)                                                                                                    | None                                     | [Test proof](docs/standards/planted-faults.md#planted-faults)                               |
| Process proofs use the production entry                     | Review only | None                                                                                                                                                                                              | None                                     | [Test proof](docs/standards/production-entry.md#production-entry)                           |
| Script functions are tested in-process                      | Partial     | [job `test`, fault `aaedd58-doctor`](docs/standards/gate-notes-tests.md#in-process-tests)                                                                                                         | None                                     | [Test proof](docs/standards/production-entry.md#in-process-tests)                           |
| Test processes are bounded and released                     | Review only | None                                                                                                                                                                                              | Lint `tests-use-bounded-runner`          | [Test harness](docs/standards/test-harness.md#processes)                                    |
| Tests fake a tool with a stub script                        | Review only | None                                                                                                                                                                                              | Lint `tests-stub-tools`                  | [Test harness](docs/standards/test-harness.md#fake-tools)                                   |
| Tests wait on events, not wall time                         | Partial     | [lint `repository/tests-no-sleep`](docs/standards/gate-notes-tests.md#time)                                                                                                                       | None                                     | [Test harness](docs/standards/test-harness.md#time)                                         |
| Test timings follow a moved suite                           | Partial     | [job `test`, fault `996a685-test-timings`](docs/standards/gate-notes-tests.md#timings)                                                                                                            | None                                     | [Test harness](docs/standards/test-harness.md#timings)                                      |
| A lint rule holds on each shape it can meet                 | Review only | None                                                                                                                                                                                              | None                                     | [Lint rules](docs/standards/lint-rules.md#shapes)                                           |
| Finish work is proved on every finish path                  | Partial     | [fault `d62870c-in-process-forget`, fault `7fb5649-in-process-entered`, fault `d62870c-in-process-rejected`, fault `d62870c-in-process-handler`](docs/standards/gate-notes-tests.md#finish-cases) | None                                     | [Finish paths](docs/standards/finish-paths.md#finish-cases)                                 |
| A guard reads a missing entry as closed                     | Partial     | [fault `7fb5649-state-seam-closed`, fault `c02caae-state-seam-active`](docs/standards/gate-notes-tests.md#forgotten-entries)                                                                      | Seam guards hold their run object        | [Finish paths](docs/standards/finish-paths.md#forgotten-entries)                            |
| One rule holds on every construction route                  | Review only | None                                                                                                                                                                                              | `AdmittedCommand` brand                  | [One rule, one path](docs/standards/one-rule-one-path.md)                                   |
| Every exit path emits exactly one envelope                  | Review only | None                                                                                                                                                                                              | None                                     | [Failure envelopes](docs/standards/failure-envelopes.md)                                    |
| Another program's envelope is checked against its protocol  | Review only | None                                                                                                                                                                                              | Fault that skips a protocol check        | [Failure envelopes](docs/standards/failure-envelopes.md#envelopes-read-from-other-programs) |
| Untrusted values are read once, as own data                 | Partial     | [lint `repository/no-locale-compare`, lint `repository/no-in-operator`, fault `b9e392f-payload-rules`](docs/standards/gate-notes-repository.md#untrusted-values)                                  | None                                     | [Untrusted values](docs/standards/untrusted-values.md#object-model)                         |
| Delays, waits, and work have stated bounds                  | Review only | None                                                                                                                                                                                              | `Milliseconds` and `Bound` brands        | [Untrusted values](docs/standards/untrusted-values.md#bounds)                               |
| A failed read never reads as absent                         | Review only | None                                                                                                                                                                                              | Fault that reads every failure as absent | [Untrusted values](docs/standards/untrusted-values.md#failed-reads)                         |
| A path and a program's output are judged as they really are | Review only | None                                                                                                                                                                                              | Fault that leaves a link unresolved      | [Untrusted values](docs/standards/untrusted-values.md#paths-and-outputs)                    |
| Behaviour holds on Linux and macOS                          | Partial     | [job `test`, lint `repository/no-host-path-literal`, fault `b79a4ac-platform-rules`, fault `a0d17cc-in-process-control`](docs/standards/gate-notes-repository.md#linux-and-macos)                 | None                                     | [Platform parity](docs/standards/platform-parity.md)                                        |
| Glossary terms only                                         | Partial     | [job `test`](docs/standards/gate-notes-repository.md#glossary)                                                                                                                                    | Lint `glossary-term`                     | [Glossary map](GLOSSARY-MAP.md)                                                             |
| One owner per constant, fake, and helper                    | Partial     | [lint `repository/tests-use-test-folder`](docs/standards/gate-notes-repository.md#one-owner)                                                                                                      | None                                     | [One owner](docs/standards/one-owner.md)                                                    |
| Each commit is green at its own head                        | Partial     | [script `check:commits`, job `commits`](docs/standards/gate-notes-repository.md#commits)                                                                                                          | None                                     | None                                                                                        |
| Say it in code, not in a comment                            | Partial     | [lint `repository/no-comments`, fault `5ac4285-template-rules`, fault `bbfce9a-template-rules`](docs/standards/gate-notes-repository.md#comments)                                                 | None                                     | None                                                                                        |

## Gate notes

Each gate note lives in a gate notes guide: [test rows](docs/standards/gate-notes-tests.md) and
[repository rows](docs/standards/gate-notes-repository.md). The Gates cell links its note.

## Review routine

1. List the rule rows the diff touches.
2. For each Partial rule row, find each gate in the hosted check result
   for the head your caller passed in the prompt. Report a gate the result
   does not show green as **unproved**, never as a pass. For questions
   about coverage, follow its gate note and any linked detail.
3. For each Review only or Partial rule row, open its guide, or its gate note when
   it has no guide, and apply every bullet to the diff.
4. Report each finding with its rule row and the guide or gate-note bullet it breaks.

[MAG-98]: https://linear.app/myagentdojo/issue/MAG-98/command-contract-30-foundation-accepted-implementation-scope
[#8]: https://github.com/nathanvale/bun-typescript-template/pull/8
[MAG-65]: https://linear.app/myagentdojo/issue/MAG-65/define-coordinator-privacy-and-composable-task-execution
[MAG-88]: https://linear.app/myagentdojo/issue/MAG-88/epic-reproducible-repository-foundations
[MAG-78]: https://linear.app/myagentdojo/issue/MAG-78/name-and-create-the-deployment-repository
[shared-standard]: https://github.com/nathanvale/dotfiles-private/blob/6bcadfd752107a980ce4f0a8982ff18399dc78f2/docs/standards/CODING_STANDARDS.md
