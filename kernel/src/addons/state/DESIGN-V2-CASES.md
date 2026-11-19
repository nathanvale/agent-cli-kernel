# State add-on: journal version 2 design, part 3 of 3 (transitions, proposed cases and open points)

Status: proposed, not reviewed. Read [DESIGN-V2.md](DESIGN-V2.md) (part 1)
and [DESIGN-V2-CLOSURE.md](DESIGN-V2-CLOSURE.md) (part 2) first. Version 1,
[DESIGN.md](DESIGN.md), stays frozen and unchanged, and its transitions X01
to X22 keep their numbers.

## 1. Transitions X23 to X33

A crash at the boundary in the second column leaves the durable state in the
third. The last column names proposed cases, and two frozen pending ones
(K08.c, O06.a).

| Id  | Transition                                          | Crash at boundary leaves                                                             | Cases                      |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| X23 | store upgraded to version 2                         | a version 1 store (an empty `resolved/` and a staged file are ignored), or version 2 | J08.a, J08.b               |
| X24 | resolved case moved under the admission lock        | the case in exactly one folder; resolved either way; never listed                    | L07.a, L07.c, L07.d, L07.e |
| X25 | read route meets a moving case                      | nothing written                                                                      | L08.a                      |
| X26 | prune selection                                     | nothing written                                                                      | L09.a, L09.b, L09.c        |
| X27 | pruned case renamed into staging                    | case gone from `resolved/`; history not found; leftover ignored                      | L09.d, L09.e               |
| X28 | pruned files deleted                                | partial leftover in staging, ignored; the next prune removes it                      | L09.d                      |
| X29 | closure retried after the case moved                | the prior disposition, read from `resolved/`                                         | K10.a                      |
| X30 | environment facts read and matched against the rows | nothing written                                                                      | Q02.a, Q02.b, Q02.c, Q02.d |
| X31 | `delegate-admitted` appended with the boot identity | listed; closure refused on the same boot                                             | K08.c, O06.a, K11.a        |
| X32 | stopped-owner condition evaluated after a torn tail | nothing written                                                                      | K11.c, K11.d               |
| X33 | closure linked under a production row               | valid closure stamped with the row's `id`                                            | Q02.e                      |

## 2. What changes in the frozen case table

The case table in `tests/kernel/state/cases.ts` is frozen at 125 rows, with
pinned counts, families and pending identities. This note proposes rows and
adds none. They join the table only with version 2 code, and the pins change
in that same review.

- K08.c and O06.a leave the pending list: they become executable as the
  same-boot refusal of part 2 section 5.
- Q01.a (the production table is empty) and O10.a (production closure is
  unavailable) hold until a first row lands. The review that adds a row
  rewords both to "where no row matches". Until then version 1's X17 keeps
  its cases.
- X11 keeps its cases and its event gains `boot`. Its boundary text,
  "runtime stop proof refused", now holds on the same boot only.
- O07.b, O08.a, H01.a and H03.a stay pending. Their reason names a reviewed
  row, but they need reclaim or takeover, which version 2 does not include;
  the review that adds a row rewords the reason.
- X12 keeps its cases and gains K11.e.
- Case Q01.c pins exactly 22 transition rows in `DESIGN.md`. The rows above
  live in this file, so that pin is extended to it with version 2 code.
- L07.b, K11.b, K11.f and Q03.a prove rules, not transitions, and map to
  none. K11.a extends frozen K08.b to a matching row and a missing `boot`.

## 3. Proposed cases

Pruning and the version meeting (part 1):

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
| L09.a-prune-age-edges                    | The last retained and the first pruned case on each side of the age.                                               | Off by one on the age.                         |
| L09.b-prune-keeps-protected              | Unresolved, damaged, corrupt and closer-named cases are never pruned.                                              | Prune by age alone.                            |
| L09.c-prune-limit                        | Never more than `limit` per call, nor more than 64 per hold of the admission lock.                                 | Ignore the limit (planted fault).              |
| L09.d-prune-crash-points                 | Killed after the rename and mid-delete: history not found, nothing else changes, the next prune clears leftovers.  | Delete in place.                               |
| L09.e-pruned-history-not-found           | History of a pruned case is not found; a closing case observing it reports `unobservable`.                         | Report `absent` for a pruned target.           |
| K10.a-retry-after-move                   | A retried closure after the move returns the prior disposition; after pruning, not found.                          | Look up the target in `operations/` only.      |

Closure in production (part 2):

