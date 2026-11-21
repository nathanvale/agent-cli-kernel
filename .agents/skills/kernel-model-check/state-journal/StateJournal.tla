--------------------------- MODULE StateJournal ---------------------------
(*
  Formal model of the State add-on journal v2 protocol:
    - kernel/src/addons/state/install.ts
    - kernel/src/addons/state/store.ts
    - kernel/src/addons/state/framing.ts
    - kernel/src/addons/state/coordination.ts

  Structure:
    1. Implementation-independent Contract Invariants (what any simpler rebuild
       must still preserve).
    2. Current-implementation state machine with every guard cited to file:line.
*)
EXTENDS Naturals

CONSTANTS MaxRev

VARIABLES
  storeVersion,        \* "v1" | "v2"  (store.ts:122-163)
  settledDirReady,     \* BOOLEAN      (store.ts:148-150)
  admissionLock,       \* "none" | "writer" | "closer"  (install.ts:558-562)
  caseLocation,        \* "absent" | "staging" | "operations" | "settled" (store.ts:623-678)
  ownerLease,          \* "free" | "writer" | "closer"  (install.ts:494,794,1019)
  caseLock,            \* "free" | "closer"             (install.ts:951,1265)
  writerPc,            \* "idle" | "admitted" | "published" | "effectStarted" | "workEnded" | "finalAppended" | "done" | "crashed"
  effectInFlight,      \* BOOLEAN      (install.ts:999,1010,1201-1204)
  tornTail,            \* BOOLEAN      (framing.ts:94-112, store.ts:712-715)
  hiddenInTornTail,    \* BOOLEAN      (framing.ts:121-126, install.ts:453)
  delegateBoot,        \* "none" | "boot1" | "boot2"    (store.ts:226-245)
  currentBoot,         \* "boot1" | "boot2"             (install.ts:449-460)
  closureState,        \* "absent" | "valid"            (store.ts:731-753)
  settled,             \* BOOLEAN      (store.ts:511-524)
  journalRev,          \* 0..MaxRev    (store.ts:468-473)
  closerPc,            \* "idle" | "readPreLease" | "admitted" | "leaseHeld" | "verified" | "closed"
  closerReqRev,        \* 0..MaxRev    (install.ts:471,1319)
  closerLeaseRev,      \* 0..MaxRev    (install.ts:481-510)
  readerPc,            \* "idle" | "readOps" | "readSettled" | "done" (store.ts:555-565)
  readerSawOps,        \* BOOLEAN      (store.ts:560-562)
  readerResult         \* "none" | "found" | "not-found"

storeVars  == <<storeVersion, settledDirReady>>
lockVars   == <<admissionLock, ownerLease, caseLock>>
caseVars   == <<caseLocation, closureState, settled, journalRev>>
writerVars == <<writerPc, effectInFlight, tornTail, hiddenInTornTail, delegateBoot, currentBoot>>
closerVars == <<closerPc, closerReqRev, closerLeaseRev>>
readerVars == <<readerPc, readerSawOps, readerResult>>
vars       == <<storeVars, lockVars, caseVars, writerVars, closerVars, readerVars>>

NextRev == IF journalRev < MaxRev THEN journalRev + 1 ELSE journalRev

TypeOK ==
  /\ storeVersion \in {"v1", "v2"}
  /\ settledDirReady \in BOOLEAN
  /\ admissionLock \in {"none", "writer", "closer"}
  /\ caseLocation \in {"absent", "staging", "operations", "settled"}
  /\ ownerLease \in {"free", "writer", "closer"}
  /\ caseLock \in {"free", "closer"}
  /\ writerPc \in {"idle", "admitted", "published", "effectStarted", "workEnded", "finalAppended", "done", "crashed"}
  /\ effectInFlight \in BOOLEAN
  /\ tornTail \in BOOLEAN
  /\ hiddenInTornTail \in BOOLEAN
  /\ delegateBoot \in {"none", "boot1", "boot2"}
  /\ currentBoot \in {"boot1", "boot2"}
  /\ closureState \in {"absent", "valid"}
  /\ settled \in BOOLEAN
  /\ journalRev \in 0..MaxRev
  /\ closerPc \in {"idle", "readPreLease", "admitted", "leaseHeld", "verified", "closed"}
  /\ closerReqRev \in 0..MaxRev
  /\ closerLeaseRev \in 0..MaxRev
  /\ readerPc \in {"idle", "readOps", "readSettled", "done"}
  /\ readerSawOps \in BOOLEAN
  /\ readerResult \in {"none", "found", "not-found"}

