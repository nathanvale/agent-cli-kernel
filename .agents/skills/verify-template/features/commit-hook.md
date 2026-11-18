# Commit hook

The template's pre-commit hook refuses a commit whose staged files break a
gate: a name the names check refuses, a Biome format difference, a lint error
such as a comment, a type error in the working tree, or a new Fallow problem.
Each refusal ends with its repair and how to know it is done. `bun install`
turns the hook on through the `prepare` script.

## Sub-features

- `hook-installed` points `core.hooksPath` at `.githooks` after install.
- `hook-green` lets a well-named, formatted, lint-clean commit land.
- `hook-name` refuses a staged new file whose name uses an Avoid word.
- `hook-lint` refuses a staged comment that the comment rule forbids.
- `hook-fallow` refuses a staged change that leaves an export unused.
- `hook-partial` lets a commit land whose staged file has a type error that
  the working tree has already fixed (a known gap that
  [check:commits](check-commits.md) catches).

## How to get to it (user POV)

- Run `git commit` in a template clone after `bun install --frozen-lockfile`.
- Run `bun run check:names --staged` to judge the staged names alone.

## Driving it with session.sh

Preconditions:

- A launched run; `doctor` passes; `git status --porcelain` in `template` is
  empty.

- **Installed.** Record `hook-installed` in `template`:
  `git config --get core.hooksPath`. Exit 0; stdout `.githooks`.
- **Red, name.** Record `hook-red-name`:
  `printf "# Note\n" > docs/allowlist.md && git add -- docs/allowlist.md && git commit -q -m "docs: add a note"; status=$?; git rm -q --cached -- docs/allowlist.md; rm docs/allowlist.md; exit $status`.
  Exit 1; stderr holds
  `docs/allowlist.md uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.`
  and
  `pre-commit: the names check failed on the staged names (above). Repair: rename each name it lists as its line says, using git mv so the old name leaves the commit too, and commit again. Done when bun run check:names --staged passes.`
- **Red, lint.** Record `hook-red-comment`:
  `printf "// Note: explain the recipe\n" >> src/recipe.ts && git add -- src/recipe.ts && git commit -q -m "refactor(recipe): explain"; status=$?; git restore --staged -- src/recipe.ts; git checkout -- src/recipe.ts; exit $status`.
  Exit 1; stderr holds `error  A comment reads as permission, and the next agent builds on it.`
  and `pre-commit: lint errors above. Repair: correct each one in code, stage the change, and commit again. Done when bun run lint passes.`
- **Red, Fallow.** Record `hook-red-fallow`: rename `UNCOPIED_NAMES` to
  `SKIPPED_NAMES` with `sed` in `src/recipe.ts`, `src/bootstrap.ts` and
  `tests/recipe.test.ts`, stage only `src/recipe.ts`, and commit. Exit 1;
  stderr lists `Unused exports (1)` with `:34 SKIPPED_NAMES` and
  `pre-commit: fallow found new problems in the staged changes (above).`
  Restore with `git restore --staged -- src/recipe.ts` and
  `git checkout -- src/recipe.ts src/bootstrap.ts tests/recipe.test.ts`.
- **Green.** Record `hook-green`:
  `printf "# Verify note\n\nA note the verification run commits.\n" > docs/verify-note.md && git add -- docs/verify-note.md && git commit -q -m "docs: add a verification note" && git log --oneline -1`.
  Exit 0; stdout names the new commit.
- **Planted fault.** Record `hook-fault`:
  `bun run --silent fault-replay d2034aa-pre-commit c6ccbf5-check-names-refusal`.
  Exit 0; both `KILLED`.
- **After.** Record `hook-after`: `git status --porcelain`. Empty after each
  red, so a refusal left nothing staged.

## Gotchas

- The hook runs `tsc` on the working tree, not on what is staged. Staging a
  broken file and then fixing it unstaged commits the broken version; see
  [check:commits](check-commits.md) for the recipe and the gate that refuses
  it.
- ESLint, oxlint and Fallow run only when a staged path ends in `.ts`, `.mts`,
  `.cts` or `.mjs`. A Markdown-only commit runs the names check and Biome
  alone.
- The names check reads the glossary and recorded hits git has staged, not the
  working tree copies.
- Bypassing the hook proves nothing. Every red here goes through `git commit`
  with the hook installed.
