# check:commits

`bun run check:commits <base> [head]` checks every commit in `base..head`
(after the fixed point in `repository.json`) in its own worktree with its own
install, typecheck and lint. It prints a verdict per commit and refuses the
branch when any commit is red at its own head. The `commits` CI job runs it on
every pull request.

## Sub-features

- `commits-green` prints `GREEN <short sha> <subject>` per commit and exits 0.
- `commits-red` prints `RED`, the failed step, a repair and a rerun command,
  and exits 1.
- `commits-empty` refuses a range with no commits.
- `commits-usage` refuses a call with no base.
- `commits-doctor` refuses to start when the doctor fails (see
  [Doctor](doctor.md)).

## How to get to it (user POV)

- Run `bun run check:commits origin/main` in a template clone before opening
  a pull request.
- Paste the `Rerun locally:` line a red verdict prints.

## Driving it with session.sh

Preconditions:

- A launched run; `doctor` passes; `git status --porcelain` in `template` is
  empty.

- **Green.** Commit one good change, such as the commit hook's green, then
  record `commits-green` in `template`: `bun run --silent check:commits HEAD~1`.
  Exit 0; stdout ends `GREEN <sha> <subject>` and
  `Checked 1 commits: all green in <s> s, <s> s per commit.`
- **Red.** Record `commits-partial` in `template`, which commits a type error
  through the hook by fixing it only in the working tree:
  `cp src/recipe.ts ../recipe.keep && sed -i.bak "54s/checkCommand: \"bun run check\",/checkCommand: 1,/" src/recipe.ts && rm src/recipe.ts.bak && git add -- src/recipe.ts && cp ../recipe.keep src/recipe.ts && rm ../recipe.keep && git commit -q -m "refactor(recipe): stage a broken line" && git add -- src/recipe.ts && git commit -q -m "fix(recipe): restore the check command"`.
  Exit 0: the hook let both commits land. Then record `commits-red`:
  `bun run --silent check:commits HEAD~2`. Exit 1; stdout holds
  `RED <sha> refactor(recipe): stage a broken line`,
  `Failed: bun run typecheck`,
  `Repair: change <sha> itself so that bun run typecheck passes at that commit.`,
  `Rerun locally: CHECK_COMMITS_SINCE='<fixed point>' bun run check:commits '<sha>^@' <sha>`,
  `src/recipe.ts(54,5): error TS2322: Type 'number' is not assignable to type 'string'.`,
  `GREEN <sha> fix(recipe): restore the check command` and
  `1 of 2 commits are red in <s> s, <s> s per commit.`
- **Red, empty.** Record `commits-red-empty`:
  `bun run --silent check:commits HEAD`. Exit 1; stdout ends
  `No commits in HEAD..HEAD to check, so this gate checks nothing. Repair: name a base that HEAD is ahead of.`
- **Red, usage.** Record `commits-red-usage`: `bun run --silent check:commits`.
  Exit 2; stderr `Usage: bun run check:commits <base> [head]`.
- **Planted fault.** Record `commits-fault`:
  `bun run --silent fault-replay 8d55f96-check-commits`. Exit 0 and
  `KILLED 8d55f96-check-commits`.
- **After.** Record `commits-after`: `git status --porcelain` and
  `git -C . worktree list`. Clean, and only the clone itself is listed.

## Gotchas

- Each commit costs a full install, typecheck and lint: about 10 s on a Mac.
  Keep the range to the commits the recipe made.
- Line 54 of `src/recipe.ts` holds the first `checkCommand` today. When the
  red's `sed` changes nothing, the commit is empty and fails; pick the line
  `grep -n checkCommand src/recipe.ts` shows.
- `--help` is read as the base and fails inside `git rev-list`, which prints
  git's own usage and exits 2.
- Commits at or before `checkCommitsSince` in `repository.json` are never
  checked. A base older than it checks fewer commits than `base..head` holds.
