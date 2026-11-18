# Commit hook

The template's pre-commit hook refuses a commit whose staged files break a
gate: a name the names check refuses, a Biome format difference, a lint error
such as a comment, a type error in the staged tree, a file over the token
limit, or a new Fallow problem.
Each refusal ends with its repair and how to know it is done. `bun install`
turns the hook on through the `prepare` script.

## Sub-features

- `hook-installed` points `core.hooksPath` at `.githooks` after install.
- `hook-green` lets a well-named, formatted, lint-clean commit land.
- `hook-name` refuses a staged new file whose name uses an Avoid word.
- `hook-lint` refuses a staged comment that the comment rule forbids.
- `hook-fallow` refuses a staged change that leaves an export unused.
- `hook-staged-type` checks the staged tree for commits that stage changes to
  `.ts`, `.mts`, `.cts` or `.mjs` paths or to files matching `tsconfig*.json`
  at any depth, including removals. The staged-type recipes use partial staging.
- `hook-file-size` checks staged changes against the file-size limit.

## How to get to it (user POV)

- Run `git commit` in a template clone after `bun install --frozen-lockfile`.
- Run `bun run check:names --staged` to judge the staged names alone.
- Run `bun run check:file-size --staged` to judge the staged file sizes alone.

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
- **Red, staged type.** Record `hook-red-staged-type` in `template`.

  ```sh
  set -eu
  path=src/recipe.ts
  candidate="$run/work/recipe-with-type-error"
  sed 's/checkCommand: "bun run check[^"]*",/checkCommand: 1,/' "$path" > "$candidate"
  cmp_status=0
  cmp -s "$path" "$candidate" || cmp_status=$?
  test "$cmp_status" -eq 1 || exit 2
  cp "$candidate" "$path"
  git add -- "$path"
  git restore --worktree --source=HEAD -- "$path"
  before=$(git rev-parse HEAD)
  status=0
  git commit -q -m "test(recipe): try to commit a type error" || status=$?
  test "$(git rev-parse HEAD)" = "$before"
  git show ":$path" | grep -F 'checkCommand: 1,'
  git restore --staged -- "$path"
  exit "$status"
  ```

  Exit 1; TypeScript prints `TS2322` and the hook prints
  `pre-commit: TypeScript rejected the staged tree (above). Repair: fix the type errors and stage the repaired files. Done when git commit passes the staged type check.`
  HEAD still names the original commit.
- **Green, staged type.** Record `hook-green-staged-type` after the red.

  ```sh
  set -eu
  path=src/recipe.ts
  candidate="$run/work/recipe-with-valid-type"
  flag=--help
  if grep -qF 'checkCommand: "bun run check --help",' "$path"; then
    flag=--version
  fi
  sed "s/checkCommand: \"bun run check[^\"]*\",/checkCommand: \"bun run check $flag\",/" "$path" > "$candidate"
  cmp_status=0
  cmp -s "$path" "$candidate" || cmp_status=$?
  test "$cmp_status" -eq 1 || exit 2
  cp "$candidate" "$path"
  git add -- "$path"
  cp "$run/work/recipe-with-type-error" "$path"
  git commit -q -m "test(recipe): commit the staged check command"
  git show "HEAD:$path" | grep -F "checkCommand: \"bun run check $flag\","
  cmp "$run/work/recipe-with-type-error" "$path"
  git restore --worktree -- "$path"
  ```

  Exit 0; the commit contains the staged string and the working tree still
  holds the unstaged type error until the recipe restores it.
- **Green, file size.** Record `file-size-green` in `template`.

  ```sh
  set -eu
  path=docs/verify-file-size.txt
  bun -e 'process.stdout.write(" x".repeat(5000))' > "$path"
  git add -- "$path"
  bun run check:file-size
  ```

  Exit 0 at 5,000 tokens.
- **Red, file size.** Record `file-size-red` after that green.

  ```sh
  bun -e 'process.stdout.write(" x".repeat(5001))' > docs/verify-file-size.txt
  bun run check:file-size
  ```

  Exit 1. The refusal names `docs/verify-file-size.txt`, 5,001 tokens, and the
  5,000-token limit.
- **Red, staged file size.** Record `hook-red-file-size` after that red.

  ```sh
  set -eu
  path=docs/verify-file-size.txt
  git add -- "$path"
  staged=$(git rev-parse ":$path")
  bun -e 'process.stdout.write(" x".repeat(5000))' > "$path"
  before=$(git rev-parse HEAD)
  status=0
  git commit -q -m "test(docs): try to commit an oversized file" || status=$?
  if [ "$status" -ne 1 ]; then
    printf 'Expected the hook to refuse with exit 1, got %s.\n' "$status" >&2
    exit 2
  fi
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    printf 'The refused commit changed HEAD.\n' >&2
    exit 2
  fi
  if [ "$(git rev-parse ":$path")" != "$staged" ]; then
    printf 'The refused commit changed the staged file %s.\n' "$path" >&2
    exit 2
  fi
  exit 1
  ```

  Exit 1. The hook names the same refusal and preserves HEAD and the index.
  Exit 2 means the proof failed. After exit 1, the index still holds 5,001
  tokens and the working copy holds 5,000.
- **Green, staged file size.** Record `hook-green-file-size` after that red.
  The first `git add` replaces the oversized staged blob with the working copy.

  ```sh
  set -eu
  path=docs/verify-file-size.txt
  git add -- "$path"
  staged=$(git rev-parse ":$path")
  bun -e 'process.stdout.write(" x".repeat(5001))' > "$path"
  unstaged=$(git hash-object "$path")
  git commit -q -m "test(docs): commit a file at the token limit"
  test "$(git rev-parse "HEAD:$path")" = "$staged"
  test "$(git hash-object "$path")" = "$unstaged"
  git restore --worktree -- "$path"
  git status --porcelain
  ```

  Exit 0. The commit contains the 5,000-token file. The larger working copy
  remains until the recipe restores it.
- **Red, Fallow.** Record `hook-red-fallow`:
  `printf '\nexport const unused = 1;\n' >> src/recipe.ts && git add -- src/recipe.ts && git commit -q -m "test(recipe): add an unused export"; status=$?; git restore --staged --worktree -- src/recipe.ts; exit $status`.
  Exit 1; stderr lists `unused` under `Unused exports (1)` and prints
  `pre-commit: fallow found new problems in the staged changes (above).`
- **Green.** Record `hook-green`:
  `printf "# Verify note\n\nA note the verification run commits.\n" > docs/verify-note.md && git add -- docs/verify-note.md && git commit -q -m "docs: add a verification note" && git log --oneline -1`.
  Exit 0; stdout names the new commit.
- **Planted faults.** Record `hook-fault`:
  `bun run --silent fault-replay d2034aa-pre-commit c6ccbf5-check-names-refusal ea215c9-pre-commit beed83c-pre-commit`.
  Exit 0; all four `KILLED`.
- **After.** Record `hook-after` with `git status --porcelain` after a recipe
  that restores its changes or after the file-size green. Expect empty output.
  The staged file-size red leaves `AM docs/verify-file-size.txt` until the
  file-size green replaces the staged blob and commits.

## Gotchas

- The staged type check uses a temporary checkout of the commit's tree and
  reuses the installed `node_modules`.
- ESLint, oxlint and Fallow run only when a staged path ends in `.ts`, `.mts`,
  `.cts` or `.mjs`. A Markdown-only commit runs the names check, file-size
  gate, and Biome.
- The names check reads the glossary and recorded hits git has staged, not the
  working tree copies.
- Bypassing the hook proves nothing. Every red here goes through `git commit`
  with the hook installed.
