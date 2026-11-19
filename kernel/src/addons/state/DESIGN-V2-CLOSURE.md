# State add-on: journal version 2 design, part 2 of 3 (closing a crashed case in production)

Status: proposed, not reviewed. Read [DESIGN-V2.md](DESIGN-V2.md) first: it
holds the status, the source of the clause quotes, the section map and the
store format. This part changes version 1 sections 7.2 and 10 of
[DESIGN.md](DESIGN.md), which stays frozen and unchanged. The transitions,
proposed cases and open points are in [DESIGN-V2-CASES.md](DESIGN-V2-CASES.md).

## 1. What changes

Version 1's candidate proof is "lease free and no `delegate-admitted` event
and no torn events tail", usable only under a reviewed row, and the table is
empty. Version 2's stopped-owner condition for a crashed case is all of:

1. The owner lease is free.
2. The environment matches a production capability qualification row
   (section 2).
3. Every `delegate-admitted` event on the case names a boot identity that
   differs from the current one (section 5). A case with none passes.

A torn events tail no longer refuses (section 4). Lock age, PID presence,
host name and sent signals are still never consulted. Without a matching row
every closure of an unresolved case still hands off, as O10 and Q01 pin
today.

## 2. Matching a row (decision 1a: Nathan, 19 November 2026)

A row matches on the operating system and the major release, not the exact
release string, and the state root's filesystem is checked at run time. The
facts are read at closure time (X30), under the coordination locks, without
starting a program. Linux in a container is the first target; Darwin is
second and optional (open point I).

| Fact                  | Linux                               | Darwin                             | Must equal the row's |
| --------------------- | ----------------------------------- | ---------------------------------- | -------------------- |
| Operating system      | `process.platform`                  | `process.platform`                 | `os`                 |
| Major release         | first part of `os.release()`        | first part of `os.release()`       | `majorRelease`       |
| State root filesystem | type number from `statfsSync(root)` | type name and local flag, `statfs` | `filesystem`         |
| Coordination route    | active route of `coordination.ts`   | active route of `coordination.ts`  | `primitive`          |
| Boot identity         | `/proc/sys/kernel/random/boot_id`   | `kern.bootsessionuuid`             | readable, not empty  |

- A mismatch or an unreadable fact refuses
  `stopped-owner-proof-unqualified` before any write. The detail carries the
  observed facts and what is qualified, as coordination refusals do.
- The filesystem is read at closure time, not at start-up, because the
  volume under a root can change between runs. `capabilities()` reports the
  same match for its root.
- Version 1's contract question N3 (unsupported filesystems are not detected)
  still holds for coordination. Only closure gains the check.

### 2.1 Linux in a container

- Major release. A container runs on its host's operating-system kernel, so
  `os.release()` inside it is the host kernel's release (observed:
  `7.2.12-orbstack-00394-gbecdd6130068`, version 1 section 7). The major
  release is that kernel's major, `7` (open point J). The image's
  distribution and C library are recorded as observed and not matched; the
  Linux route's start-up self-check covers the C library at run time.
- Filesystem. `statfsSync(root).type` reports the filesystem under the root
  however it was mounted, and the numbers are a stable interface:

| The state root sits on                              | Reads as                                                                               | Row                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| A named volume                                      | the container host's local filesystem (btrfs `0x9123683E` in the observed environment) | the first row                                |
| A bind mount of a Linux host folder                 | that filesystem (ext4 `0xEF53`, XFS `0x58465342`)                                      | one row per type, each with its own evidence |
| A bind mount of a folder shared from another system | a shared type (expected FUSE `0x65735546`; not observed here)                          | none: shared filesystems stay unsupported    |
| The container's writable layer                      | overlay `0x794C7630`                                                                   | none in version 2 (open point O)             |
| A network mount                                     | NFS `0x6969` and similar                                                               | none                                         |

- Two containers that share one volume on one host share its kernel, so
  coordination locks and leases exclude across them. The boot identity is
  also the host kernel's, the same in every container on it.
- The evidence run happens inside a container on a host whose kernel is in
  the row's major release. The state root's parent is an argument, so the
  root is on the volume under test while the repository sits anywhere.
- First row: `linux-7-btrfs`, a named volume in the one environment observed
  so far. Its run record is owed (open point N).

### 2.2 Darwin (second, optional)

`os.release()` is the kernel release: `25.6.0` on macOS 26.6, so the major
release is `25`. The runtime's `statfsSync` reports only a number (observed
here: 26 for APFS, 19 for the device filesystem). This note found no source
that fixes those numbers, and the local flag is not reported, so a Darwin
row needs the name, the flag and the boot identity through a foreign call.
Without that work Darwin has no row and closure there still hands off.

## 3. The row and its run record (decision 1b: Nathan, 19 November 2026)

A row cites a committed run record and names its independent review. A hosted
run link is not evidence. A row's run happens on a machine in that major
release.

Row fields:

