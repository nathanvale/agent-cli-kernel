# Bun TypeScript Template

## Before work

- Run `bun run doctor`. It checks the Bun pin, the installed toolchain and
  host load, and prints the repair when a check fails. `bun run test` runs it
  first.
- Contract 3 work (`starters/contract3/`, `tests/contract3/`): use the
  `contract3-work` skill.

## Authority

These public sources define the product contract this repository implements.

- Frozen Contract 3 text: `agent-engineering` repository, skill
  `agent-cli-design`, `references/contract-3/`. Cite it by that path. Read
  it at published commit `648f93275717d5b031dd4bb4fc67f80cd9940383`.
- Accepted identity: commit `5693651d19c6fba2430c904688e583266dbe58a0`,
  manifest `c162c9850ca506fd839ce36b2b1a8172f064516b0f229dd34a5678b366b02b9d`.
  A path redaction rewrote that history, so the commit is unpublished;
  `references/contract-3/redaction-2026-11-16.md` on that repository's
  `codex/contract-3-foundation` branch maps each frozen commit to its
  published one and lists the two files that differ.
- Accepted decisions: code and tests cite them as "Accepted decision" with a
  contract question number or an ID such as `N4a`. Each one settles a point
  the frozen text leaves open, so keep the behaviour at a cited decision.
  Their record is the decision log under Coordination context.
- Glossary terms: `tests/glossary/term-table.json` lists the terms this
  repository checks and the glossary snapshot they follow. The glossary test
  in `tests/glossary/` enforces them.

## Coordination context

These private planning records live outside this repository. Your task brief
supplies the parts your task may use. If your task needs a record that the
brief does not supply, report it as missing context with its identity and
owner from this list.

- Foundation specification and decision log:
  `projects/cli-design-skill/specs/contract-3-foundation.md` in the
  `my-second-brain-playground` repository. Owner: Linear MAG-98.
- Scope, open findings, and accepted decisions: Linear MAG-98 and its findings
  ledger. Owner: Linear MAG-98.
- Shared vocabulary: "Agent ecosystem glossary (living)" in Linear. Owner:
  Engineering, through Linear MAG-64.

## Checks

- Focused: `bun run test:area <area>`. Run it without an area to list the
  areas; extra arguments reach `bun test`, so `-t "<case id>"` works.
- Full suite and timing-sensitive cases: run them on hosted CI or on the test
  host your task brief names, not on a loaded laptop. `bun run doctor` warns when
  this host is too loaded.
- Review: apply `CODING_STANDARDS.md` to the diff; each row names its gate.
