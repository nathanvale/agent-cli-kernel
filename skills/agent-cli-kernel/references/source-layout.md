# Source layout

Keep a CLI flat (`src/cli.ts`, `src/commands.ts` and peer files) while it has
one **subject** (one multi-word route prefix, ignoring single-word commands
such as `status`). Move to subject folders when you declare a second subject,
and turn on the Fallow boundary gate in the same change.

## Folder shape and imports

- Keep only `src/cli.ts` and `src/commands.ts` at `src/` root; put every other
  file in a subject or `shared/` folder, including single-word commands at
  `src/<command>/<command>.ts` (`coverage.requireAllFiles` refuses unzoned files).
- Put one command per file in `src/<subject>/<verb>.ts` for route
  `[<subject>, <verb>]`, keeping `input` and `stations` beside `run`.
- Extract I/O shared by commands in one subject to a sibling file in that
  folder; never import one command file from another (Fallow's `subject` zone
  refuses cross-subject imports; review holds within one subject).
- Keep pure rules in `src/<subject>/rules.ts` with no filesystem, git, state or
  `src/shared/` imports (Fallow's `rules` zone refuses imports outside `rules`;
  the kernel's lint refuses process spawns).
- Put cross-subject types, cause tables, settings, file writes and program
  adapters in **shared edges** under `src/shared/`, importing only `rules.ts`
  and never a command or entry file (`subject/shared` refuses other imports).

## Tests

- Drive command tests through `src/cli.ts` rather than internal `src/` imports,
  so moving files breaks no tests (`bun run quality:fallow` flags dead exports).

## Boundary gate

Add to `.fallowrc.json` when moving (`"rules": { "boundary-violation": "error" }` plus `"boundaries"`):

- `zones`: `{ "name": "entry", "patterns": ["src/cli.ts", "src/commands.ts"] }`, `{ "name": "rules", "patterns": ["src/**/rules.ts"] }`, `{ "name": "subject", "autoDiscover": ["src"] }`.
- `rules`: `{ "from": "entry", "allow": ["entry", "rules", "subject"] }`, `{ "from": "rules", "allow": ["rules"] }`, `{ "from": "subject", "allow": ["rules", "subject/shared"] }`, `{ "from": "subject/shared", "allow": ["rules"] }`.
- `coverage`: `{ "requireAllFiles": true, "allowUnmatched": ["tests/**", "config/**", "eslint.config.mjs"] }`.

Check a file's allowed imports before editing with `node_modules/.bin/fallow guard <file>`, and verify seams with `node_modules/.bin/fallow architecture --boundaries --fail-on-issues` (also run by `bun run check`).
