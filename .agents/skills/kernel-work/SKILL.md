---

name: kernel-work
description: Build, repair, or review kernel code in `kernel/` or `tests/kernel/`. Use when changing either folder or reviewing a diff that touches it.
---

# Kernel work

Paths below are from the repository root. These owners hold the rules; follow
each pointer rather than a copy:

- [AGENTS.md authority](../../../AGENTS.md#authority): frozen Contract 3 text,
  accepted decisions, and glossary terms.
- [AGENTS.md coordination context](../../../AGENTS.md#coordination-context):
  private planning records your task brief supplies.
- [AGENTS.md checks](../../../AGENTS.md#checks): focused runs and where the
  full suite runs.
- [CODING_STANDARDS.md](../../../CODING_STANDARDS.md): the rule table, its
  gates, and the review routine.
- [docs/standards/](../../../docs/standards/): the judgement guide each rule
  row links.

Take **Build** when you write or repair code, **Review** when you judge a
diff.

## Build

1. Run `bun run doctor` until it exits 0, applying each repair it prints.
2. Prove each case you add or change with a focused run from
   [AGENTS.md checks](../../../AGENTS.md#checks).
3. For each new refusal or bound, apply the
   [planted-fault guide](../../../docs/standards/planted-faults.md#planted-faults).
4. Send the full suite and timing-sensitive cases where
   [AGENTS.md checks](../../../AGENTS.md#checks) sends them.
5. Before changing `kernel/src/addons/state/*.ts` (except
   `capability-qualification-table.ts`), `kernel/src/addons/programs/*.ts` or
   `kernel/src/kernel/state-seam.ts`, read the
   [record fields](../../../kernel/src/addons/state/DESIGN-V2-CLOSURE.md) and
   the [`Q03.a` row](../../../kernel/src/addons/state/DESIGN-V2-TRANSITIONS.md).
   Any such change alters the capability qualification row's `sourceHash`, so
   `Q03.a` fails until a new capability qualification record, with Nathan's
   countersignature, lands in the same change.

Done when each item holds at the pushed head:

- `bun run doctor` exits 0.
- Every added or changed case has a green focused run.
- Every new refusal or bound meets the planted-fault guide.
- A change to the qualified source carries its new capability qualification
  record.
- Hosted CI is green, or each case it did not run is reported **unproved**.
  An unproved case is never reported as a pass.

## Review

1. Read the diff and the commit bodies in its range. Planted-fault evidence
   lives in `tests/planted-faults/fault-records/`; judge it against the
   [planted-fault guide](../../../docs/standards/planted-faults.md#planted-faults).
2. Run the [review routine](../../../CODING_STANDARDS.md#review-routine) on
   that diff. Its last step is your report.

Done when every step of the review routine is complete for the diff.
