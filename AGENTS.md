# Bun TypeScript Template

## Before work

- Run `bun run doctor`. It names the repair for each failed check, and
  `bun run test` runs it first.
- Contract 3 work (`kernel/`, `tests/kernel/`): use the
  `contract3-work` skill.
- After an operator correction or a review finding, to gate a rule row, or
  to weed the rule table: use the `repo-gardener` skill.

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
- Accepted decisions: code and tests cite them in comments that say
  "accepted decision", with a contract question number, an ID such as `N4a`,
  or the ruling date. Each one settles a point the frozen text leaves open,
  so keep the behaviour at a cited decision. Their record is the MAG-98
  findings ledger under Coordination context.
- Glossary: before you name a file, a folder, a test or a commit, open
  `GLOSSARY-MAP.md`. It points to the glossary that owns each word.

## Coordination context

These private planning records live outside this repository. Your task brief
supplies the parts your task may use. If your task needs a record that the
brief does not supply, report it as missing context with its identity and
owner from this list.

- Foundation specification and Contract 3 decision record, in the
  `my-second-brain-playground` repository:
  `projects/cli-design-skill/specs/contract-3-foundation.md` and
  `projects/cli-design-skill/contract-3-decision-log.md`. Owner: Linear
  MAG-98.
- Scope, open findings, and accepted decisions: Linear MAG-98 and its findings
  ledger. Owner: Linear MAG-98.
- Shared vocabulary: "Agent ecosystem glossary (living)" in Linear. Owner:
  Engineering, through Linear MAG-64.

## Checks

- Full suite and timing-sensitive cases: run them on hosted CI or on the test
  host your task brief names. `bun run doctor` warns when this host is too
  loaded.
- CI's `commits` job checks each commit at its own head, and its `faults` job
  replays the planted faults. To reproduce a red one, run
  `bun run check:commits <base>` or `bun run faults <id>`.
- Review: apply `CODING_STANDARDS.md` to the diff; each row names its gate.