| Proposed id                        | Observation                                                                                                                                                                                      | Red                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Q02.a-release-major-edges          | Another release in the same major matches; the next major refuses with the observed facts.                                                                                                       | Match the exact release, or none (planted fault).              |
| Q02.b-filesystem-mismatch-refused  | A state root on a filesystem the row does not name refuses with the observed facts; no closure.                                                                                                  | Trust the row's name without reading the root (planted fault). |
| Q02.c-route-mismatch-refused       | A row for another coordination route does not match.                                                                                                                                             | Ignore `primitive`.                                            |
| Q02.d-unreadable-fact-refuses      | An unreadable filesystem or boot identity refuses; nothing is written.                                                                                                                           | Treat unreadable as matching.                                  |
| Q02.e-production-row-closes        | Under a production row a crashed case closes as completed and as not-applied, stamped with the row `id`.                                                                                         | Stamp a fixture label.                                         |
| Q03.a-row-cites-run-record         | Every production row cites a committed record that matches it, marked `facts: "observed"`, with every required case passed and a named review.                                                   | Accept a hosted run link, or a record made with overrides.     |
| K11.a-delegate-same-boot-refused   | A killed run with a delegate start, same boot or no `boot`: closure refuses even with a matching row.                                                                                            | Treat a free lease as proof.                                   |
| K11.b-delegate-other-boot-closes   | With a boot identity that differs (test entry), the same case closes.                                                                                                                            | Compare process identifiers instead.                           |
| K11.c-torn-tail-closes             | Killed mid-append with a free lease: closes as completed on `present`; `not-applied` on `absent` refuses.                                                                                        | Refuse every torn tail.                                        |
| K11.d-corrupt-events-still-refuses | Bytes after the damage: closure refuses as unavailable.                                                                                                                                          | Read corruption as a torn tail.                                |
| K11.e-no-append-after-final-event  | A `record` left pending when work returns appends nothing after the final event, and its `admitStart` refuses.                                                                                   | Append outside the lease (planted fault).                      |
| K11.f-second-container-closer      | Separate evidence step, not in the qualification command: a live owner in one container refuses a closer in a second container on the same volume; once the owner is killed, that closer closes. | Decide by the closer's own process view.                       |

## 4. Test entry

