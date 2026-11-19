# State add-on: journal version 2 design, part 2 of 3 (closing a crashed case in production)

Status: proposed, not reviewed. Read [DESIGN-V2.md](DESIGN-V2.md) first: it
holds the status, the source of the clause quotes, the section map and the
store format. This part changes version 1 sections 7.2 and 10 of
[DESIGN.md](DESIGN.md), and adds to sections 4.3 and 8. That note stays
frozen and unchanged. The transition table and proposed cases are in
[DESIGN-V2-TRANSITIONS.md](DESIGN-V2-TRANSITIONS.md); the decisions and open
points are in part 1 section 8.

## 1. What changes

Version 1's candidate proof is "lease free and no `delegate-admitted` event
and no torn events tail". It is usable only under a reviewed
capability qualification row, and the capability qualification table is
empty. Version 2's stopped-owner condition for a crashed case is all of:

1. The owner lease is free.
2. The environment matches a production capability qualification row
   (section 2).
3. Every `delegate-admitted` event on the case names a boot identity that
   differs from the current one (section 5). A case with none passes.

A torn events tail no longer refuses (section 4). Lock age, PID presence,
the machine's name and sent signals are still never consulted. Without a
matching row every closure of an unresolved case still hands off, as O10 and
Q01 pin today.

## 2. Matching a row (decided by Nathan, 19 November 2026)

A row matches on the operating system and the major release, not the exact
release string, and the state root's filesystem is checked at run time. The
facts are read at closure time (X27), under the coordination locks, without
starting a program. Linux in a container is the target. A macOS row is left
out for now (decided by Nathan, 19 November 2026). The decision names the
first three facts below. This design adds the last two, which can only
refuse more (open point U).

| Fact                  | Read from                           | Must equal the row's |
| --------------------- | ----------------------------------- | -------------------- |
| Operating system      | `process.platform`                  | `os`                 |
| Major release         | first part of `os.release()`        | `majorRelease`       |
| State root filesystem | type number from `statfsSync(root)` | `filesystem`         |
| Coordination route    | active route of `coordination.ts`   | `primitive`          |
| Boot identity         | `/proc/sys/kernel/random/boot_id`   | readable, not empty  |

- A mismatch or an unreadable fact refuses
  `stopped-owner-proof-unqualified` before any write. The detail carries the
  observed facts and what is qualified, as coordination refusals do.
- The filesystem is read at closure time, not at start-up, because the
  volume under a root can change between runs. `capabilities()` reports the
  same match for its root.
- `statfs` on the root sees only the filesystem holding the root, not a
  mount nested below it. So closure also requires `coordination/`,
  `operations/`, `settled/` and `staging/` to report the root's device
  (`lstat(...).dev`), and refuses with the observed facts when any differs
  (case Q02.f). A bind mount of the same filesystem reports the same
  device; part 1 section 6 covers it.
- Version 1's contract question N3 (unsupported filesystems are not detected)
  still holds for coordination. Only closure gains the check.

### 2.1 Linux in a container

- Major release. A container runs on the container machine's operating-system
  kernel, so `os.release()` inside it is that kernel's release (observed:
  `7.2.12-orbstack-00394-gbecdd6130068`, version 1 section 7). The major
  release is that operating-system kernel's major, `7`. The image's
  distribution and C library are recorded as observed and not matched.
- That number carries no compatibility promise, and one major spans years of
  operating-system kernels. What protects a closure on Linux is the start-up
  self-check of the coordination call, the filesystem type read at closure
  time, and the row's evidence run. Major and minor is the alternative (open
  point J).
- Filesystem. `statfsSync(root).type` reports the filesystem under the root
  however it was mounted, and the numbers are a stable interface:

| The state root sits on                                | Reads as                                                                   | Row                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| A volume                                              | the container machine's local filesystem (btrfs `0x9123683E` on the pilot) | the first row                                |
| A bind mount of a folder on a Linux container machine | that filesystem (ext4 `0xEF53`, XFS `0x58465342`)                          | one row per type, each with its own evidence |
| A bind mount of a folder shared from another system   | a shared type (expected FUSE `0x65735546`; not observed here)              | none: shared filesystems stay unsupported    |
| The container's writable layer                        | overlay `0x794C7630`                                                       | none (decided by Nathan, 19 November 2026)   |
| A network mount                                       | NFS `0x6969` and similar                                                   | none                                         |

- One state root belongs to one machine. Sharing one state root between
  containers is not supported (decided by Nathan, 19 November 2026).
- First row: `linux-7-btrfs`, for the pilot `agents-pilot`: an OrbStack
  container on a Mac, with the state root on a btrfs volume (decided by
  Nathan, 19 November 2026). A deployment on another operating-system kernel
  major, or on a volume on ext4 or XFS, matches no row and still hands off
  until its own run and row.
- Its evidence run happens on the pilot, through a worker session. The state
  root's parent is an argument, so the root is on the volume under test
  while the repository sits anywhere.

## 3. The row and its run record (decided by Nathan, 19 November 2026)

