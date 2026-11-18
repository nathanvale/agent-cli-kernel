# Check command

A durable generated repository's check command, `bun run check`, runs lint,
format check, typecheck, tests and Fallow in that order, stops at the first
step that fails, and names the mistake. It is the only gate a generated
repository ships: it has no git hooks and no CI.

## Sub-features

- `check-green` passes on a fresh generated repository.
- `check-lint` refuses a lint error, including the repository-local
  `repository/no-domain-output` rule.
- `check-format` refuses a file Biome would reformat, without rewriting it.
- `check-type` refuses a type error.
- `check-test` refuses a failing test.
- `check-fallow` refuses an unused export.
- `check-unguarded` shows that `git commit` alone refuses nothing.

## How to get to it (user POV)

- Run `bun run check` in the generated repository, as its `AGENTS.md` names.
- Run one step alone: `bun run lint`, `format:check`, `typecheck`, `test` or
  `quality:fallow`.

## Driving it with session.sh

Preconditions:

- [Bootstrap](bootstrap.md)'s durable green and ready bullets have run, so
  `generated/durable` has a first commit, an install and a passing check.
- Commit the scaffold so each red can restore one file. Record
  `check-commit` in `generated/durable`:
  `git add -- $(git ls-files --others --exclude-standard) && git commit -q -m "feat: generated scaffold"`.
  `git status --porcelain` is then empty.

Each red plants one mistake, runs the check, restores the file and keeps the
check's exit code:
`<plant>; bun run check; status=$?; git checkout -- <file>; exit $status`.

- **Green.** Record `check-green`: `bun run check`. Exit 0; stderr lists the
  five steps from `$ eslint . --max-warnings 0` to `$ bun test`; stdout ends
  with Fallow's JSON, `"verdict":"pass"`.
- **Red, lint.** Record `check-red-lint`. Plant: append
  `export function leak(): void { process.stdout.write("leak"); }` to
  `src/domains/status.ts`. Exit 1; stdout holds
  `error  Return domain data to the CLI output owner instead of accessing process streams  repository/no-domain-output`;
  stderr ends `error: script "lint" exited with code 1`.
- **Red, format.** Record `check-red-format`. Plant: replace `src/index.ts`
  with the one line ``export function greet(name:string):string{return `Hello, ${name}!`}``.
  Its command hashes the file around the check:
  `<plant>; before=$(shasum src/index.ts); bun run check; status=$?; [ "$(shasum src/index.ts)" = "$before" ] && echo "check left src/index.ts unchanged"; git checkout -- src/index.ts; exit $status`.
  Exit 1; stderr holds `Formatter would have printed the following content:`
  and `error: script "format:check" exited with code 1`; stdout holds
  `check left src/index.ts unchanged`.
- **Red, type.** Record `check-red-type`. Plant: in `src/index.ts` replace the
  returned template string with `name.length`. Exit 1; stdout holds
  `src/index.ts(2,3): error TS2322: Type 'number' is not assignable to type 'string'.`
- **Red, test.** Record `check-red-test`. Plant: change `Hello, ` to `Hi, ` in
  `src/index.ts`. Exit 1; stderr holds
  `(fail) greet returns a greeting for the given name` and
  `Received: "Hi, World!"`.
- **Red, Fallow.** Record `check-red-fallow`. Plant: append
  `export const unused = 1;` to `src/index.ts`. Exit 1; stdout's JSON has
  `"verdict":"fail"` and an `unused_exports` entry for `unused`.
- **Unguarded commit.** Record `check-unguarded`: plant the type error, then
  `git commit -q -am "feat: break greet" && git log --oneline -1`. Exit 0: the
  commit lands. Restore with
  `git revert --no-edit HEAD` and confirm `bun run check` passes again.
- **After.** Record `check-after`: `git status --porcelain && git log --oneline`.
  Clean, with only the commits this recipe made.

## Gotchas

- The check stops at the first failing step, so plant one mistake per run. A
  second mistake hides behind the first.
- Bootstrap copies the starter's tests, so `bun test` runs 31 tests, not one.
- Fallow needs a real Node.js on `PATH`; see [Bootstrap](bootstrap.md#gotchas).
- The scratch profile's check is `bun run typecheck && bun run test` only; a
  lint, format or Fallow mistake passes it by design.
- No fault record patches `profiles/`. `tests/template/bootstrap/bootstrap-cli.test.ts` runs
  lint, format and type reds against a generated repository, but fault replay
  never proves those tests catch a step dropped from the profile's `check`
  script. Run this recipe's reds after changing a profile.
