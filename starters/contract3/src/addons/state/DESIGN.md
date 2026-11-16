# State add-on: frozen storage and coordination design (journal version 1)

Status: frozen design note for T3 (MAG-102, C3-FND-4), committed before any
state add-on production code (CMD-11, REC-7, REC-8). A change to anything in
this note is a new journal version with its own review; code follows this
note, never the reverse. Clause tags refer to the frozen Contract 3 text
(`skills/agent-cli-design/references/contract-3/`, 20 of 20 hashes verified
on 16 November 2026).

This note claims design only. What is implemented, tested and qualified is
reported in the component handback, never here.

## 1. Scope and owners

- The state add-on owns: durable operation identity, the journal, closure
  records, conflict-scope canonicalisation, the coordination lock protocol,
  the unfinished report, the case history read, closure, `admitStart` and the
  emergency record (REC-8, CMD-11, CMD-12, CMD-13, CMD-14 start admission).
- The host owns: scope declarations from validated input, resource
  identities, independent resource observers, its stations and causes, and
  its command routes (REC-2, REC-8, WIRE-19).
- The approval add-on owns authority verification and consumption (CMD-15,
  REC-5). The state add-on never imports it (CMD-17); the host passes its
  kernel-shaped `ApprovalRuntime` and, for human closure, an authority slot.
- Diagnostics never feed any decision below (CMD-16, REC-2).

## 2. Durability boundary

Every claim in this note covers process crash and file flush only (CMD-11).
"Durable" means: bytes written, the file flushed with `fsync`, and, where a
directory entry is created or renamed, the containing directory flushed with
`fsync`. Power loss, firmware caches and network or shared filesystems are
out of scope and are never claimed.

## 3. Storage layout

The host supplies one absolute state root. The add-on creates it with mode
`0700` when absent, and otherwise requires a real directory (not a symbolic
link) owned by the current user with no group or other write bit. Every file
open uses `O_NOFOLLOW`. Ancestor swaps above the root are a documented limit,
not a defended boundary.

```text
<root>/
  format                     one framed "format" record, written once
  coordination/
    admission.lock           admission index coordination lock (permanent)
    k-<h>.lock               one coordination lock per conflict key (permanent)
  operations/
    <operationId>/           published atomically by directory rename
      intent                 one framed intent record
      owner.lease            owner lease file, locked by the owner
      events                 append-only framed records, owner only
      closure                one framed closure record, link(2) no-replace
  staging/                   private work area; readers ignore it
```

- `<h>` is the first 32 hex digits of SHA-256 over the UTF-8 conflict key.
- Coordination files are permanent: never truncated, unlinked or renamed, so
  every contender locks the same inode (REC-7, lock probe finding).
- `operationId` is `op-` followed by 32 lowercase hex digits from a random
  UUID. It is validated by that exact pattern wherever it enters as input.

## 4. Record framing

Every record, in every file, has this exact framing:

```text
"C3S1" SP kind SP length SP checksum LF payload LF
```

- `kind`: 1 to 24 characters of `[a-z-]`.
- `length`: exactly 10 decimal digits, the payload byte length, at most
  65,536.
- `checksum`: 64 lowercase hex digits, SHA-256 over `kind`, one LF, then the
  payload bytes.
- `payload`: UTF-8 JSON object whose `kind` equals the header kind and whose
  `format` is `1`.

Parsing a file reads records in order from byte 0:

| Situation                                                                                                                             | Classification                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Header, length, checksum, JSON and trailing LF all valid                                                                              | valid record                     |
| The last bytes of the file do not form one complete valid record (short header, short payload, missing LF, checksum or JSON mismatch) | torn tail: never parsed as state |
| Any invalid bytes followed by further bytes                                                                                           | corrupt file                     |
| Header kind not allowed in this file, or a payload field fails validation                                                             | corrupt file                     |

A torn tail is the only tolerated damage, because a process crash can stop
an append mid-record. It never yields a state fact. A corrupt file means the
add-on cannot produce a trustworthy report, so read routes refuse (DISC-14
item 5). The test-owned reader implements this table independently.