Init ==
  /\ storeVersion = "v1" /\ settledDirReady = FALSE
  /\ admissionLock = "none" /\ ownerLease = "free" /\ caseLock = "free"
  /\ caseLocation = "absent" /\ closureState = "absent" /\ settled = FALSE /\ journalRev = 0
  /\ writerPc = "idle" /\ effectInFlight = FALSE /\ tornTail = FALSE /\ hiddenInTornTail = FALSE
  /\ delegateBoot = "none" /\ currentBoot = "boot1"
  /\ closerPc = "idle" /\ closerReqRev = 0 /\ closerLeaseRev = 0
  /\ readerPc = "idle" /\ readerSawOps = FALSE /\ readerResult = "none"

\* --- Store v1 -> v2 upgrade under admission lock (store.ts:138-163) ---

WriterAdmit ==
  /\ writerPc = "idle"
  /\ admissionLock = "none" \* install.ts:558-562
  /\ admissionLock' = "writer"
  /\ writerPc' = "admitted"
  /\ UNCHANGED <<storeVars, ownerLease, caseLock, caseVars, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

UpgradeCreateSettled ==
  /\ admissionLock /= "none" \* install.ts:840
  /\ storeVersion = "v1"     \* store.ts:147
  /\ ~settledDirReady        \* store.ts:148
  /\ settledDirReady' = TRUE
  /\ UNCHANGED <<storeVersion, lockVars, caseVars, writerVars, closerVars, readerVars>>

UpgradeSwapFormat ==
  /\ admissionLock /= "none" \* install.ts:840
  /\ storeVersion = "v1"     \* store.ts:147
  /\ settledDirReady         \* store.ts:148-153
  /\ storeVersion' = "v2"
  /\ UNCHANGED <<settledDirReady, lockVars, caseVars, writerVars, closerVars, readerVars>>

\* --- Writer publishes operation, records effects, finishes or crashes ---

WriterPublish ==
  /\ writerPc = "admitted"
  /\ admissionLock = "writer"
  /\ storeVersion = "v2"       \* install.ts:840 completes upgrade before open
  /\ caseLocation = "absent"
  /\ ownerLease = "free"       \* store.ts:657
  /\ caseLocation' = "operations" \* store.ts:667
  /\ ownerLease' = "writer"
  /\ admissionLock' = "none"   \* install.ts:909
  /\ writerPc' = "published"
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, caseLock, closureState, settled, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterStartEffect ==
  /\ writerPc = "published"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts:712 endsOnWholeRecord guard
  /\ writerPc' = "effectStarted"
  /\ effectInFlight' = TRUE    \* install.ts:1201-1204 tracked in-flight record
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterAdmitDelegate ==
  /\ writerPc = "effectStarted"
  /\ effectInFlight
  /\ ownerLease = "writer"
  /\ delegateBoot = "none"
  /\ ~tornTail                 \* store.ts:712 refuses append after torn tail
  /\ delegateBoot' = currentBoot \* install.ts:1147-1151
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, writerPc,
                 effectInFlight, tornTail, hiddenInTornTail, currentBoot, closerVars, readerVars>>

WriterTornAppend ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts:723 partial write leaves torn tail
  /\ tornTail' = TRUE
  /\ journalRev' = NextRev     \* store.ts:468-473 hashes raw bytes including torn tail
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, writerPc,
                 effectInFlight, hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterTornAppendHidden ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* framing.ts:121-126 mid-line record hidden in torn tail
  /\ tornTail' = TRUE
  /\ hiddenInTornTail' = TRUE
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, writerPc,
                 effectInFlight, delegateBoot, currentBoot, closerVars, readerVars>>

WriterWorkReturns ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ writerPc' = "workEnded"   \* install.ts:1009 recording.ended = true
  /\ UNCHANGED <<storeVars, lockVars, caseVars, effectInFlight, tornTail, hiddenInTornTail,
                 delegateBoot, currentBoot, closerVars, readerVars>>

