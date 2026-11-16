# Bun TypeScript Template

## Before work

- Run `bun run doctor`. It checks the Bun pin, the installed toolchain and
  host load, and prints the repair when a check fails. `bun run test` runs it
  first.
- Contract 3 work (`starters/contract3/`, `tests/contract3/`): use the
  `contract3-work` skill.

## Authority

- Frozen Contract 3 text: `agent-engineering` repository, skill
  `agent-cli-design`, `references/contract-3/`. Cite it by that path. Read
  it at published commit `648f93275717d5b031dd4bb4fc67f80cd9940383`.
- Accepted identity: commit `5693651d19c6fba2430c904688e583266dbe58a0`,
  manifest `c162c9850ca506fd839ce36b2b1a8172f064516b0f229dd34a5678b366b02b9d`.
  A path redaction rewrote that history, so the commit is unpublished;
  `references/contract-3/redaction-2026-11-16.md` on that repository's
  `codex/contract-3-foundation` branch maps each frozen commit to its
  published one and lists the two files that differ.
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
- Review: apply `CODING_STANDARDS.md` to the diff; each row names its gate.
