# State add-on: journal version 2 design, part 1 of 3 (version, layout and pruning)

Status: proposed, not reviewed. This note proposes journal version 2 of the
state add-on. Version 1 is [DESIGN.md](DESIGN.md); it stays frozen and
unchanged, and wherever this note is silent, version 1 holds. Code follows
this note after its review, never the reverse.

- Part 2, [DESIGN-V2-CLOSURE.md](DESIGN-V2-CLOSURE.md): closing a crashed
  case in production.
- Part 3, [DESIGN-V2-CASES.md](DESIGN-V2-CASES.md): the new transitions, the
  proposed cases and every open point.

The note is in three parts by choice, to keep each under 5,000 tokens. The
repository's size check does not cover `kernel/`, so no gate forced it.

Clause tags refer to Command Contract 3 (`agent-engineering`, skill
`agent-cli-design`, `references/contract-3/`). The clauses were read in a
local worktree of that repository (`c3-hardening-review`). The three files
quoted (`recovery.md`, `commands-and-addons.md`, `discovery.md`) were then
compared with published commit `648f93275717d5b031dd4bb4fc67f80cd9940383`
in a local clone and are byte-identical there.

## 1. Why a version 2

- Closed cases pile up. Every admission, report and history call reads every
  case folder (`readStore`), and nothing removes one, so a long-lived tool
  slows down forever.
- Closing a crashed case is unavailable in production. The
  capability qualification table is empty, and even with a row, closure is
  refused after `delegate-admitted` and after a torn events tail.
- Both change frozen sections (layout, read rule, stopped-owner condition,
  transitions), so one version and one review cover both.

Settled constraints this note keeps:

- Many runs may share one process, but each run is still one transaction and
  one proof (Nathan, 19 November 2026). Version 2 adds no second transaction
  to a run: moving is storage maintenance under the admission lock, and
  pruning opens no transaction of its own.
- A separate change hands the work function `{ operationId }`. It changes
  nothing in this design.

## 2. Section map

| Version 1 section       | Version 2                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Scope and owners     | Keeps. Adds the prune host call to what the state add-on owns.                                                            |
| 2. Durability boundary  | Keeps.                                                                                                                    |
| 3. Storage layout       | Changes: adds `resolved/` (section 4). `format` is replaced once at the upgrade; version 1 says written once (section 3). |
| 4. Record framing       | Keeps the framing. Changes 4.1 (section 3). Adds `resolvedAt` (section 7) and `boot` (part 2).                            |
| 5. Read rule            | Changes which folders each route reads (section 5).                                                                       |
| 6. Conflict scope       | Keeps.                                                                                                                    |
| 7. Coordination         | Keeps both routes. 7.1 gains a step (section 6). 7.2 changes (part 2).                                                    |
| 8. Effect recording     | Keeps the steps. Adds: no append after the final event (part 2 section 4).                                                |
| 9. Approval consumption | Keeps.                                                                                                                    |
| 10. Qualification gate  | Changes (part 2).                                                                                                         |
| 11. Transitions         | Keeps X01 to X22. Adds X23 to X33 (part 3). Two frozen cases change when a first row lands (part 3).                      |
| 12. Interface           | Adds `prune(...)`. `capabilities()` reports matched facts (part 2).                                                       |
| 13. Open points         | Keeps them. Adds part 3's open points.                                                                                    |

## 3. How version 1 and version 2 meet (changes 4.1)

- A version 2 store's format record is
  `{ format: 1, kind: "format", journal: "contract3.state.2" }`. The framing
  (`C3S1`, payload `format: 1`) does not change, so every version 1 record
  is a valid version 2 record.
- An old program may not open a new store. A version 1 program accepts only
  `journal: "contract3.state"`, so it refuses every route on a version 2
  store, its report included (DISC-14 item 5). An added field would not do
  this. Version 1's note says any other content refuses, but its code checks
  only the `journal` value and ignores unknown fields, so it would accept
  the store.
- A version 2 program reads a version 1 store as it is: read routes read
  `operations/` only and write nothing. Until the upgrade it also moves
  nothing and `prune` refuses, and what it writes stays readable by a
  version 1 program, which ignores the added fields.
- The upgrade step (X23), under the admission lock: create `resolved/` and
  flush the root, stage the new format record, rename it over `format`,
  flush the root. This is the one time `format` is replaced. Two upgraders
  write the same bytes, so the step is idempotent.
- What triggers the step is open point Q: the first changing route of any
  version 2 program, or only once the host opts in.
- The upgrade is one way, and that has a rollback cost. After it a version 1
  program refuses every route on that store, its report included. A tool
  rolled back to a version 1 release can no longer read its own state.
- A version 1 run already in flight at the upgrade finishes normally: its
  records are valid version 2 records, and a later admission moves its case.
- A root shared by several installed programs is upgraded only after all of
  them run version 2.
- Any other `journal` value refuses every route.

## 4. Layout (changes section 3)

```text
<root>/
  format                     journal "contract3.state.2"
  coordination/              unchanged
  operations/<operationId>/  every unresolved case, and resolved cases not yet moved
  resolved/<operationId>/    resolved cases, same files, moved by one rename(2)
  staging/                   private work area; gains prune-<operationId>
```

- A case enters `resolved/` only when it holds a valid resolving record: a
  valid closure, or its own `completion` or `not-applied` with no damaged
  closure.
- The move renames the folder within the root. No byte changes, so the
  journal revision and every closure's `journalRevision` stay valid.