A row cites a committed run record and names its independent review. A hosted
run link is not evidence. A row's run happens on a machine in that major
release. A separate agent session that wrote none of the code reviews the
row, and Nathan countersigns it.

Row fields:

| Field                | Meaning                                                                                                | Matched at run time |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `id`                 | stamped into every closure it enables, for example `linux-7-btrfs`                                     | no                  |
| `os`                 | `linux`                                                                                                | yes                 |
| `majorRelease`       | as section 2                                                                                           | yes                 |
| `observedRelease`    | the exact release string the evidence run observed                                                     | no                  |
| `filesystem`         | `{ name, type }`                                                                                       | yes                 |
| `primitive`          | the coordination route                                                                                 | yes                 |
| `bootIdentitySource` | where the boot identity is read from                                                                   | yes, readable       |
| `processIdentity`    | how a delegated program is identified; version 2: boot identity only                                   | no                  |
| `namespace`          | the user and process view the run used (non-root; in a container)                                      | no                  |
| `delegatedWriters`   | the rule of section 5                                                                                  | no                  |
| `failureCases`       | what the row does not cover                                                                            | no                  |
| `evidence`           | `{ record, review }`: the record's path; the reviewing session, Nathan's countersignature and the date | checked by a test   |

One repeatable command (proposed name `bun run qualify:state`) runs the
stopped-owner cases on the platform and writes the record, in two runs:

- First run: it supplies the candidate row through the labelled test entry,
  a seam that entry gains (part 3 section 4), so its closures are stamped
  `fixture:<label>`. It never touches the production
  capability qualification table. The test proof guide says a proof
  through a test entry "proves only the fixture". That holds for the entry:
  this run proves the platform's mechanisms (the coordination route, the
  lease, the filesystem, crash recovery) under the candidate row.
- Second run: on the row's own branch before it merges, the same command
  runs on the pilot through `index.ts`, with the row in the production
  capability qualification table (case Q02.e). It adds its run to the same
  record file. Q03.a requires both runs, with the same `sourceHash` and
  every required case `pass`.
- It refuses a dirty tree, and it refuses to run when any environment fact
  is overridden (case Q03.b; part 3 section 4): a record made with an
  overridden release, filesystem or boot identity proves nothing about the
  platform.
- It writes the record to a temporary name and renames it, so a killed run
  leaves no record. Proposed place:
  `tests/kernel/state/qualification/<row id>.json`.

Record fields:

