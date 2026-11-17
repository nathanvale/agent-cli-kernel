# Template verification map

This folder is the maintained source for verifying the template's user-facing
behaviour. It follows the journey a new user takes: Bootstrap a generated
repository, run its check command, commit, and have the gates refuse
mistakes. Read this index before driving, then use the matching feature file
as the recipe.

## Baseline preconditions

- A run root launched by [the session helper](../SKILL.md#launch), with
  `ready:` printed and the commit under test named.
- `session.sh doctor "$run"` passes.
- Bun matches the toolchain pin in every helper call.
- Drive only a run root this session launched.

## Driving conventions

- `$skill`, `$run` and the record command are as the
  [session](../SKILL.md#session) defines them. Each recipe's commands run
  through `"$skill/scripts/session.sh" record "$run" <name> <folder> '<command>'`.
- Start each recipe from the state its preconditions name. Recipes that change
  the clone restore it before they end.
- `$packet` is any absolute path or HTTP(S) URL without user data, such as
  `https://example.test/vault/projects/verify/`.
- Commands are literal. Keep quoted names and flags unchanged.

## Proof and skip reporting

- Report the transcript names for each green and red with the feature and
  sub-feature IDs they prove.
- A gate proof shows the refusal text, the repair line and the exit code.
- A state change proof shows a second, read-only view: `ls`, `git log`,
  `git status --porcelain`.
- Report an unreachable sub-feature with the command tried and the unmet
  precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph naming the claim a
user relies on. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with session.sh` starts with `Preconditions:` and uses labelled
   bullets, each pairing a user action with an exact command, the record name
   and the observable result. **Green** and **Red** bullets carry the proof;
   **Planted fault** names the fault record to replay.
4. `Gotchas` lists traps that waste or invalidate a run.

## Features

- [Bootstrap](bootstrap.md) creates a generated repository from a profile and
  refuses unsafe or contradictory requests.

## Not mapped yet

The map covers the journey above. These entry points have no recipe; add one
before claiming them verified.

- `bun run fault-replay` and `bun run planted-fault:add`: the map uses fault
  replay as its red engine, but no recipe proves its own verdicts.
- `bun run check:names` given paths or `--tool-call`, and the Claude Code and
  Codex names check hooks that call it.
- The pre-push hook.
- `bun run admit:cli` and `bun run admit:static`.
- `bun run test:area` and the template's own `bun run check`, `lint`,
  `lint:anti-slop`, `format`, `format:check`, `typecheck` and
  `quality:fallow`.
- The generated repository's own CLI beyond `bun run start --help`.
- `bootstrap --starter simple` and `--starter complex`, left out while
  `starters/` is set to be removed ([MAG-129]).
- `kernel/` and its CLI, which the kernel's own map owns.

[MAG-129]: https://linear.app/myagentdojo/issue/MAG-129
