---

name: repo-steward
description: Keep the rule table in `CODING_STANDARDS.md` in step with its witnesses and gates. Use after an operator correction or a review finding, or to give a Review only or Partial row a gate.
---

# Repo steward

Paths below are from the repository root. These owners hold the rules; follow
each pointer rather than a copy:

- [CODING_STANDARDS.md](../../../CODING_STANDARDS.md): the rule table, how a
  row enters, the Today levels, the Gates cell, and the gate notes.
- [docs/standards/](../../../docs/standards/): the guide each row links.
  [Single witness](../../../docs/standards/single-witness.md) holds lessons
  seen once.
- [tests/lint-rules.test.ts](../../../tests/lint-rules.test.ts): a failing
  and a passing snippet for each lint, each case naming its witness.
- [Planted-fault guide](../../../docs/standards/test-proof.md#planted-faults):
  how to record a fault in `tests/faults/manifest.json`.
- [Recorded hits](../../../CODING_STANDARDS.md#recorded-hits): existing hits
  of a new lint.

Take **Correct** when the prompt brings a correction or a review finding.
Take **Promote** when it names a Review only or Partial row to gate.

## Write scope

Change only `CODING_STANDARDS.md`, `docs/standards/`, `eslint-rules.mjs`,
`config/contract3-eslint.mjs`, `eslint.config.mjs`,
`eslint-suppressions.json`, `tests/lint-rules.test.ts`, `tests/faults/` and
`tests/standards/`. Report a change the lesson needs anywhere else, with its
path, for that path's owner.

## Witnesses

A witness is the commit that fixed the mistake, or the review thread that
caught it. Read a commit with `git show <sha>`. Cite it as `[<short sha>]`
with a link definition at the end of the file, built from
`git rev-parse <sha>`. Copy the form the file already uses.

## Correct

1. Name the witness and state its lesson as one imperative line.
2. Find the row whose rule covers the lesson, and the guide bullet or gate
   note that teaches it.
3. With a row:
   - The guide or gate note already cites the witness: change nothing.
   - A gate of the row refuses the witness (a lint case or a fault record
     cites it): add the witness to that gate note's `Witnessed:` line.
   - Otherwise: add the witness to the guide bullet that teaches the lesson,
     or add a bullet under the row's guide heading.
4. With no row, look for the lesson in single witness:
   - Absent: add it there as one bullet with its witness, and stop.
   - Present: this is the second witness. Add a row at the highest level
     that would stop the mistake, in the order architecture, types, lint,
     test, prose. Write it Review only, with a guide bullet that cites both
     witnesses, and name the gate in Planned (parked) unless the level is
     prose. Delete the single witness bullet.
5. Report the row, its gates, each edit, and the next step: Promote for a
   lint or test level, the code owner for architecture or types.

Done when each item holds:

- The witness is cited once in its row's guide or gate note, or in single
  witness, or the report says it was already cited.
- `bun run test:area standards` passes.
- `git diff --name-only` lists only write-scope paths.

## Promote

1. Read the row, its guide and its gate note. Choose the gate: a lint rule in
   `eslint-rules.mjs` turned on in `eslint.config.mjs` or
   `config/contract3-eslint.mjs`, or a fault record for an existing test.
2. Prove the gate goes **red** on a cited witness. For a lint, add a case to
   `tests/lint-rules.test.ts` with the witness's failing shape and a passing
   one. For a fault, follow the planted-fault guide until
   `bun run faults <id>` prints `KILLED`.
3. For a lint, record the existing hits as the recorded hits note says, with
   `bunx eslint . --suppress-rule repository/<rule id>`.
4. Move the row: name the gate in its Gates cell, as
   ``lint `repository/<rule id>` `` or ``fault `<record id>` ``, link its
   gate note, mark it Partial, and drop the gate from Planned (parked). Write the gate note:
   what the gate refuses and where, what stays review, and `Witnessed:`.
5. Cut each guide bullet the gate now enforces in full, and narrow each one
   it enforces in part. Move a cut bullet's witnesses to the gate note.

Done when each item holds:

- `bun run test:area template -t "<rule id>"` passes, or
  `bun run faults <id>` prints `KILLED`.
- `bun run lint` exits 0.
- `bun run test:area standards` passes.
- No guide bullet restates what the gate refuses.
- `git diff --name-only` lists only write-scope paths.
