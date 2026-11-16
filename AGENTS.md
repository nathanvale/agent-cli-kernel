# Bun TypeScript Template

## Before work

- Run `bun run doctor`. It checks the Bun pin, the installed toolchain and
  host load, and prints the repair when a check fails. `bun run test` runs it
  first.

## Authority

- Frozen Contract 3 text: `agent-engineering` repository, skill
  `agent-cli-design`, `references/contract-3/` at commit
  `5693651d19c6fba2430c904688e583266dbe58a0`. Cite it by that path.
- Foundation spec and decision log: vault
  `projects/cli-design-skill/specs/contract-3-foundation.md`.
- Open findings and owner decisions: Linear MAG-98 and its findings ledger.
- Glossary: Linear "Agent ecosystem glossary";
  `tests/glossary/term-table.json` records the date it follows.

## Checks

- Focused: `bun run test:area <area>`. Run it without an area to list the
  areas; extra arguments reach `bun test`, so `-t "<case id>"` works.
- Full suite and timing-sensitive cases: the Mac mini gate or hosted CI, never
  a loaded laptop. `bun run doctor` warns when this host is too loaded.