### 4.1 Format record (`format` file)

`{ format: 1, kind: "format", journal: "contract3.state" }`. Any other
content refuses every route (persisted-state schema refusal).

### 4.2 Intent record (`intent` file, kind `intent`)

```text
{ format: 1, kind: "intent",
  operationId, commandIdentity, runId,
  effects: sorted unique declared effect identifiers,
  scope: { resources: [{ resource, path | key, keys }], invariants: [...],
           unknown: boolean, keys: sorted unique conflict keys },
  revisions: { <resource>: <observed revision> },
  facts: host JSON for its observers (bounded, never secret),
  approval: null | { kind: "preview", reference },
  closes: null | operationId,
  owner: { lease: "owner.lease", pid, startedAt },
  coordination: [lock names in acquisition order] }
```

- REC-1 binding: command identity, run, intended effects, validated scope,
  observed revisions and the approval reference. Never a credential, grant
  bytes or any approval secret: `approval.reference` is the preview or item
  identity only.
- `owner.pid` and `owner.startedAt` are observed facts for people. They are
  never used as stopped-owner proof (REC-7).

### 4.3 Event records (`events` file)

| Kind                 | Payload                                                 | Written                                                  |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `effect-started`     | `{ effect }`                                            | before the effect's operation is called                  |
| `delegate-admitted`  | `{ effect }`                                            | by `admitStart`, before a program start                  |
| `effect-confirmed`   | `{ effect }`                                            | after the host read-back returned true                   |
| `effect-unconfirmed` | `{ effect, reason }`                                    | read-back false, read-back failure, or operation failure |
| `completion`         | `{ completed }`                                         | own run: every intended effect confirmed                 |
| `not-applied`        | `{ remaining }`                                         | own run: no effect was ever started                      |
| `outcome`            | `{ transactionState, completed, remaining, uncertain }` | own run ended partial or unknown                         |
| `emergency`          | `{ phase }`                                             | one synchronous attempt on a catchable crash             |

