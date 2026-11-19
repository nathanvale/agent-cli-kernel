# State add-on: journal version 2 design, part 3 of 3 (transition table and the cases that prove it)

Status: accepted (Nathan, 19 November 2026, 13:21 AEDT). Read
[DESIGN-V2.md](DESIGN-V2.md) (part 1)
and [DESIGN-V2-CLOSURE.md](DESIGN-V2-CLOSURE.md) (part 2) first. Version 1,
[DESIGN.md](DESIGN.md), stays frozen and unchanged, and its transitions X01
to X22 keep their numbers.

## 1. Transitions X23 to X30

A crash at the boundary in the second column leaves the durable state in the
third. The last column names proposed cases, and two frozen pending ones
(K08.c, O06.a).

| Id  | Transition                                          | Crash at boundary leaves                                                            | Cases                      |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| X23 | store upgraded to version 2                         | a version 1 store (an empty `settled/` and a staged file are ignored), or version 2 | J08.a, J08.b               |
| X24 | settled case moved under the admission lock         | the case in exactly one folder; settled either way; never listed                    | L07.a, L07.c, L07.d, L07.e |
| X25 | read route meets a moving case                      | nothing written                                                                     | L08.a                      |
| X26 | closure retried after the case moved                | the prior disposition, read from `settled/`                                         | K10.a                      |
| X27 | environment facts read and matched against the rows | nothing written                                                                     | Q02.a, Q02.b, Q02.c, Q02.d |
| X28 | `delegate-admitted` appended with the boot identity | listed; closure refused on the same boot                                            | K08.c, O06.a, K11.a        |
| X29 | stopped-owner condition evaluated after a torn tail | nothing written                                                                     | K11.c, K11.d               |
| X30 | closure linked under a production row               | valid closure stamped with the row's `id`                                           | Q02.e                      |

Deleting old cases, and its transitions and cases, are deferred to a later
version (part 1 section 7).

## 2. What changes in the frozen case table

The case table in `tests/kernel/state/cases.ts` is frozen at 125 rows, with
pinned counts, families and pending identities. This note proposes rows and
adds none. They join the table only with version 2 code, and the pins change
in that same review.

- K08.c and O06.a leave the pending list: they become executable as the
  same-boot refusal of part 2 section 5.
- Q01.a (the production capability qualification table is empty) and O10.a
  (production closure is unavailable) hold until a first row lands. The
  review that adds a row rewords both to "where no row matches". Until then
  version 1's X17 keeps its cases.
- X11 keeps its cases and its event gains `boot`. Its boundary text,
  "runtime stop proof refused", now holds on the same boot, or when the
  event has no `boot`.
- O07.b, O08.a, H01.a and H03.a stay pending. Their reason names a reviewed
  row, but they need reclaim or takeover, which version 2 does not include;
  the review that adds a row rewords the reason.
- X12 keeps its cases and gains K11.e.
- Case Q01.c pins exactly 22 transition rows in `DESIGN.md`. The rows above
  live in this file, so that pin is extended to it with version 2 code.
- L07.b, L07.f, L07.g, J08.c, K11.b, Q02.f, Q03.a and Q03.b prove rules, not
  transitions, and map to none.
  K11.a extends frozen K08.b to a matching row and a missing `boot`.

## 3. Proposed cases

The version meeting and moving settled cases (part 1):

| Proposed id                              | Observation                                                                                                                                                                                                                                                                                              | Red                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| J08.a-v1-program-refuses-v2-store        | A version 1 reader refuses every route on a version 2 store.                                                                                                                                                                                                                                             | Mark version 2 by an added field only.                             |
| J08.b-upgrade-crash-points               | Killed before and after the format rename: version 1 or version 2; no case lost or relisted.                                                                                                                                                                                                             | Rewrite `format` in place.                                         |
| J08.c-settled-at-written                 | `completion`, `not-applied` and closure records carry `settledAt`; a version 1 reader still reads them.                                                                                                                                                                                                  | Omit `settledAt`.                                                  |
| L07.a-settled-moved-not-listed           | After a completed run and the next admission, the case is in `settled/` with the same revision; history finds it.                                                                                                                                                                                        | Change bytes when moving.                                          |
| L07.b-admission-does-not-read-settled    | With `settled/` unreadable (non-root), admission and the report succeed; that case's history refuses.                                                                                                                                                                                                    | Read `settled/` at admission (planted fault).                      |
| L07.c-crash-between-final-event-and-move | Killed after the final event: not listed, the next overlapping change proceeds and moves it.                                                                                                                                                                                                             | List a settled case kept in `operations/`.                         |
| L07.d-move-skips-live-or-closing         | A case whose lease or `case:` coordination lock is held stays in `operations/`. A refused admission moves nothing.                                                                                                                                                                                       | Move under a closer.                                               |
| L07.e-move-bound                         | 65 settled cases: one admission moves 64, the next moves 1.                                                                                                                                                                                                                                              | Unbounded moves (planted fault).                                   |
| L07.f-examination-bound                  | 128 ineligible settled cases ahead of one eligible case in name order, and no new case settled in between. The test entry fixes the start and reports how many cases a hold examined: from the front, one hold examines 128 and moves none; from any other start, the next hold moves the eligible case. | Examine without a bound, or always from the front (planted fault). |
| L07.g-failed-move-keeps-outcome          | A rename that fails after publication: the transaction runs and reports its own effects, the admission lock is released, the case stays settled in `operations/`.                                                                                                                                        | Refuse the admission on a failed move (planted fault).             |
| L08.a-reader-races-move                  | Report and history during moves: a closed case is never listed, an existing case is never corrupt or not found.                                                                                                                                                                                          | Trust a read whose folder has gone.                                |
| K10.a-retry-after-move                   | A retried closure after the move returns the prior disposition.                                                                                                                                                                                                                                          | Look up the target in `operations/` only.                          |

