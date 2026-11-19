# State add-on: journal version 2 design, part 3 of 3 (transitions, proposed cases, decisions and open points)

Status: proposed, not reviewed. Read [DESIGN-V2.md](DESIGN-V2.md) (part 1)
and [DESIGN-V2-CLOSURE.md](DESIGN-V2-CLOSURE.md) (part 2) first. Version 1,
[DESIGN.md](DESIGN.md), stays frozen and unchanged, and its transitions X01
to X22 keep their numbers.

## 1. Transitions X23 to X30

A crash at the boundary in the second column leaves the durable state in the
third. The last column names proposed cases, and two frozen pending ones
(K08.c, O06.a).

| Id  | Transition                                          | Crash at boundary leaves                                                             | Cases                      |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| X23 | store upgraded to version 2                         | a version 1 store (an empty `resolved/` and a staged file are ignored), or version 2 | J08.a, J08.b               |
| X24 | resolved case moved under the admission lock        | the case in exactly one folder; resolved either way; never listed                    | L07.a, L07.c, L07.d, L07.e |
| X25 | read route meets a moving case                      | nothing written                                                                      | L08.a                      |
| X26 | closure retried after the case moved                | the prior disposition, read from `resolved/`                                         | K10.a                      |
| X27 | environment facts read and matched against the rows | nothing written                                                                      | Q02.a, Q02.b, Q02.c, Q02.d |
| X28 | `delegate-admitted` appended with the boot identity | listed; closure refused on the same boot                                             | K08.c, O06.a, K11.a        |
| X29 | stopped-owner condition evaluated after a torn tail | nothing written                                                                      | K11.c, K11.d               |
| X30 | closure linked under a production row               | valid closure stamped with the row's `id`                                            | Q02.e                      |

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
  "runtime stop proof refused", now holds on the same boot only.
- O07.b, O08.a, H01.a and H03.a stay pending. Their reason names a reviewed
  row, but they need reclaim or takeover, which version 2 does not include;
  the review that adds a row rewords the reason.
- X12 keeps its cases and gains K11.e.
- Case Q01.c pins exactly 22 transition rows in `DESIGN.md`. The rows above
  live in this file, so that pin is extended to it with version 2 code.
- L07.b, K11.b and Q03.a prove rules, not transitions, and map to none.
  K11.a extends frozen K08.b to a matching row and a missing `boot`.

## 3. Proposed cases

The version meeting and moving resolved cases (part 1):

| Proposed id                              | Observation                                                                                                        | Red                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| J08.a-v1-program-refuses-v2-store        | A version 1 reader refuses every route on a version 2 store.                                                       | Mark version 2 by an added field only.         |
| J08.b-upgrade-crash-points               | Killed before and after the format rename: version 1 or version 2; no case lost or relisted.                       | Rewrite `format` in place.                     |
| L07.a-resolved-moved-not-listed          | After a completed run and the next admission, the case is in `resolved/` with the same revision; history finds it. | Change bytes when moving.                      |
| L07.b-admission-does-not-read-resolved   | With `resolved/` unreadable (non-root), admission and the report succeed; that case's history refuses.             | Read `resolved/` at admission (planted fault). |
| L07.c-crash-between-final-event-and-move | Killed after the final event: not listed, the next overlapping change proceeds and moves it.                       | List a resolved case kept in `operations/`.    |
| L07.d-move-skips-live-or-closing         | A case whose lease or `case:` coordination lock is held stays in `operations/`. A refused admission moves nothing. | Move under a closer.                           |
| L07.e-move-bound                         | 65 resolved cases: one admission moves 64, the next moves 1.                                                       | Unbounded moves (planted fault).               |
| L08.a-reader-races-move                  | Report and history during moves: a closed case is never listed, an existing case is never corrupt or not found.    | Trust a read whose folder has gone.            |
| K10.a-retry-after-move                   | A retried closure after the move returns the prior disposition.                                                    | Look up the target in `operations/` only.      |

Closure in production (part 2):

| Proposed id                        | Observation                                                                                                                                                                                          | Red                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Q02.a-release-major-edges          | Another release in the same major matches; the next major refuses with the observed facts.                                                                                                           | Match the exact release, or none (planted fault).              |
| Q02.b-filesystem-mismatch-refused  | A state root on a filesystem the row does not name refuses with the observed facts; no closure.                                                                                                      | Trust the row's name without reading the root (planted fault). |
| Q02.c-route-mismatch-refused       | A row for another coordination route does not match.                                                                                                                                                 | Ignore `primitive`.                                            |
| Q02.d-unreadable-fact-refuses      | An unreadable filesystem or boot identity refuses; nothing is written.                                                                                                                               | Treat unreadable as matching.                                  |
| Q02.e-production-row-closes        | Under a production row a crashed case closes as completed and as not-applied, stamped with the row `id`.                                                                                             | Stamp a fixture label.                                         |
| Q03.a-row-cites-run-record         | Every production row cites a committed record that matches it, marked `facts: "observed"`, with every required case passed, and names its reviewing session, Nathan's countersignature and the date. | Accept a hosted run link, or a record made with overrides.     |
| K11.a-delegate-same-boot-refused   | A killed run with a delegate start, same boot or no `boot`: closure refuses even with a matching row.                                                                                                | Treat a free lease as proof.                                   |
| K11.b-delegate-other-boot-closes   | With a boot identity that differs (test entry), the same case closes.                                                                                                                                | Compare process identifiers instead.                           |
| K11.c-torn-tail-closes             | Killed mid-append with a free lease: closes as completed on `present`; `not-applied` on `absent` refuses.                                                                                            | Refuse every torn tail.                                        |
| K11.d-corrupt-events-still-refuses | Bytes after the damage: closure refuses as unavailable.                                                                                                                                              | Read corruption as a torn tail.                                |
| K11.e-no-append-after-final-event  | A `record` left pending when work returns appends nothing after the final event, and its `admitStart` refuses.                                                                                       | Append outside the lease (planted fault).                      |