| Field                 | Content                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`              | `state-qualification-run/1`                                                                                                                                                                                                                                                                                   |
| `row`                 | the candidate row id                                                                                                                                                                                                                                                                                          |
| `runs`                | one entry for each run, in order: `{ entry, commit, started, ended, cases }`. `entry` is the test entry or `index.ts`; `commit` is the full commit that run used (the second is the row's commit); `started` and `ended` are wall clock times                                                                 |
| `sourceHash`          | SHA-256 over each qualified file in sorted path order, each entered as its path, a newline, its byte length, a newline and its bytes as committed. The files: `kernel/src/addons/state/*.ts` except `capability-qualification-table.ts`; `kernel/src/addons/programs/*.ts`; `kernel/src/kernel/state-seam.ts` |
| `platform`            | `os`, exact `release`, `majorRelease`, architecture, runtime version, distribution, C library, and whether it ran in a container                                                                                                                                                                              |
| `filesystem`          | the state root's observed filesystem facts only; no path, user name or machine name                                                                                                                                                                                                                           |
| `primitive`           | the active coordination route                                                                                                                                                                                                                                                                                 |
| `bootIdentitySource`  | the source, and whether it was readable; never the value                                                                                                                                                                                                                                                      |
| `cases` (in each run) | `[{ id, result, detail }]`, result `pass`, `fail` or `unproved`                                                                                                                                                                                                                                               |
| `factSource`          | `observed`: every fact above was read from the machine, with no override. The command writes no other value                                                                                                                                                                                                   |

The run covers the cases that run on observed facts: the executable closure
and stopped-owner cases (families K02, K03, K06, K07, K08, O04, O05, O07 and
O09) and proposed K11.a, K11.c, K11.d and K11.e. K11.a's half with no
`boot` uses a prepared version 1 style journal, not a fact override. A case
still pending in the case table is recorded `unproved` and is not required.
A row needs every required case `pass`.

Left out of the run:

- Q02.a, Q02.b, Q02.d, Q02.f and K11.b need a fact override, and Q02.c a
  candidate row for another route. They prove the matching logic, which is
  the same on every platform, so the test suite owns them.
- Q02.e needs the row in the production table: it is the second run on the
  pilot, above. Q03.a checks committed records, so the test suite owns
  it.

Q03.a refuses a production row unless its record exists, carries `factSource:
"observed"`, matches the row's `os`, `majorRelease`, `filesystem`, `primitive`
and `bootIdentitySource`, has the row's `observedRelease` as its
`platform.release`, has every required case `pass`, has a `sourceHash` equal
to the hash of the qualified source files now, has both runs, and the row
names its reviewing session, Nathan's countersignature and the date. So a
change to that source invalidates the row until a new run. Version 2 moves the
capability qualification table out of `qualification.ts` into
`capability-qualification-table.ts`, so the matching logic stays inside the
hash and only the table is left out. The hash needs no history lookup, which
suits a shallow checkout. REC-7b asks that review to pass V-22 and V-42 for
each row.

## 4. Closing after a torn tail (proposed: open points L and X)

A free lease is enough proof that nobody is mid-append when three things
hold:

1. Only the owner run appends to its `events` (version 1 section 4.3). A
   delegated program never receives the path.
2. Every append happens while the owner holds the lease.
3. The lease is released after the last append, or by the operating-system
   kernel when the process dies.

The code holds 1 and 3 today. It does not hold 2: a work function that
returns without awaiting a `record` call lets that call append
`effect-confirmed`, or admit a program start, after the final event and
after the lease is released. Worse, its operation can still change the
resource after a closure. In a process that goes on to other runs, that
owner is still alive. So version 2 adds a rule to version 1 section 8, in
this order:

1. When the work function returns or throws, the transaction is marked
   ended before
   anything else, so a failed final append cannot leave it open. New
   `record` and `admitStart` calls refuse.
2. The transaction waits for every `record` call already started, its
   operation and its read-back, to settle, still holding the lease and the
   key coordination locks. Their events are appended and count in the
   run's proof.
3. Only then is the final event appended, the key coordination locks
   released, and the lease released last.

A `record` that never settles keeps the lease held, so its case stays live,
which blocks overlapping work and every closer: the safe direction. The
lease is freed only when the record settles, or when the process ends and
the operating-system kernel frees it (at a deadline the kernel lifecycle
exits the process; a single run with no deadline, or a long-lived process,
keeps it). Case K11.e pins the rule.

With that rule a free lease means no effect and no append is in progress and
none can follow. A torn tail also arises without a crash: a write that fails
part way (a full disk) leaves one, and the owner still releases its lease only
at its end. The closure binds the torn bytes through `journalRevision`.
Recovery classification already treats a torn tail as started (version 1
section 8), so `not-applied` needs `excluded`, never mere absence. A corrupt
`events` file, with bytes after the damage, still refuses.

A torn tail cannot hide a delegate start. `delegate-admitted` is appended
and flushed before the program starts, and an append that fails stops the
start, so an incomplete `delegate-admitted` means no start happened. Hiding
one would need damage to a record already complete and flushed, which is
outside version 1 section 2's boundary of process crash and file flush,
as for every other record.

## 5. Closing after `delegate-admitted` (only after the container machine restarts)

Decided by Nathan, 19 November 2026: accepted as designed, with no same-boot
proof in version 2. The consequence: a case whose run started a program
stays unclosable until the container machine restarts. Restarting or
rebuilding the container does not help. How often that bites turns on open
point Y: whether hosts of this kind start a program inside a recorded
effect at all.

A delegated program runs in its own process group, does not hold the lease
and can outlive its owner (pending cases K08.c and O06.a). Asking whether the
group is empty does not see a descendant that left the group, as the
programs add-on already states, and REC-7 says "a dead parent with a live
child is not a stopped operation". So no same-boot check of the group is
proof.

- `delegate-admitted` gains `boot`: the boot identity, read by the state
  add-on in `admitStart` and written before the start, as today. The programs
  add-on records nothing new. Where the boot identity cannot be read, the
  event is written without it and the start proceeds; that case then cannot
  be closed, as with a version 1 record.
- Closure after a delegate start proceeds only when every `delegate-admitted`
  on the case carries a `boot` that differs from the current boot identity:
  a restart ended every local process of that boot. On the same boot, or
  with a version 1 record that has no `boot`, closure refuses
  `delegate-recorded`, as today.
- K08.c and O06.a become executable as that refusal: a surviving delegate
  blocks closure and overlapping work on the same boot.
- In a container the boot identity is the container machine's.
  Restarting only the container keeps it, so closure refuses: the safe
  direction.
- The boot identity names a boot, not a machine. A state root whose storage
  is moved to, or attached from, a second machine would see another boot
  while the delegate still runs on the first. Each row lists that as
  unsupported under `failureCases` (open point P).
- Remote work a program started is never covered (CMD-14).
- Deferred, not designed: a same-boot proof, for example the started program
  inheriting a locked descriptor on a per-case delegate lease.

## 6. Parts of the closure work

| Part                                         | Version 2                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Matching rule                                | Included (section 2).                                                                                                                       |
| Run command and record format                | Included (section 3).                                                                                                                       |
| First row                                    | `linux-7-btrfs` for the pilot (section 2.1). It lands only with its run record, review and countersignature.                                |
| macOS row                                    | Left out for now.                                                                                                                           |
| Closing after a torn tail                    | Proposed (section 4); rests on open points L and X.                                                                                         |
| Closing after `delegate-admitted`            | Included, only after the container machine restarts (section 5).                                                                            |
| Human takeover and `outcome-unknown` closure | Not included. Both need a qualified authority source, and case K05.b is still pending. Their refusals and capability reports do not change. |