Closure in production (part 2):

| Proposed id                                     | Observation                                                                                                                                                                                                                                                                                                                            | Red                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q02.a-release-major-edges                       | Another release in the same major matches; the next major refuses with the observed facts.                                                                                                                                                                                                                                             | Match the exact release, or none (planted fault).                                                                                                                       |
| Q02.b-filesystem-mismatch-refused               | A state root on a filesystem the row does not name refuses with the observed facts; no closure.                                                                                                                                                                                                                                        | Trust the row's name without reading the root (planted fault).                                                                                                          |
| Q02.c-route-mismatch-refused                    | A row for another coordination route does not match.                                                                                                                                                                                                                                                                                   | Ignore `primitive` (planted fault).                                                                                                                                     |
| Q02.d-unreadable-fact-refuses                   | An unreadable filesystem or boot identity refuses; nothing is written.                                                                                                                                                                                                                                                                 | Treat unreadable as matching (planted fault).                                                                                                                           |
| Q02.e-production-row-closes                     | Run on the pilot from the row's branch, through `index.ts` with the row in the production table: a crashed case closes as completed and as not-applied, stamped with the row `id`, and the stopped-owner families of the first capability qualification run pass again.                                                                | Stamp a fixture label.                                                                                                                                                  |
| Q02.f-nested-mount-refused                      | A store folder on a mount nested under the state root refuses closure with the observed facts.                                                                                                                                                                                                                                         | Check only the root (planted fault).                                                                                                                                    |
| Q03.a-row-cites-capability-qualification-record | Every production row cites a committed capability qualification record that matches it, marked `factSource: "observed"`, holding both capability qualification runs with every required case passed and a `sourceHash` equal to the current qualified source, and names its reviewing session, Nathan's countersignature and the date. | Accept a hosted run link, a record made with overrides, a record for changed source, or a record without the `index.ts` run (planted fault).                            |
| Q03.b-capability-qualification-run-refuses      | `bun run capability-qualification-run` refuses a dirty tree, and refuses when any fact override is set; it writes no capability qualification record.                                                                                                                                                                                  | Run with an override (planted fault).                                                                                                                                   |
| K11.a-delegate-same-boot-refused                | A killed run with a delegate start, same boot or no `boot`: closure refuses even with a matching row.                                                                                                                                                                                                                                  | Treat a free lease as proof.                                                                                                                                            |
| K11.b-delegate-other-boot-closes                | With a boot identity that differs (test entry), the same case closes.                                                                                                                                                                                                                                                                  | Compare process identifiers instead.                                                                                                                                    |
| K11.c-torn-tail-closes                          | Killed mid-append with a free lease: closes as completed on `present`; `not-applied` on `absent` refuses.                                                                                                                                                                                                                              | Refuse every torn tail.                                                                                                                                                 |
| K11.d-corrupt-events-still-refuses              | Bytes after the damage: closure refuses as unavailable.                                                                                                                                                                                                                                                                                | Read corruption as a torn tail.                                                                                                                                         |
| K11.e-transaction-waits-for-started-effects     | A `record` left pending when work returns or throws settles before the final event, with the lease still held; a `record` or `admitStart` called after work returns refuses; a failed final append still leaves the transaction ended.                                                                                                 | Three planted faults: release the lease while a started effect runs; accept a call after work returns; mark the transaction ended only after the final append succeeds. |

## 4. Test entry

The labelled test entry (`fixture.ts`) takes a fixture label, an observation
hook and a C library name today. It gains three seams: a candidate row;
overrides for the environment facts (the release, the state root's filesystem
and the boot identity); and the mover's start place, with a count of the
cases each hold examined (case L07.f).

- The capability qualification run uses the candidate row seam only. It
  refuses to run when any fact override is set, and its record says
  `factSource: "observed"`.
- Cases Q02.a, Q02.b, Q02.d and K11.b use the overrides, and Q02.c a
  candidate row, in the test suite only.
- A closure the test entry enables is stamped `fixture:<label>`, as today,
  and `capabilities()` still reports `fixture-only`.
