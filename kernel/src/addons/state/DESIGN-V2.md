# State add-on: journal version 2 design, part 1 of 3 (version, layout and moving settled cases)

Status: proposed, not reviewed. This note proposes journal version 2 of the
state add-on. Version 1 is [DESIGN.md](DESIGN.md); it stays frozen and
unchanged, and wherever this note is silent, version 1 holds. Code follows
this note after its review, never the reverse. Nathan decided several of its
points on 19 November 2026 at 12:08; part 3 section 5 lists them apart from
the points still open.

In this note a host is the tool built on the kernel. The machine or virtual
machine a container runs on is the container machine.

- Part 2, [DESIGN-V2-CLOSURE.md](DESIGN-V2-CLOSURE.md): closing a crashed
  case in production.
- Part 3, [DESIGN-V2-CASES.md](DESIGN-V2-CASES.md): the new transitions, the
  proposed cases, the decisions taken and the points still open.

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
  transitions), so one version and one review cover both (decided by Nathan,
  19 November 2026).
- Version 2 fixes the cost of reading: admission and the report stop
  reading settled cases. Deleting old cases is deferred to a later version
  (section 7).

Decided constraints this note keeps:

- Many runs may share one process, but each run is still one transaction and
  one proof (Nathan, 19 November 2026). Version 2 adds no second transaction
  to a run: moving is storage maintenance under the admission lock.
- A separate change hands the work function `{ operationId }`. It changes
  nothing in this design.

## 2. Section map

| Version 1 section       | Version 2                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scope and owners     | Keeps.                                                                                                                                      |
| 2. Durability boundary  | Keeps.                                                                                                                                      |
| 3. Storage layout       | Changes: adds `settled/` (section 4). `format` is replaced once at the upgrade; version 1 says written once (section 3).                    |
| 4. Record framing       | Keeps the framing. Changes 4.1 (section 3). Adds `settledAt` (section 7) and `boot` (part 2).                                               |
| 5. Read rule            | Changes which folders each route reads (section 5).                                                                                         |
| 6. Conflict scope       | Keeps.                                                                                                                                      |
| 7. Coordination         | Keeps both routes. 7.1 gains a step (section 6). 7.2 changes (part 2).                                                                      |
| 8. Effect recording     | Keeps the steps. Adds: no append after the final event (part 2 section 4).                                                                  |
| 9. Approval consumption | Keeps.                                                                                                                                      |
| 10. Qualification gate  | Changes (part 2).                                                                                                                           |
| 11. Transitions         | Keeps X01 to X22. Adds X23 to X30 (part 3). Some frozen cases change with version 2 code, others when a first row lands (part 3 section 2). |
| 12. Interface           | Keeps; no new host call. `capabilities()` reports matched facts (part 2).                                                                   |
| 13. Open points         | Keeps them. Adds part 3 section 5.                                                                                                          |

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
  `operations/` only and write nothing.
- The first changing command of any version 2 program upgrades the store,
  with no opt-in (decided by Nathan, 19 November 2026). The step (X23),
  under the admission lock: create `settled/` and flush the root, stage the
  new format record, rename it over `format`, flush the root. This is the
  one time `format` is replaced. Two upgraders write the same bytes, so the
  step is idempotent.
- The upgrade is one way, and that has a rollback cost. After it a version 1
  program refuses every route on that store, its report included. A tool
  rolled back to a version 1 release can no longer read its own state.
- A version 1 run already in flight at the upgrade finishes normally: its
  records are valid version 2 records, and a later admission moves its case.
- Nothing holds back the upgrade of a root that several installed programs
  share: the first version 2 program to run a changing command upgrades it,
  and the version 1 programs then refuse.
- Any other `journal` value refuses every route.

## 4. Layout (changes section 3)

```text
<root>/
  format                     journal "contract3.state.2"
  coordination/              unchanged
  operations/<operationId>/  every unresolved case, and settled cases not yet moved
  settled/<operationId>/    settled cases, same files, moved by one rename(2)
  staging/                   private work area; unchanged
```

- A case enters `settled/` only when it holds a valid settling record: a
  valid closure, or its own `completion` or `not-applied` with no damaged
  closure.
