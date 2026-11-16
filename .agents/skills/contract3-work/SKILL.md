---

name: contract3-work
description: Build, repair, or review Contract 3 code in `starters/contract3/` or `tests/contract3/`. Use when changing either folder or reviewing a diff that touches it.
---

# Contract 3 work

Paths below are from the repository root. These owners hold the rules; cite
them rather than restating them:

- [AGENTS.md authority](../../../AGENTS.md#authority): frozen Contract 3 text,
  foundation spec, findings ledger, glossary.
- [CODING_STANDARDS.md](../../../CODING_STANDARDS.md): the rule table, its
  gates, and the review routine.
- [docs/standards/](../../../docs/standards/): the judgement guide each rule
  row links.

Take **Build** when you write or repair code, **Review** when you judge a
diff.

## Build

1. Run `bun run doctor`. Continue once it exits 0; on a failed check, apply
   the repair it prints and rerun.
2. Prove each case you add or change with
   `bun run test:area <area> -t "<case id>"`. `bun run test:area` alone lists
   the areas.
3. For each new refusal or bound, follow
   [planted faults](../../../docs/standards/test-proof.md#planted-faults):
   the named test goes **red** on the fault and green on restore, and the
   commit body carries the `RED:` line.
4. Send the full suite and timing-sensitive cases to hosted CI (every pull
   request) or the Mac mini gate. This repository does not record the Mac
   mini gate route: ask the coordinator for it.

Done when each item holds at the pushed head:

- `bun run doctor` exits 0.
- Every added or changed case has a green focused run.
- Every new refusal or bound has a `RED:` line naming its fault and test.
- Hosted CI is green, or each case it did not run is reported **unproved**.
  An unproved case is never reported as a pass.

## Review

1. Read the diff and the commit bodies in its range (`git log <base>..<head>`).
2. Run the [review routine](../../../CODING_STANDARDS.md#review-routine)
   over every row of the rule table. Open each guide a touched Review only or
   Partial row links, and apply every bullet.
3. For each new refusal or bound in the diff, find its `RED:` line. A missing
   line is a finding on the planted-fault row.

Report each finding as `row | guide bullet | file:line | what breaks`.

Done when the report lists every rule-table row once, as findings, clear, or
untouched with the reason, and names each guide it opened.