| Field              | Meaning                                                                     | Matched at run time |
| ------------------ | --------------------------------------------------------------------------- | ------------------- |
| `id`               | stamped into every closure it enables, for example `linux-7-btrfs`          | no                  |
| `os`               | `darwin` or `linux`                                                         | yes                 |
| `majorRelease`     | as section 2                                                                | yes                 |
| `observedRelease`  | the exact release string the evidence run observed                          | no                  |
| `filesystem`       | Linux: `{ name, type }`. Darwin: `{ name, local }`                          | yes                 |
| `primitive`        | the coordination route                                                      | yes                 |
| `bootIdentity`     | the boot identity source                                                    | yes, readable       |
| `processIdentity`  | how a delegated program is identified; version 2: boot identity only        | no                  |
| `namespace`        | the user and process view the run used (non-root; host or container)        | no                  |
| `delegatedWriters` | the rule of section 5                                                       | no                  |
| `failureCases`     | what the row does not cover                                                 | no                  |
| `evidence`         | `{ record, review }`: the record's path, and the reviewer, date and verdict | checked by a test   |

One repeatable command (proposed name `bun run qualify:state`) runs the
stopped-owner cases on the platform and writes the record. It supplies the
candidate row through the labelled test entry, so its closures are stamped
`fixture:<label>` and it never touches the production table. It refuses a
dirty tree. It writes the record to a temporary name and renames it, so a
killed run leaves no record. Proposed place:
`tests/kernel/state/qualification/<row id>.json`.

Record fields:

| Field               | Content                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`            | `state-qualification-run/1`                                                                                                                  |
| `row`               | the candidate row id                                                                                                                         |
| `commit`            | the full commit the run used                                                                                                                 |
| `started`, `ended`  | wall clock times                                                                                                                             |
| `platform`          | `os`, exact `release`, `majorRelease`, architecture, runtime version; on Linux the distribution, C library and whether it ran in a container |
| `stateRoot`         | the observed `filesystem` facts only; no path, user name or host name                                                                        |
| `coordinationRoute` | the active route                                                                                                                             |
| `bootIdentity`      | the source, and whether it was readable; never its value                                                                                     |
| `cases`             | `[{ id, result, detail }]`, result `pass`, `fail` or `unproved`                                                                              |

The run covers the executable closure and stopped-owner cases (families K02,
K03, K06, K07, K08, O04, O05, O07 and O09) and the proposed cases that need
no production row (Q02.a to Q02.d, K11.a to K11.e). A case still pending in
the case table is recorded `unproved` and is not required. A row needs every
required case `pass`.

Two cases cannot be in the run, because they need the row to exist: Q02.e
(a closure stamped with the row's `id`) and Q03.a. The test suite proves
them once the row lands. Q03.a refuses a production row unless its record
exists, matches the row's `os`, `majorRelease`, `filesystem` and
`primitive`, has every required case `pass`, and the row names its review.
REC-7b asks that review to pass V-22 and V-42 for each row.

## 4. Closing after a torn tail (included)

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
after the lease is released. In a process that goes on to other runs, that
owner is still alive. So version 2 adds a rule to version 1 section 8: once
the final event is appended the transaction is ended. `record` and
`admitStart` refuse, and a read-back still in flight appends nothing. Case
K11.e pins it.

With that rule a free lease means no append is in progress and none can
follow. A torn tail also arises without a crash: a write that fails part
way (a full disk) leaves one, and the owner still releases its lease only at
its end. The closure binds the torn bytes through `journalRevision`.
Recovery classification already treats a torn tail as started (version 1
section 8), so `not-applied` needs `excluded`, never mere absence. A corrupt
`events` file, with bytes after the damage, still refuses.

## 5. Closing after `delegate-admitted` (included, across a restart only)

A delegated program runs in its own process group, does not hold the lease
and can outlive its owner (pending cases K08.c and O06.a). Asking whether the
group is empty does not see a descendant that left the group, as the
programs add-on already states, and REC-7 says "a dead parent with a live
child is not a stopped operation". So no same-boot check is proof.

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
- A same-boot proof would need more from the programs add-on: the group
  leader's process identifier and start time recorded after the start, and a
  group its descendants cannot leave. Version 2 does not include it.
- In a container the boot identity is the host kernel's. Restarting only the
  container keeps it, so closure refuses: the safe direction. A container
  restart is not used as proof, because two containers can share one state
  root, and a closer in another container cannot see that the first one
  ended (open point K).
- The boot identity names a boot, not a machine. A state root whose storage
  is moved to, or attached from, a second machine would see another boot
  while the delegate still runs on the first. Version 2 treats that as an
  unsupported environment that each row lists under `failureCases` (open
  point P).
- Remote work a program started is never covered (CMD-14).

## 6. Parts of the closure work

| Part                                         | Version 2                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Matching rule                                | Included (section 2).                                                                                                                       |
| Run command and record format                | Included (section 3).                                                                                                                       |
| First row: Linux in a container              | `linux-7-btrfs` (section 2.1). It lands only with its run record and review; that evidence is owed.                                         |
| macOS row                                    | Second and optional (section 2.2). Not included unless open point I is taken up.                                                            |
| Closing after a torn tail                    | Included (section 4).                                                                                                                       |
| Closing after `delegate-admitted`            | Included across a restart only (section 5).                                                                                                 |
| Human takeover and `outcome-unknown` closure | Not included. Both need a qualified authority source, and case K05.b is still pending. Their refusals and capability reports do not change. |