`reason` is one of `read-back-false`, `read-back-failed`,
`operation-failed`. Only the owner run appends to its own `events`
(REC-4: a later run never writes on the original run's behalf).

### 4.4 Closure record (`closure` file, kind `closure`)

```text
{ format: 1, kind: "closure", operationId, closureId,
  disposition: "completed" | "not-applied" | "outcome-unknown",
  reason, evidence: [{ effect, observation }],
  authority: null | { kind: "human-closure", item },
  journalRevision, qualification, recoveryRunId }
```

- `journalRevision` is `r-` plus SHA-256 over the exact `intent` bytes, one
  LF, then the exact `events` bytes, read under coordination. It is the
  revision this closure closes (REC-4).
- `qualification` names the qualification row, or `fixture:<label>` when a
  test fixture supplied the stopped-owner condition. A fixture label never
  appears in a production closure (Q01).
- `authority.item` holds the bound item fields only (operation,
  disposition, evidence, scope), never grant bytes.

## 5. Operation status (read rule)

For each `operations/<id>/` directory, in this order:

1. Missing or corrupt `intent`: the store is untrustworthy; read routes
   refuse.
2. Corrupt `events` (not merely a torn tail): refuse.
3. A valid `closure`: resolved by closure. A `closure` file that is torn or
   corrupt is not a closure; the case stays unresolved and history reports
   the invalid closure bytes as observed damage.
4. A valid `completion` or `not-applied` event: resolved by its own run.
5. Otherwise unresolved, whether live, partial, unknown or crashed.

The unfinished report lists every unresolved case as strict
`{ operationId, commandIdentity, runId, effects }` (DISC-14). It reads files
only: no coordination lock, no lease probe, no write.

## 6. Conflict scope and canonicalisation (REC-2)

A host declares, from validated input and before any coordination, a scope:
resources (each with a host resource identity and either a filesystem path or
an already canonical host key), shared invariant names, or `unknown`.

Conflict keys:

| Declaration                                                           | Keys                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Path that exists                                                      | `inode:<dev>:<ino>` of the real target, and `name:<dev>:<parent ino>/<folded basename of the real path>` |
| Path that does not exist                                              | `name:<dev>:<ino of the nearest existing real ancestor>/<folded remaining components>`                   |
| Host key                                                              | `key:<host key>`                                                                                         |
| Invariant                                                             | `invariant:<name>`                                                                                       |
| Unknown, empty, or unresolvable (permission, loop, non-absolute path) | the scope is unknown                                                                                     |

- Folding is Unicode NFC then lower case. On a case-sensitive volume this can
  only add conflicts, never remove them.
- Symbolic link aliases resolve to the same real path; hard links and
  renames keep the same inode key; case and normalisation aliases fold to the
  same name key.
- At admission, each unresolved case's stored path declarations are resolved
  again and the result is added to its stored keys, so a target created or
  renamed after the earlier intent still conflicts.
- Two scopes conflict when either is unknown, or their key sets intersect.
  Only intersection-free known scopes are independent.
- Containment is not inferred: a host that treats a directory as one
  resource declares a shared invariant. This is a host obligation.

## 7. Coordination lock protocol

Primitive: a non-blocking exclusive `flock`-style lock taken at open time
with the Darwin numeric flag `O_EXLOCK` (`0x20`) together with `O_RDWR`,
`O_CREAT`, `O_NONBLOCK` and `O_NOFOLLOW`, held for as long as the descriptor
stays open. Refusal is `EAGAIN`. The kernel releases it when the descriptor
closes, including on SIGKILL. It is advisory among cooperating writers.

- Darwin only. On every other platform the flag has no exclusion meaning,
  so the coordination primitive is unavailable and every changing route
  refuses before any write (fail closed). This is not a pass on that
  platform.
- Qualified at probe level only (lock probe, 16 November 2026, Darwin
  macOS 26.6, APFS local volume, Bun 1.4.4). Network and shared filesystems
  are unsupported and not detected.

### 7.1 Admission ordering (one documented order)

1. Validate input; declare and canonicalise scope (no coordination yet).
2. Acquire `coordination/admission.lock`: bounded wait, 10 ms polling, at
   most 2,000 ms. Expiry refuses as a temporary confirmed-unchanged
   condition (`busy`), never as the held-lock station.
3. Acquire every conflict-key coordination lock in ascending lock-file name
   order, non-blocking. Any `EAGAIN`: release what was taken, in reverse,
   then refuse `held-lock`.
4. Under those coordination locks, read every operation (section 5). For
   each unresolved case whose scope conflicts (section 6): probe its
   `owner.lease` non-blocking. Held means a live owner: refuse `held-lock`.
   Free means refuse `unresolved-case`, binding that case's `operationId`.
   A read refusal of the store refuses admission (never treated as empty).
   A recovery command applies only the live-owner half of this check: other
   unresolved cases never block a closure, because closure performs no domain
   effect, and two overlapping crashed cases must each remain closable.
5. For an approved effect: issue the kernel `ExclusiveScope` for the
   approval resource, which must be one of the declared resources, and call
   `revalidateAndConsume` (CMD-9 step 7). Denial, consumed-then-lost and
   store failure are three distinct outcomes (section 9).
6. In `staging/<operationId>/`: create and lock `owner.lease`, write and
   flush `intent`, flush the directory; rename to `operations/<operationId>`
   and flush `operations/`.
7. Release `admission.lock`. Keep the key coordination locks and the lease
   until the transaction ends.

At transaction end: append and flush the own-run final event, release key
coordination locks, then release the lease last.

Bounded waiting ends only in acquisition, refusal, a signal (the kernel
lifecycle exits 130 or 143) or the declared deadline (CMD-12). Held-lock
refusals are never retryable (CMD-12, V-22).

### 7.2 Owner record and the stopped-owner condition

The owner of an operation is the run that published its intent. Its proof
of life is the `owner.lease` coordination lock, held from before publication
to the end of its transaction. A held lease is proof the owner's open file
description still exists, so the owner may still act.

A free lease is not stopped-owner proof by itself (REC-7): a delegated
writer started through the programs add-on does not inherit the lease, and a
parent's death is never proof. The candidate runtime proof is "lease free and
no `delegate-admitted` event and no torn events tail". It is usable only
when the current environment matches a reviewed row of the qualification
table (section 10). The foundation table is empty, so in production the
stopped-owner condition is unavailable and every closure of an unresolved
case hands off (expected foundation outcome O10 and Q01). Lock age, PID
presence or absence, host name and sent signals are never consulted.

There is no lock reclaim step: a coordination lock whose holder died is
released by the kernel, and acquiring it grants coordination only. The
unresolved case still blocks overlapping work until a valid closure (REC-7,
REC-3). Human-assisted takeover (REC-7a) has nothing to replace in this
protocol and stays unavailable with a handoff.

## 8. Effect recording (CMD-10a, CMD-11)

Inside one admitted transaction, `record(effect, operation, readBack)`:

1. Refuse an effect the command did not declare, or one already recorded.
2. Append and flush `effect-started`.
3. Issue a `RecordedEffect` for this run and effect; mark it active.
4. Call `operation`. A throw appends `effect-unconfirmed`
   (`operation-failed`); the effect is uncertain.
5. Mark the effect closing: new `admitStart` calls are refused; wait for
   starts already admitted to settle.
6. Call `readBack`. `true` appends `effect-confirmed`; `false` or a throw
   appends `effect-unconfirmed`. Never completion from the operation's own
   return value.

The transaction proof is computed from this run's own records:

| Observation                                          | Transaction state                      |
| ---------------------------------------------------- | -------------------------------------- |
| No effect started                                    | `unchanged`; own `not-applied` event   |
| Every declared effect confirmed                      | `completed`; own `completion` event    |
| Some confirmed, none unconfirmed, some never started | `partially-completed`; `outcome` event |
| Any started but unconfirmed                          | `unknown`; `outcome` event             |

Remaining effects in a run's own proof are declared effects never started
under the write-ahead protocol.

Recovery classification (closure and history) never uses the journal alone
(CMD-11): for each intended effect the host observer reports `present`,
`excluded` (host evidence rules out the attempted effect), `absent` (current
absence only) or `unobservable`.

| Observer                         | Journal                           | Recovery class                                   |
| -------------------------------- | --------------------------------- | ------------------------------------------------ |
| present                          | any                               | completed                                        |
| excluded                         | any                               | remaining                                        |
| absent                           | no `effect-started`, no torn tail | remaining                                        |
| absent                           | started or torn tail              | uncertain (absence never proves non-application) |
| unobservable or observer failure | any                               | uncertain                                        |

## 9. Approval consumption (CMD-15, A19)

The host passes `{ runtime, request }`, where `runtime` is
`approval(...).runtime(descriptor)` called with the same descriptor given to
`contractFor({ state })`. Under step 5 of section 7.1:

| Approval result                  | State outcome                                                             |
| -------------------------------- | ------------------------------------------------------------------------- |
| `{ admitted: true }`             | intent records `approval.reference`; effects may begin                    |
| `{ admitted: false }`            | `denied`: refused, unchanged; no intent                                   |
| rejection with `consumed: true`  | `approval-lost`: refused, unchanged; no intent, no effect, never refunded |
| rejection with `consumed: false` | `approval-unavailable`: refused, unchanged; item preserved                |

A crash after consumption and before publication leaves no operation and a
consumed item: no refund, no replay.

## 10. Qualification gate (REC-7b, REC-8, Q01)

`qualification` is a frozen table of reviewed environment rows. Each row
must name OS and version, filesystem, primitive, process and boot identity,
namespace, delegated-writer handling, failure cases and evidence. The
foundation table is empty. Capabilities:

| Capability                                              | Production foundation default                             |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Runtime stopped-owner proof (closure of a crashed case) | unavailable, handoff                                      |
| Automatic reclaim                                       | unavailable, handoff (no reclaim step exists)             |
| Human-assisted takeover (REC-7a)                        | unavailable, handoff                                      |
| Human `outcome-unknown` closure                         | unavailable without a qualified authority source, handoff |

A labelled test-only fixture module may supply a fixture qualification to a
test host. It never alters the production table; any closure it enables is
stamped `fixture:<label>`, and the history route reports it.

## 11. Transition table and crash boundaries (REC-8)

Every transition maps to at least one frozen case identity in
`tests/contract3/state/cases.ts`. A crash at the boundary named in the
second column leaves the durable state in the third.

| Id  | Transition                                    | Crash at boundary leaves                                  | Cases               |
| --- | --------------------------------------------- | --------------------------------------------------------- | ------------------- |
| X01 | input validated, scope declared               | nothing written                                           | P04.a               |
| X02 | admission lock wait                           | nothing written; wait bounded                             | O03.a, O03.b, T01.b |
| X03 | key coordination locks taken in order         | nothing written; kernel releases locks                    | O01.a, O02.a, P06.a |
| X04 | unresolved and live-owner check               | nothing written                                           | P05.a, K09.a, P03.a |
| X05 | approval consumed                             | consumed item, no operation; no refund                    | S01.a, S03.a        |
| X06 | staging lease, intent written                 | staging only; readers ignore it                           | J01.c               |
| X07 | staging renamed into `operations/`            | intent present: listed as unresolved                      | J01.a, L01.a        |
| X08 | `effect-started` appended                     | listed; effect uncertain unless observer proves otherwise | J01.a, J04.f        |
| X09 | domain effect performed                       | listed; observer decides                                  | K02.a, J06.a        |
| X10 | `effect-confirmed` or `-unconfirmed` appended | listed; recovery still reads back                         | L01.b, J05.a        |
| X11 | `delegate-admitted` appended                  | listed; runtime stop proof refused                        | B01.a, K08.b        |
| X12 | own final event appended                      | completion or not-applied: resolved; torn: listed         | J04.a, L01.c, T02.a |
| X13 | key coordination locks and lease released     | as X12                                                    | L01.e               |
| X14 | envelope emitted                              | as X12                                                    | J02.b               |
| X15 | emergency record (catchable crash)            | one `emergency` event or nothing                          | B04.a               |
| X16 | recovery admission (key locks, lease probe)   | nothing written                                           | K08.a, O04.a        |
| X17 | stopped-owner condition evaluated             | nothing written; unavailable without a row                | O10.a, Q01.a        |
| X18 | revision and evidence evaluated               | nothing written                                           | K03.a, K06.c        |
| X19 | closure written in staging                    | staging only; no closure                                  | K06.e               |
| X20 | closure linked no-replace into the case       | valid closure: case resolved                              | K02.a, K06.a        |
| X21 | closure retried with the same identity        | prior disposition; no new record                          | K06.a               |
| X22 | later change after closure                    | closure unchanged; case not relisted                      | K07.a               |

## 12. Interface for other components

- Host: `stateAddon(options)` returns the descriptor for `contractFor`, the
  `emergencyRecord` for `runProcess`, `transaction(ctx.state, declaration,
  work)` for changing handlers, and read functions for the report and the
  case history inspect commands, plus `close(...)` for recovery commands.
- Approval: section 9.
- Programs (slice B): `RecordedEffect.admitStart(runId, effect, start)`
  rejects a wrong run, a wrong or inactive effect, or a closing effect before
  calling `start`; it appends `delegate-admitted` durably first and keeps the
  effect from closing until `start` settles.
- Writer and lifecycle: `emergencyRecord(facts)` makes one synchronous,
  bounded append to the active operation's `events` and never throws.

## 13. Open points for the coordinator

- Human-authority item identity (T4 R8) is not chosen here. The closure
  record needs a stable reference to the consumed item. Under option 3
  (issuer-assigned grant identity) the journal records that identity; under
  options 1 and 2 a crash between consumption and closure publication leaves
  that operation unable to close under new authority.
- A tri-state read-back (present, excluded, unknown) inside a live run would
  let a run confirm its own not-applied effect after an attempted operation.
  The kernel's `readBack` returns a boolean, so this design classifies such an
  effect uncertain.
- Coordination on non-Darwin platforms has no qualified primitive.