WriterEffectSettles ==
  /\ writerPc \in {"effectStarted", "workEnded"}
  /\ effectInFlight
  /\ effectInFlight' = FALSE   \* install.ts:1010 awaits settled(recording.records)
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerPc, tornTail, hiddenInTornTail,
                 delegateBoot, currentBoot, closerVars, readerVars>>

WriterAppendFinal ==
  /\ writerPc = "workEnded"
  /\ ~effectInFlight           \* install.ts:1010 waits for started effects first
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts:712 endsOnWholeRecord
  /\ settled' = TRUE           \* install.ts:1016,1089-1096
  /\ writerPc' = "finalAppended"
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterReleaseLease ==
  /\ writerPc \in {"finalAppended", "workEnded"}
  /\ ~effectInFlight           \* install.ts:1010-1019 lease held until effects settle
  /\ (writerPc = "finalAppended" \/ tornTail) \* install.ts:1104-1106 failed append still ends
  /\ ownerLease = "writer"
  /\ ownerLease' = "free"      \* install.ts:1019
  /\ writerPc' = "done"
  /\ UNCHANGED <<storeVars, admissionLock, caseLock, caseVars, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterCrash ==
  /\ writerPc \in {"admitted", "published", "effectStarted", "workEnded", "finalAppended"}
  /\ writerPc' = "crashed"
  /\ effectInFlight' = FALSE   \* OS process death releases descriptors and stops JS
  /\ ownerLease' = IF ownerLease = "writer" THEN "free" ELSE ownerLease
  /\ admissionLock' = IF admissionLock = "writer" THEN "none" ELSE admissionLock
  /\ UNCHANGED <<storeVars, caseLock, caseVars, tornTail, hiddenInTornTail,
                 delegateBoot, currentBoot, closerVars, readerVars>>

HostReboot ==
  /\ currentBoot = "boot1"
  /\ ownerLease = "free" /\ admissionLock = "none" /\ caseLock = "free"
  /\ currentBoot' = "boot2"    \* boot_id changes on machine restart (install.ts:446-458)
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerPc, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, closerVars, readerVars>>

\* --- Mover renames settled case operations/ -> settled/ under admission lock ---

MoveSettledCase ==
  /\ storeVersion = "v2"       \* install.ts:918 settledIsPrivate
  /\ settledDirReady
  /\ admissionLock = "none"
  /\ caseLocation = "operations"
  /\ settled                   \* install.ts:914-916 status /= "unresolved"
  /\ ownerLease = "free"       \* install.ts:950 lockFree(owner.lease)
  /\ caseLock = "free"         \* install.ts:951 lockFree(case:<id>)
  /\ caseLocation' = "settled" \* store.ts:633 renameSync
  /\ UNCHANGED <<storeVars, lockVars, closureState, settled, journalRev,
                 writerVars, closerVars, readerVars>>

\* --- Closer protocol (install.ts:449-510, 1209-1388) ---

CloserReadPreLease ==
  /\ closerPc = "idle"
  /\ caseLocation = "operations"
  /\ ~settled                  \* install.ts:430,1319
  /\ closerPc' = "readPreLease"
  /\ closerReqRev' = journalRev
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerLeaseRev, readerVars>>

CloserAdmit ==
  /\ closerPc = "readPreLease"
  /\ admissionLock = "none"    \* install.ts:1263
  /\ caseLock = "free"         \* install.ts:1265
  /\ caseLocation = "operations"
  /\ admissionLock' = "closer"
  /\ caseLock' = "closer"
  /\ closerPc' = "admitted"
  /\ UNCHANGED <<storeVars, ownerLease, caseVars, writerVars, closerReqRev, closerLeaseRev, readerVars>>

CloserAcquireLeaseAndRecheck ==
  /\ closerPc = "admitted"
  /\ ownerLease = "free"       \* install.ts:494-498 tryLock(owner.lease)
  /\ ~settled                  \* install.ts:472,504 caseRead under lease
  /\ journalRev = closerReqRev \* install.ts:471 stale-revision check under lease
  /\ ownerLease' = "closer"
  /\ admissionLock' = "none"   \* install.ts:909,1330,1369 open() releases admissionLock before publishClosure
  /\ closerLeaseRev' = journalRev
  /\ closerPc' = "leaseHeld"
  /\ UNCHANGED <<storeVars, caseLock, caseVars, writerVars, closerReqRev, readerVars>>