- Moves go one way: `operations/` to `resolved/` to gone (pruned).

## 5. Read rule (changes section 5)

The per-case status rules 1 to 5 are unchanged. What changes is where each
route looks:

| Route                                                        | Reads                                            |
| ------------------------------------------------------------ | ------------------------------------------------ |
| Admission (7.1 step 4), live holder, unfinished report       | `operations/` only                               |
| History, closure target lookup, a closing case's observation | `operations/<id>`, then `resolved/<id>`          |
| Prune                                                        | `resolved/` names, and `operations/` for closers |

- Read routes take no coordination lock, so a case can move while it is
  read. A missing `closure` is normal, so a missing file alone cannot show a
  move. The rule: a case read from `operations/<id>` counts only if that
  folder still exists after its last file was read. Otherwise the case is
  read again, once, from `resolved/<id>`, under the same rule. A case in
  neither place is not found. Moves go one way, so a folder that exists
  after the reads existed during them, and looking in `operations/` first
  never misses a case; the reverse order could.
- A corrupt case in `operations/` refuses as in version 1. A corrupt case in
  `resolved/` refuses only its own history; admission and the report never
  read it, and prune keeps it (open point C). A case reached `resolved/` only
  after a valid resolving record was read under coordination, and nothing
  writes there, so later damage is outside the durability boundary of
  version 1 section 2: a process crash cannot tear a flushed, linked record.
- A closing case observes its target's closure. This is in the code today
  (`closureObservation`), not in the version 1 note. When the target is in
  neither folder, the observation is `unobservable`, not `absent` as today,
  because prune may have removed it (open point W).

## 6. Moving a resolved case (adds a step to 7.1)

An admission moves resolved cases it read at step 4. It does so after its
own publication (step 6) and before it releases the admission lock (step 7).
A refused admission never reaches that point, so a refusal moves nothing.
Prune also moves (section 7).

A case moves only when all hold:

1. Its status is `completed`, `not-applied` or `closed`, with no damaged
   closure.
2. Its `owner.lease` is free (non-blocking probe).
3. The coordination lock file for `case:<operationId>` is absent, or free.
   That is the key a closer takes for its target; it is in the code today,
   not in the version 1 note. It is opened without create, so moving never
   adds a lock file. Under the
   admission lock no closer can be taking its key locks, so an absent file
   means no closer is active.

Then: rename `operations/<id>` to `resolved/<id>`. After the last rename,
flush `operations/` and `resolved/` once. If `resolved/<id>` already exists
the rename fails and the case stays where it is.

- At most 64 moves per hold of the admission lock: 64 renames and two
  directory flushes. Version 1 sizes the 2,000 ms wait for a hold of
  milliseconds, and this keeps it there. A backlog, such as a just-upgraded
  version 1 store, drains over later admissions and prune calls. The number
  is an engineering number with no contract source, and its cost is not
  measured yet.
- The owner does not move its own case at transaction end (open point R).
  That would add an admission lock wait to the end of every transaction. A crash between the
  final event and the move leaves a resolved case in `operations/`; it is not
  listed, and the next admission moves it.
- A later run renames an earlier run's folder but writes no record and no
  byte (open point B).

## 7. Prune (new host call)

`prune(..., { olderThanMilliseconds, limit })` is on the instance
`stateAddon` returns. It deletes durable state, so it must never run from an
inspect command, which "performs no domain mutation" (CMD-4) and "cannot open
a transaction" (CMD-10a), nor from the `ifNoResult` command (DISC-14 item 1,
REC-3). What it takes to keep that is open point H; each option still opens no second
transaction in a run, and none changes a case's disposition.

1. Delete leftovers `staging/prune-*` (they count toward `limit`).
2. With no coordination lock: list `resolved/` names in name order, read each
   case's resolution time, and select it when
   `now - resolvedAt >= olderThanMilliseconds`, until `limit` are selected.
3. In batches of at most 64, each under one hold of the admission lock: move
   resolved cases (section 6); read `operations/` to collect the `closes`
   target of every unresolved case; rename each selected case that no closer
   names from `resolved/<id>` to `staging/prune-<id>`; flush `resolved/`.
4. With the admission lock released, delete each renamed folder and flush
   `staging/`. The rename is the step a reader sees, so a crash never leaves
   a half-deleted case in `resolved/`.

- Never pruned: an unresolved case (it is never in `resolved/`), a corrupt or
  damaged case (reported as kept), and a case named by an unresolved case's
  `closes`. A closer that crashed after linking its closure is closed later
  by observing that closure, so its target must stay. Every closer publishes
  its case under the admission lock, so step 3 sees all of them.
- `olderThanMilliseconds` is a non-negative integer and `limit` is 1 to
  1,000. Result: `{ ok: true, moved, pruned, keptDamaged, more }` or a
  refusal (`busy`, coordination unavailable, a store read refusal).
  Concurrent prune calls race only on a rename; the loser skips that case.
- Reads are linear in the size of `resolved/`, which pruning keeps near the
  resolution rate times the age. Admission never prunes.
- Resolution time: version 2 adds `resolvedAt` (wall clock, milliseconds) to
  `completion`, `not-applied` and closure records, written by the run entitled
  to write them. A version 1 case has none; its intent's `owner.startedAt` is
  used instead (open point A).
- A wall clock jump prunes early or late. Either way only history is lost;
  protection is not, because only resolved cases are pruned.
- After pruning, history and a same-identity closure retry both answer not
  found. Both touch contract text (open point D).
