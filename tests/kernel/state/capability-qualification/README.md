# Capability qualification records

Each file here is the capability qualification record that one capability
qualification row cites, named `<row id>.json`. Only
`bun run capability-qualification-run` writes one; never edit a record by
hand.

- Schema: `capability-qualification-record/1`, with the fields of the journal
  version 2 design, part 2 section 3
  (`kernel/src/addons/state/DESIGN-V2-CLOSURE.md`).
- A row needs two capability qualification runs in its record: the first
  through the test entry (`fixture.ts`) with the candidate row, the second
  through `index.ts` with the row in the production capability qualification
  table, on the row's own branch.
- Case Q03.a, in `capability-qualification-record.test.ts`, refuses a
  production row whose record is missing, made with an overridden fact, for
  another platform or for changed source, short of a run or a passed required
  case, or whose row names no review.
- A record from the hosted runner is not evidence (decision T, Nathan,
  19 November 2026). There is no macOS row.

Command line, from the repository root on the platform under test:

```sh
bun run capability-qualification-run <candidate row file> <state root parent> [--entry fixture.ts|index.ts]
```

The candidate row file is JSON with the row's `id`, `os`, `majorRelease`,
`observedRelease`, `filesystem` (`name` and `type`), `primitive` and
`bootIdentitySource`, kept outside the checkout. The state root parent is a
folder on the filesystem under test; each case makes its state root inside it.
