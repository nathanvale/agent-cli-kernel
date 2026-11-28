# Source layout

Keep a CLI flat (`src/cli.ts`, `src/commands.ts` and peer files) while it has
one **subject** (one multi-word route prefix, ignoring single-word commands
such as `status`). Move to subject folders when you declare a second subject,
and turn on the Fallow boundary gate in the same change.

## Folder shape and imports

- Keep only `src/cli.ts` and `src/commands.ts` at `src/` root; put every other
  file in a subject, `shared/` or `commands/` folder, including a single-word
  command that has its own file, at `src/<command>/<command>.ts`
  (`coverage.requireAllFiles` refuses unzoned files).
- To split the contract built in `src/commands.ts` across files, put the
  extra files in `src/commands/`; command files stay in their subject folders.
  Fallow's `entry` zone holds `src/cli.ts`, `src/commands.ts` and
  `src/commands/**`: an entry file may import other entry files, subjects,
  `src/shared/` and `rules.ts`, and only an entry file may import an entry
  file. The folder name `commands` is reserved: name no subject `commands`,
  or its files become entry files that may import every subject.
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
  verb is `rules` another file name. Pure logic that one subject owns and
  other subjects read, such as a table, goes in that subject's `rules.ts`.
- Put cause tables, settings, file writes, program adapters and the types
  they share in **shared edges** under `src/shared/`. Logic two or more
  subjects use goes there too when it cannot be a `rules.ts`: it imports a
  shared edge, no one subject owns it, or it would push that `rules.ts` past
  the file size check. A shared edge imports other shared edges and
  `rules.ts`, never a command or entry file (Fallow's `shared` zone refuses
  those). The folder name `shared` is reserved: name no subject `shared`, or
  its commands become importable by every subject.

## Packages that export commands

A package that exports commands for other CLIs to mount exposes factory
functions and its host cause table:

- Parameterize each command factory by the mounting CLI's `cli` name so its
  command identities (`<cli>.<name>`) and command-step targets belong to the
  mounting CLI.
- Parameterize each changing command factory by the mounting CLI's `state`
  add-on and by the report command's identity as a literal type parameter
  (`<const Report extends string>`). Pass `state.descriptor.ifNoResult` to
  `changing({...})`, and build handoff `inspect` steps as
  `{ kind: "command", command: report, args: [] }` instead of reusing
  `state.descriptor.ifNoResult.step` (whose `command` is widened to `string`,
  which `contractFor` rejects at compile time). `contractFor` throws at
  start-up if a changing command carries `ifNoResult` from a different state
  add-on descriptor.
- Export the package's host cause rows (`as const satisfies CauseTable`) so
  the mounting CLI merges them into
  `contractFor({ causes: { ...commonCauses, ...packageCauses, ...cliCauses } })`.
  Prefix cause codes with the package or subject name: `contractFor` checks
  each declared station's row against the merged `causes` table and throws
  `Station disagrees with the CLI cause owner.` when a station's row was
  overwritten by a different row, whereas a differing row that no declared
  station uses is silently overwritten by the spread.
- Keep command factories in their subject folders (`src/<subject>/<verb>.ts`)
  and re-export them from entry files (`src/commands.ts` or
  `src/commands/**`). Place cross-subject or commandless library code that
  imports shared edges in `src/shared/`, and pure logic with no `src/shared/`
  or I/O imports in `src/<subject>/rules.ts`.

## Tests

- Drive command tests through the command line or the contract built in
  `src/commands.ts`, never through a subject's internal files, so moving files
  breaks no tests (`bun run quality:fallow` flags dead exports).

## Boundary gate

Add to `.fallowrc.json` when moving (`"rules": { "boundary-violation": "error" }` plus `"boundaries"`):

A file belongs to the first zone that matches it. Put these zones before any
existing zone that matches `src/**`, and remove or narrow that zone, or it
takes every file and the gate refuses nothing.

- `zones`: `{ "name": "entry", "patterns": ["src/cli.ts", "src/commands.ts", "src/commands/**"] }`, `{ "name": "rules", "patterns": ["src/**/rules.ts"] }`, `{ "name": "shared", "patterns": ["src/shared/**"] }`, `{ "name": "subject", "patterns": ["src/*/**"], "autoDiscover": ["src"] }`.
- `rules`: `{ "from": "entry", "allow": ["entry", "rules", "shared", "subject"] }`, `{ "from": "rules", "allow": ["rules"] }`, `{ "from": "shared", "allow": ["rules"] }`, `{ "from": "subject", "allow": ["rules", "shared"] }`.
- The `shared` zone is named by pattern, so these settings load before `src/shared/` exists.
- `coverage`: `{ "requireAllFiles": true, "allowUnmatched": ["tests/**", "config/**", "eslint.config.mjs"] }`.

Check a file's allowed imports before editing with `node_modules/.bin/fallow guard <file>`, and verify seams with `node_modules/.bin/fallow architecture --boundaries --fail-on-issues` (run by `bun run check` when its Fallow step uses these settings).