- The move renames the folder within the root. No byte changes, so the
  journal revision and every closure's `journalRevision` stay valid.
- Moves go one way: `operations/` to `settled/`.

## 5. Read rule (changes section 5)

The per-case status rules 1 to 5 are unchanged. Version 1 calls a case with
a valid closure "resolved by closure", and one with its own valid final
event "resolved by its own run". Version 2 calls both a settled case, the
kernel glossary's term (decided by Nathan, 19 November 2026); the statuses
keep their names, `completed`, `not-applied` and `closed`. What changes is
where each route looks:

| Route                                                        | Reads                                  |
| ------------------------------------------------------------ | -------------------------------------- |
| Admission (7.1 step 4), live holder, unfinished report       | `operations/` only                     |
| History, closure target lookup, a closing case's observation | `operations/<id>`, then `settled/<id>` |

- Read routes take no coordination lock, so a case can move while it is
  read. A missing `closure` is normal, so a missing file alone cannot show a
  move. The rule: a case read from `operations/<id>` counts only if that
  folder still exists after its last file was read. Otherwise it has moved,
  so it is settled. The report skips it. A route that looks in both folders
  reads it again, once, from `settled/<id>`, under the same rule. A case in
  neither place is not found. Moves go one way, so a folder that exists
  after the reads existed during them, and looking in `operations/` first
  never misses a case; the reverse order could.
- A corrupt case in `operations/` refuses admission and the report, as in
  version 1. History now reads only the case asked for, so a corrupt other
  case no longer refuses it; version 1 read every case first. A corrupt
  case in `settled/` refuses only its own history; admission and the report
  never read it (open point C). A case reached `settled/` only
  after a valid settling record was read under coordination, and nothing
  writes there, so later damage is outside the durability boundary of
  version 1 section 2: a process crash cannot tear a flushed, linked record.
- A closing case observes its target's closure. This is in the code today
  (`closureObservation`), not in the version 1 note. It now looks in both
  folders; its values do not change.

## 6. Moving a settled case (adds a step to 7.1)

An admission moves settled cases it read at step 4. It does so after its
own publication (step 6) and before it releases the admission lock (step 7).
A refused admission never reaches that point, so a refusal moves nothing.

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

Then: rename `operations/<id>` to `settled/<id>`. After the last rename,
flush `operations/` and `settled/` once. rename(2) would replace an empty
folder already at `settled/<id>`, so the mover first checks that nothing is
there, and leaves the case where it is if something is. Every mover holds
the admission lock, so nothing comes between the check and the rename.

- At most 64 moves per hold of the admission lock, as the default (decided
  by Nathan, 19 November 2026): 64 renames and two directory flushes.
  Version 1 sizes the 2,000 ms wait for a hold of milliseconds, and this
  keeps it there. A backlog, such as a just-upgraded version 1 store, drains
  over later admissions. The number has no contract source, and its cost is
  not measured yet.
- The owner does not move its own case at transaction end (open point R).
  That would add an admission lock wait to the end of every transaction. A
  crash between the final event and the move leaves a settled case in `operations/`; it is not
  listed, and the next admission moves it.
- A later run renames an earlier run's folder but writes no record and no
  byte (open point B).

## 7. Deferred: deleting old cases

Version 2 does not delete cases. Deleting old cases, a `prune` host call,
its transitions and cases, and the change to Command Contract 3 it needs
are deferred to a later version (decided by Nathan, 19 November 2026).
REC-4 says "Keep the original intent and closure history readable" and
DISC-14 item 3 says the report "never deletes history", so deletion first
needs an accepted decision with the Command Contract 3 records (owner Linear
MAG-98). Moving keeps every case readable, so it needs none.

So a later version has an age to read, version 2 adds `settledAt` (wall
clock, milliseconds) to `completion`, `not-applied` and closure records,
written by the run entitled to write them. A version 1 case has none.

Points this note found that the later version must answer:

- Who may call it, so an inspect command never changes state (CMD-4,
  CMD-10a).
- The age of a version 1 case, which has no `settledAt`.
- Keeping the target of a crashed closer, which is closed later by
  observing that target's closure.
- What history and a same-identity closure retry answer for a deleted case.
