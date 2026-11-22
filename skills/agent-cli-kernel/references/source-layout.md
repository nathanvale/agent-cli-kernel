# Source layout

Keep a CLI flat (`src/cli.ts`, `src/commands.ts` and peer files) while it has
one **subject** (one multi-word route prefix, ignoring single-word commands
such as `status`). Move to subject folders when you declare a second subject,
and turn on the Fallow boundary gate in the same change.

## Folder shape and imports

- Keep only `src/cli.ts` and `src/commands.ts` at `src/` root; put every other
  file in a subject or `shared/` folder, including a single-word command that
  has its own file, at `src/<command>/<command>.ts`
  (`coverage.requireAllFiles` refuses unzoned files).
- Put one command per file in `src/<subject>/<verb>.ts` for route
  `[<subject>, <verb>]`, keeping `input` and `stations` beside `run`.
- Extract I/O shared by commands in one subject to a sibling file in that
  folder; never import one command file from another (Fallow's `subject` zone
  refuses another subject's command file and allows its `rules.ts`; review
  holds within one subject).
- Keep pure rules in `src/<subject>/rules.ts` with no filesystem, git, state or
  `src/shared/` imports (Fallow's `rules` zone refuses project imports outside
  `rules`; the kernel's lint refuses process spawns; a direct `node:fs` import
  is left to review). The name `rules.ts` is reserved: give a command whose
  verb is `rules` another file name.
- Put cause tables, settings, file writes, program adapters and the types
  they share in **shared edges** under `src/shared/`. A shared edge imports
  other shared edges and `rules.ts`, never a command or entry file
  (`subject/shared` refuses those). The folder name `shared` is reserved: name
  no subject `shared`, or its commands become importable by every subject.

## Tests

- Drive command tests through the command line or the contract built in
  `src/commands.ts`, never through a subject's internal files, so moving files
  breaks no tests (`bun run quality:fallow` flags dead exports).

## Boundary gate

Add to `.fallowrc.json` when moving (`"rules": { "boundary-violation": "error" }` plus `"boundaries"`):

A file belongs to the first zone that matches it. Put these zones before any
existing zone that matches `src/**`, and remove or narrow that zone, or it
takes every file and the gate refuses nothing.

- `zones`: `{ "name": "entry", "patterns": ["src/cli.ts", "src/commands.ts"] }`, `{ "name": "rules", "patterns": ["src/**/rules.ts"] }`, `{ "name": "subject", "autoDiscover": ["src"] }`.
- `rules`: `{ "from": "entry", "allow": ["entry", "rules", "subject"] }`, `{ "from": "rules", "allow": ["rules"] }`, `{ "from": "subject", "allow": ["rules", "subject/shared"] }`, `{ "from": "subject/shared", "allow": ["rules"] }`.
- `coverage`: `{ "requireAllFiles": true, "allowUnmatched": ["tests/**", "config/**", "eslint.config.mjs"] }`.

Check a file's allowed imports before editing with `node_modules/.bin/fallow guard <file>`, and verify seams with `node_modules/.bin/fallow architecture --boundaries --fail-on-issues` (run by `bun run check` when its Fallow step uses these settings).