The labelled test entry (`fixture.ts`) takes only a fixture label today. It
gains two seams: a candidate row, and overrides for the environment facts
(the release, the state root's filesystem and the boot identity).

- The qualification command uses the candidate row seam only. It refuses to
  run when any fact override is set, and its record says `facts: "observed"`.
- Cases Q02.a to Q02.d and K11.b use the overrides, in the test suite only.
- A closure the test entry enables is stamped `fixture:<label>`, as today,
  and `capabilities()` still reports `fixture-only`.

## 5. Open points for the review

Each is one decision with one recommendation.

- 0: One note covers both items. Nathan has not confirmed it; the design
  proceeds on that assumption. Recommend yes: both reopen the same frozen
  sections.
- A: Age source. Recommend a new `resolvedAt` in resolving records, with
  `owner.startedAt` only for version 1 cases. Version 1 says `startedAt` is
  for people; retention is not a safety decision, but it is a decision.
- B: REC-4 says a later run may not invent a record "on the original run's
  behalf". Recommend the move is allowed: it writes no record or byte, keeps
  the revision, and needs a valid resolving record already present.
- C: Recommend a corrupt case in `resolved/` does not refuse admission or the
  report; its history refuses and prune keeps it.
- D: Deleting history. REC-4 says "Keep the original intent and closure
  history readable" and that a same-identity closure retry "returns its prior
  disposition"; DISC-14 item 3 says the report "never deletes history".
  Options: no deletion, so only the move lands and `resolved/` grows without
  bound; or an accepted decision with the Command Contract 3 records (owner
  Linear MAG-98) for a host-set retention, after which history and a retry
  answer not found. Recommend the accepted decision. Prune code waits for
  it; the move does not.
- E: Recommend an old program may not open a new store: version 1 refuses a
  version 2 store.
- F: Recommend at most 64 moves per hold of the admission lock.
- G: Coordination lock files (`k-<h>.lock`) still grow with each distinct
  conflict key. Unlinking one is unsafe (two holders on two inodes). Recommend
  a documented limit, outside version 2.
- H: Who may call `prune`. It deletes durable state, so an inspect command
  or `ifNoResult` that called it would change state from a read-only command
  (DISC-14 item 1, REC-3). Options: a documented rule only, which is simplest
  and enforced by nothing; or `prune` takes the recorded-effect capability,
  so it runs only inside a changing command's recorded effect. The second is
  enforced by the capability a program start already needs, but each prune
  run is journaled, and one that crashes leaves an unresolved case that
  blocks later prune runs until it is closed. Recommend the capability.
- I: A macOS row needs a foreign call (`statfs`, `sysctlbyname`) in one
  confined Darwin module with a start-up self-check, as `linux-flock.ts` is
  for Linux, and the lint ban widened by that file. Recommend leaving it out
  of version 2's first delivery: Linux in a container is the target, and
  Darwin keeps handing off until someone wants the row.
- J: What "major release" means on Linux. It is the kernel's major number,
  in a container the host kernel's. That number carries no compatibility
  promise and spans years of kernels; the start-up self-check, the
  filesystem type and the evidence run are what protect a closure. Options:
  major only, as decided, so a row survives host kernel updates; or major
  and minor, which is tighter but hands off after every minor kernel update
  until a new run and row. Recommend major only, with the exact release
  recorded on the row.
- K: Closing after a delegated start. Today's design leaves such a case
  unclosable until the host restarts; restarting the container is not
  enough. Options: host restart only, which fails safe; a delegate lease the
  program inherits (part 2 section 5.1), which closes on the same boot but
  fails unsafe for a program that closes inherited descriptors, and reopens
  CMD-14 and case C01.e; or a container restart as proof, which holds only
  when a state root is tied to one container, and the add-on cannot show
  that. Recommend host restart only for version 2, after Y is answered. A
  version 1 delegated case stays unclosable.
- L: Recommend a free lease is enough after a torn tail, once no append can
  follow the final event (part 2 section 4).
- M: Recommend the run record lives at
  `tests/kernel/state/qualification/<row id>.json`.
- N: Which host kernel and which volume filesystem the real containers run
  on. `linux-7-btrfs` is only the worked example, from the one environment
  observed (an OrbStack container on a Mac). A deployment on another host
  kernel major, or on a volume on ext4 or XFS, matches no row and still
  hands off. Recommend the first row and its evidence run target the real
  deployment once Nathan names it.
- O: Recommend no row for the container's writable layer: state kept there is
  lost with the container, so a tool should keep its state root on a volume.
- P: The boot identity names no machine (REC-7 asks identity to distinguish
  "host/boot identity"). Recommend listing a state root moved between
  machines as unsupported in each row's `failureCases`, not recording a
  machine identity: inside a container the readable one belongs to the image
  and would refuse every case after the container is rebuilt.
- Q: When a version 1 store is upgraded. Either way the upgrade is one way:
  afterwards a version 1 program refuses every route, its report included,
  so a tool rolled back to a version 1 release cannot read its state.
  Options: automatic, at the first changing route of any version 2 program,
  which needs no host work but removes the way back at the first changing
  command after an update; or explicit, by a state add-on factory option or
  a host call, so a host can ship version 2, confirm it, then upgrade. The
  explicit form costs a version 2 program that still runs on a version 1
  store (no moves, no prune) and a step a host can forget. Recommend
  explicit.
- R: Recommend the owner does not move its own case at transaction end; the
  next admission does.
- S: Recommend a row names its review by reviewer, date and verdict.
- T: Whether a record written on the hosted `ubuntu-latest` runner and then
  committed is evidence. Recommend no for now: that runner is unobserved
  (version 1 section 7), it changes without notice, and the first row needs
  none.
- U: Matching also on the coordination route and a readable boot identity,
  beyond the three facts decided. Recommend yes: both can only refuse more.
- V: Two containers sharing one state root. REC-7b's proposed boundary is
  "the same host and namespace". Options: a row claims it only when it cites
  a passed K11.f record, a separate step that needs a container runtime; or
  every row lists it under `failureCases`. Recommend the first: the lease
  and the boot identity are the host kernel's and no proof uses a process
  view.
- W: A closing case whose target is in neither folder reports
  `unobservable`, where the code today reports `absent`. Recommend yes.
- X: No append after the final event: `record` and `admitStart` refuse once
  the transaction has ended. This changes today's code for a work function
  that does not await. Recommend yes; closing after a torn tail depends on
  it.
- Y: Whether tools of this kind start a program inside a recorded effect, or
  reach outside work through a long-lived link that records no start. Only
  the first writes `delegate-admitted`, so only it meets K's limit. Recommend
  Nathan answers this before K: if no program starts inside an effect, the
  limit never applies.