## 4. Test entry

The labelled test entry (`fixture.ts`) takes only a fixture label today. It
gains two seams: a candidate row, and overrides for the environment facts
(the release, the state root's filesystem and the boot identity).

- The qualification command uses the candidate row seam only. It refuses to
  run when any fact override is set, and its record says `facts: "observed"`.
- Cases Q02.a to Q02.d and K11.b use the overrides, in the test suite only.
- A closure the test entry enables is stamped `fixture:<label>`, as today,
  and `capabilities()` still reports `fixture-only`.

## 5. Decisions and open points

### 5.1 Decided by Nathan, 19 November 2026, 12:08

- 0: One note covers both items.
- A, D and H: Only the move into `resolved/` ships in version 2. Deleting
  old cases, the `prune` host call and the Command Contract 3 change it
  needs (REC-4, DISC-14) are deferred. `resolvedAt` is kept in resolving
  records now, so a later version has an age to read.
- F: At most 64 moves per hold of the admission lock, as the default.
- I: No macOS row for now.
- K: Closure after `delegate-admitted` only after the container machine
  restarts. No same-boot proof in version 2.
- N: The first row is `linux-7-btrfs`, for the pilot `agents-pilot` (an
  OrbStack container on a Mac, a btrfs volume). Its evidence run happens on
  the pilot through a worker session.
- O: No row for a container's own writable layer.
- Q: The store upgrade is automatic, on the first changing command, with no
  opt-in. Its rollback cost stays stated (part 1 section 3).
- S: A separate agent session that wrote none of the code reviews a row, and
  Nathan countersigns it; the row names both and the date.
- V: Sharing one state root between containers is dropped. One state root
  belongs to one machine.
- W: Withdrawn. Without deletion a closing case's target cannot leave both
  folders, so its observation values do not change.

### 5.2 Still open

Each is one decision with one recommendation.

- B: REC-4 says a later run may not invent a record "on the original run's
  behalf". Recommend the move is allowed: it writes no record or byte, keeps
  the revision, and needs a valid resolving record already present.
- C: Recommend a corrupt case in `resolved/` does not refuse admission or the
  report; only its history refuses.
- E: Recommend an old program may not open a new store: version 1 refuses a
  version 2 store. Decision Q's rollback cost rests on this.
- G: Coordination lock files (`k-<h>.lock`) still grow with each distinct
  conflict key. Unlinking one is unsafe (two holders on two inodes). Recommend
  a documented limit, outside version 2.
- J: What "major release" means on Linux. It is the kernel's major number,
  in a container the container machine's. That number carries no
  compatibility promise and spans years of kernels; the start-up self-check,
  the filesystem type and the evidence run are what protect a closure.
  Options: major only, as decided, so a row survives kernel updates; or
  major and minor, which is tighter but hands off after every minor kernel
  update until a new run and row. Recommend major only, with the exact
  release recorded on the row.
- L: Recommend a free lease is enough after a torn tail, once no append can
  follow the final event (part 2 section 4).
- M: Recommend the run record lives at
  `tests/kernel/state/qualification/<row id>.json`.
- P: The boot identity names no machine (REC-7 asks identity to distinguish
  "host/boot identity"). Recommend listing a state root moved between
  machines as unsupported in each row's `failureCases`, not recording a
  machine identity: inside a container the readable one belongs to the image
  and would refuse every case after the container is rebuilt.
- R: Recommend the owner does not move its own case at transaction end; the
  next admission does.
- T: Whether a record written on the hosted `ubuntu-latest` runner and then
  committed is evidence. Recommend no for now: that runner is unobserved
  (version 1 section 7), it changes without notice, and the first row needs
  none.
- U: Matching also on the coordination route and a readable boot identity,
  beyond the three facts decided. Recommend yes: both can only refuse more.
- X: No append after the final event: `record` and `admitStart` refuse once
  the transaction has ended. This changes today's code for a work function
  that does not await. Recommend yes; closing after a torn tail depends on
  it.
- Y: Whether hosts of this kind start a program inside a recorded effect,
  or reach outside work through a long-lived link that records no start.
  Only the first writes `delegate-admitted`, so only it meets decision K's
  limit. Recommend a host whose outside work runs through a long-lived link
  starts that link outside any recorded effect, so no case it leaves records
  a delegate start.