CloserVerifyStoppedOwner ==
  /\ closerPc = "leaseHeld"
  /\ ownerLease = "closer"
  /\ ~hiddenInTornTail         \* install.ts:453 recordHiddenInTornTail
  /\ (delegateBoot = "none" \/ delegateBoot /= currentBoot) \* install.ts:454-459
  /\ closerPc' = "verified"
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerReqRev, closerLeaseRev, readerVars>>

CloserPublishClosure ==
  /\ closerPc = "verified"
  /\ ownerLease = "closer"
  /\ caseLocation = "operations"
  /\ closureState = "absent"   \* store.ts:743 linkSync exclusive
  /\ closureState' = "valid"
  /\ settled' = TRUE
  /\ ownerLease' = "free"      \* install.ts:1298
  /\ caseLock' = "free"        \* install.ts:1299
  /\ closerPc' = "closed"
  /\ UNCHANGED <<storeVars, admissionLock, caseLocation, journalRev, writerVars, closerReqRev, closerLeaseRev, readerVars>>

\* --- Lockless history reader racing MoveSettledCase (store.ts:555-582) ---

ReaderStart ==
  /\ readerPc = "idle"
  /\ caseLocation \in {"operations", "settled"} \* target case was published
  /\ readerPc' = "readOps"
  /\ readerSawOps' = (caseLocation = "operations") \* store.ts:560 reads operations/<id>
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerVars, readerResult>>

ReaderCheckOpsRemains ==
  /\ readerPc = "readOps"
  /\ IF caseLocation = "operations" \* store.ts:562 folderRemains(operations/<id>)
     THEN /\ readerResult' = IF readerSawOps THEN "found" ELSE "not-found"
          /\ readerPc' = "done"
     ELSE /\ readerPc' = "readSettled" \* moved during read -> check settled/<id>
          /\ readerResult' = "none"
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerVars, readerSawOps>>

ReaderCheckSettled ==
  /\ readerPc = "readSettled"
  /\ readerResult' = IF caseLocation = "settled" THEN "found" ELSE "not-found" \* store.ts:560-563
  /\ readerPc' = "done"
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerVars, readerSawOps>>

Next ==
  \/ WriterAdmit \/ UpgradeCreateSettled \/ UpgradeSwapFormat
  \/ WriterPublish \/ WriterStartEffect \/ WriterAdmitDelegate \/ WriterTornAppend \/ WriterTornAppendHidden
  \/ WriterWorkReturns \/ WriterEffectSettles \/ WriterAppendFinal \/ WriterReleaseLease
  \/ WriterCrash \/ HostReboot \/ MoveSettledCase
  \/ CloserReadPreLease \/ CloserAdmit \/ CloserAcquireLeaseAndRecheck
  \/ CloserVerifyStoppedOwner \/ CloserPublishClosure
  \/ ReaderStart \/ ReaderCheckOpsRemains \/ ReaderCheckSettled

Spec == Init /\ [][Next]_vars

\* =========================================================================
\* IMPLEMENTATION-INDEPENDENT CONTRACT INVARIANTS
\* Any simplified rebuild of kernel/src/addons/state/ MUST preserve all six.
\* =========================================================================

\* Never move an active, closing, or unresolved case into settled/.
NoMoveWhileLiveOrClosing ==
  caseLocation = "settled" => (settled /\ ownerLease = "free" /\ caseLock = "free")

\* Never publish a closure while the owner lease is held by the writer,
\* a same-boot delegate may still be running, or a record hides in a torn tail.
NoUnsafeClosure ==
  closureState = "valid" =>
    /\ ownerLease /= "writer"
    /\ ~hiddenInTornTail
    /\ (delegateBoot = "none" \/ delegateBoot /= currentBoot)

\* Never publish a closure based on a stale pre-lease revision.
NoStaleRevisionClosure ==
  closerPc \in {"verified", "closed"} => closerLeaseRev = journalRev

\* Never release the writer lease while a started effect is still in flight.
LeaseHeldUntilEffectsSettled ==
  effectInFlight => ownerLease = "writer"

\* A lockless history reader of a published case never returns not-found
\* even when MoveSettledCase renames operations/ -> settled/ concurrently.
LocklessReaderNeverMissesCase ==
  readerPc = "done" => readerResult = "found"

\* A v2 store always has settled/ ready.
UpgradeSafe ==
  storeVersion = "v2" => settledDirReady

=============================================================================
