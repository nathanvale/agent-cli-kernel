---

name: repo-gardener
description: Keep the rule table in `CODING_STANDARDS.md` in step with its witnesses and gates. Use after an operator correction or a review finding, to give a Review only or Partial row a gate, or to weed what nothing uses any more.
---

# Repo gardener

Paths below are from the repository root. These owners hold the rules; follow
each pointer rather than a copy:

- [CODING_STANDARDS.md](../../../CODING_STANDARDS.md): the rule table, how a
  row enters, the Today levels, the Gates cell, and the gate notes.
- [docs/standards/](../../../docs/standards/): the guide each row links.
  [Single witness](../../../docs/standards/single-witness.md) holds lessons
  seen once.
- [tests/lint-rules.test.ts](../../../tests/lint-rules.test.ts) for template
  rules and
  [tests/kernel/lint-rules.test.ts](../../../tests/kernel/lint-rules.test.ts)
  for kernel rules: a failing and a passing snippet for each lint, each case
  naming its witness.
- [Planted-fault guide](../../../docs/standards/test-proof.md#planted-faults):
  how to record a fault in `tests/faults/manifest.json`.
- [Recorded hits](../../../CODING_STANDARDS.md#recorded-hits): existing hits
  of a new lint.

Take **Correct** when the prompt brings a correction or a review finding.
Take **Promote** when it names a Review only or Partial row to gate.
Take **Weed** when it asks you to clear out what nothing uses any more.

## Lint owners

A lint rule's owner decides its three files:

| Owner    | Rule file                            | Turned on in                        | Cases                             |
| -------- | ------------------------------------ | ----------------------------------- | --------------------------------- |
| Template | `config/template-rules.mjs`          | `eslint.config.mjs`                 | `tests/lint-rules.test.ts`        |
| Kernel   | `config/kernel-repository-rules.mjs` | `config/kernel-repository-lint.mjs` | `tests/kernel/lint-rules.test.ts` |

- A rule both owners need has one copy per owner. Change both rule files to
  the same text, with a case in each owner's cases file.
- `eslint-rules.mjs` re-exports the kernel's rule file, and
  `config/kernel-lint.mjs` passes this repository's folders to the kernel's
  stamped lint. Leave both unchanged.
- Rules stamped into generated repositories live in `kernel/config/kernel/`,
  outside the write scope. Report a change there for the code owner.

## Write scope

Change only `CODING_STANDARDS.md`, `docs/standards/`, the six files in
[Lint owners](#lint-owners), `eslint-suppressions.json`, `tests/faults/` and
`tests/standards/`. Weed may also change `AGENTS.md` and `.agents/skills/`.
Report a change the lesson needs anywhere else, with its path, for that
path's owner.

Start on a clean tree. When `git status --porcelain` prints anything, change
nothing and report its output: the scope check below cannot tell your edits
from edits already there.

## Witnesses

A witness is a commit or review thread that shows the mistake: the commit
that fixed it, the review thread that caught it, or a commit that carries
it, as the commits row cites commits that were red at their own head. Read a
commit with `git show <sha>`. Cite it as `[<short sha>]` with a link
definition at the end of the file, built from `git rev-parse <sha>`. Copy
the form the file already uses.

Two citations name the same witness when their links give the same full SHA
or the same thread URL. A second witness is a different commit or thread;
the same witness brought again stays one.

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
   - Absent: add it there as one bullet with its witness, in place of
     `- None yet.` when that line is there. Add no row.
   - Present, citing this same witness: change nothing.
   - Present, citing a different witness: this is the second witness. Add
     a row at the highest level that would stop the mistake, in the order
     architecture, types, lint, test, prose. Write it Review only, with a
     guide bullet that cites both witnesses, and name the gate in Planned
     (parked) unless the level is prose. Delete the single witness bullet,
     and restore `- None yet.` when no bullet remains.
5. Report the row, its gates, each edit, and the next step: Promote for a
   lint or test level, the code owner for architecture or types.

Done when each item holds:

- The witness is cited once in its row's guide or gate note, or in single
  witness, or the report says it was already cited.
- `bun run test:area standards` passes.
- `bun run format:check` exits 0.
- `git status --porcelain` lists only write-scope paths.

## Promote

1. Read the row, its guide and its gate note. When its Planned (parked) gate
   is a type or architecture change, such as a brand or typed ids, edit
   nothing and go to step 6: that gate lives in source, outside the write
   scope. Otherwise choose the gate: a lint rule in its owner's rule file,
   turned on in that owner's config (see [Lint owners](#lint-owners)), or a
   fault record for an existing test.
2. Prove the gate goes **red** on a cited witness. For a lint, add a case to
   its owner's cases file with the witness's failing shape and a passing
   one. For a fault, follow the planted-fault guide until
   `bun run faults <id>` prints `KILLED`.
3. For a lint, record the existing hits as the recorded hits note says, with
   `bunx eslint . --suppress-rule repository/<rule id>`.
4. Move the row: name the gate in its Gates cell, as
   ``lint `repository/<rule id>` `` or ``fault `<record id>` ``, link its
   gate note, mark it Partial, and drop the gate from Planned (parked). Write
   the gate note: what the gate refuses and where, what stays review, and
   `Witnessed:`.
5. Cut each guide bullet the gate now enforces in full, and narrow each one
   it enforces in part. Move a cut bullet's witnesses to the gate note.
6. Report the row, its gate and the red proof, each edit, and any part left
   for another owner. For a type or architecture gate, name the planned gate
   and the source path for the code owner.

Done when each item holds:

- `bun run test:area template -t "<rule id>"` passes for a template rule and
  `bun run test:area kernel -t "<rule id>"` for a kernel rule, or
  `bun run faults <id>` prints `KILLED`, or the report hands a type or
  architecture gate to the code owner.
- `bun run lint`, `bun run typecheck` and `bun run format:check` exit 0.
- `bun run test:area standards` passes.
- No guide bullet restates what the gate refuses.
- `git status --porcelain` lists only write-scope paths.

## Weed

Remove what nothing uses any more.

1. List the candidates: each row of the rule table, each bullet in a guide
   under `docs/standards/`, each link definition at the end of
   `CODING_STANDARDS.md` or a guide, and each path that `AGENTS.md` or a
   `SKILL.md` points to.
2. Decide which candidates are in use:
   - A row is in use when its guide or gate note cites a witness, or its
     Gates cell names a gate.
   - A guide bullet is in use unless a gate note says a gate refuses, in
     full, what the bullet teaches.
   - A link definition is in use when text in the same file cites its label.
   - A pointer is in use when its path exists in this repository. Keep a
     pointer into another repository, and report it for its owner.
3. Before you remove a candidate that is not in use, find out why it was
   added. Read its witness with `git show <sha>`, or find the commit that
   added it with `git log -S'<its text>' -- <file>`. When the reason still
   applies, keep it. When you find no reason, keep it and report it.
4. Remove each candidate that is left. Then test each link definition again,
   and remove each one whose last citing text you removed. Commit nothing:
   the caller approves a removal by committing it.
5. Report each removal with why it was added and the command and output
   that show nothing uses it. Report what you kept and why.
6. Report each row or guide bullet that names a path, a command or a rule id
   that is gone from this repository. Leave it in place: retiring a rule that
   has a witness is the caller's decision.

Done when each item holds:

- Each removal is reported with its reason and its proof.
- `bun run test:area standards` passes.
- `bun run format:check` exits 0.
- `git status --porcelain` lists only write-scope paths.
