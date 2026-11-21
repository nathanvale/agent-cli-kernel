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
    2. Current-implementation state machine with every guard cited to file and symbol.
*)
EXTENDS Naturals

CONSTANTS MaxRev

VARIABLES
  storeVersion,        \* "v1" | "v2"  (store.ts: journals, upgradeStore())
  settledDirReady,     \* BOOLEAN      (store.ts: upgradeStore())
  admissionLock,       \* "none" | "writer" | "closer"  (install.ts: acquire())
  caseLocation,        \* "absent" | "staging" | "operations" | "settled" (store.ts: moveSettledCase(), publishOperation())
  ownerLease,          \* "free" | "writer" | "closer"  (install.ts: caseUnderLease(), begin(), runRecorded())
  caseLock,            \* "free" | "closer"             (install.ts: movable(), admitClosure())
  writerPc,            \* "idle" | "admitted" | "published" | "effectStarted" | "workEnded" | "finalAppended" | "done" | "crashed"
  effectInFlight,      \* BOOLEAN      (install.ts: runRecorded(), recorder())
  tornTail,            \* BOOLEAN      (framing.ts: parseRecords(), store.ts: appendEvent())
  hiddenInTornTail,    \* BOOLEAN      (framing.ts: recordStartsMidLine(), install.ts: stoppedOwnerProblem())
  delegateBoot,        \* "none" | "boot1" | "boot2"    (store.ts: appendDelegateStart(), delegateBoot())
  currentBoot,         \* "boot1" | "boot2"             (install.ts: stoppedOwnerProblem())
  closureState,        \* "absent" | "valid"            (store.ts: publishClosure())
  settled,             \* BOOLEAN      (store.ts: statusOf())
  ownSettled,          \* BOOLEAN      (writer appended completion/not-applied)
  journalRev,          \* 0..MaxRev    (store.ts: revisionOf())
  closerPc,            \* "idle" | "readPreLease" | "admitted" | "leaseHeld" | "verified" | "closed"
  closerReqRev,        \* 0..MaxRev    (install.ts: caseRead(), closeCase())
  readerPc,            \* "idle" | "readOps" | "readSettled" | "done" (store.ts: fromCaseFolders())
  readerSawOps,        \* BOOLEAN      (store.ts: fromCaseFolders())
  readerResult         \* "none" | "found" | "not-found"

storeVars  == <<storeVersion, settledDirReady>>
lockVars   == <<admissionLock, ownerLease, caseLock>>
caseVars   == <<caseLocation, closureState, settled, ownSettled, journalRev>>
writerVars == <<writerPc, effectInFlight, tornTail, hiddenInTornTail, delegateBoot, currentBoot>>
closerVars == <<closerPc, closerReqRev>>
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
  /\ ownSettled \in BOOLEAN
  /\ journalRev \in 0..MaxRev
  /\ closerPc \in {"idle", "readPreLease", "admitted", "leaseHeld", "verified", "closed"}
  /\ closerReqRev \in 0..MaxRev
  /\ readerPc \in {"idle", "readOps", "readSettled", "done"}
  /\ readerSawOps \in BOOLEAN
  /\ readerResult \in {"none", "found", "not-found"}

Init ==
  /\ storeVersion = "v1" /\ settledDirReady = FALSE
  /\ admissionLock = "none" /\ ownerLease = "free" /\ caseLock = "free"
  /\ caseLocation = "absent" /\ closureState = "absent" /\ settled = FALSE /\ ownSettled = FALSE /\ journalRev = 0
  /\ writerPc = "idle" /\ effectInFlight = FALSE /\ tornTail = FALSE /\ hiddenInTornTail = FALSE
  /\ delegateBoot = "none" /\ currentBoot = "boot1"
  /\ closerPc = "idle" /\ closerReqRev = 0
  /\ readerPc = "idle" /\ readerSawOps = FALSE /\ readerResult = "none"

\* --- Store v1 -> v2 upgrade under admission lock (store.ts: upgradeStore()) ---

WriterAdmit ==
  /\ writerPc = "idle"
  /\ admissionLock = "none" \* install.ts: acquire()
  /\ admissionLock' = "writer"
  /\ writerPc' = "admitted"
  /\ UNCHANGED <<storeVars, ownerLease, caseLock, caseVars, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

UpgradeCreateSettled ==
  /\ admissionLock /= "none" \* install.ts: coordinate()
  /\ storeVersion = "v1"     \* store.ts: upgradeStore()
  /\ ~settledDirReady        \* store.ts: upgradeStore()
  /\ settledDirReady' = TRUE
  /\ UNCHANGED <<storeVersion, lockVars, caseVars, writerVars, closerVars, readerVars>>

UpgradeSwapFormat ==
  /\ admissionLock /= "none" \* install.ts: coordinate()
  /\ storeVersion = "v1"     \* store.ts: upgradeStore()
  /\ settledDirReady         \* store.ts: upgradeStore()
  /\ storeVersion' = "v2"
  /\ UNCHANGED <<settledDirReady, lockVars, caseVars, writerVars, closerVars, readerVars>>

\* --- Writer publishes operation, records effects, finishes or crashes ---

WriterPublish ==
  /\ writerPc = "admitted"
  /\ admissionLock = "writer"
  /\ storeVersion = "v2"       \* install.ts: coordinate() completes upgrade before open()
  /\ caseLocation = "absent"
  /\ ownerLease = "free"       \* store.ts: publishOperation()
  /\ caseLocation' = "operations" \* store.ts: publishOperation()
  /\ ownerLease' = "writer"
  /\ admissionLock' = "none"   \* install.ts: open()
  /\ writerPc' = "published"
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, caseLock, closureState, settled, ownSettled, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterStartEffect ==
  /\ writerPc = "published"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts: appendEvent() -> endsOnWholeRecord() guard
  /\ writerPc' = "effectStarted"
  /\ effectInFlight' = TRUE    \* install.ts: recorder() tracked in-flight record
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, ownSettled, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterAdmitDelegate ==
  /\ writerPc = "effectStarted"
  /\ effectInFlight
  /\ ownerLease = "writer"
  /\ delegateBoot = "none"
  /\ ~tornTail                 \* store.ts: appendEvent() refuses append after torn tail
  /\ delegateBoot' = currentBoot \* install.ts: recorder() -> admitStart()
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, ownSettled, writerPc,
                 effectInFlight, tornTail, hiddenInTornTail, currentBoot, closerVars, readerVars>>

WriterTornAppend ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts: appendEvent() partial write leaves torn tail
  /\ tornTail' = TRUE
  /\ journalRev' = NextRev     \* store.ts: revisionOf() hashes raw bytes including torn tail
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, ownSettled, writerPc,
                 effectInFlight, hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterTornAppendHidden ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* framing.ts: recordStartsMidLine() mid-line record hidden in torn tail
  /\ tornTail' = TRUE
  /\ hiddenInTornTail' = TRUE
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, settled, ownSettled, writerPc,
                 effectInFlight, delegateBoot, currentBoot, closerVars, readerVars>>

WriterWorkReturns ==
  /\ writerPc = "effectStarted"
  /\ ownerLease = "writer"
  /\ writerPc' = "workEnded"   \* install.ts: runRecorded() sets recording.ended = true
  /\ UNCHANGED <<storeVars, lockVars, caseVars, effectInFlight, tornTail, hiddenInTornTail,
                 delegateBoot, currentBoot, closerVars, readerVars>>

WriterEffectSettles ==
  /\ writerPc \in {"effectStarted", "workEnded"}
  /\ effectInFlight
  /\ effectInFlight' = FALSE   \* install.ts: runRecorded() awaits settled(recording.records)
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerPc, tornTail, hiddenInTornTail,
                 delegateBoot, currentBoot, closerVars, readerVars>>

WriterAppendFinal ==
  /\ writerPc = "workEnded"
  /\ ~effectInFlight           \* install.ts: runRecorded() waits for started effects first
  /\ ownerLease = "writer"
  /\ ~tornTail                 \* store.ts: appendEvent() -> endsOnWholeRecord()
  /\ settled' = TRUE           \* install.ts: runRecorded(), finish()
  /\ ownSettled' = TRUE
  /\ writerPc' = "finalAppended"
  /\ journalRev' = NextRev
  /\ UNCHANGED <<storeVars, lockVars, caseLocation, closureState, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, currentBoot, closerVars, readerVars>>

WriterReleaseLease ==
  /\ writerPc \in {"finalAppended", "workEnded"}
  /\ ~effectInFlight           \* install.ts: runRecorded() lease held until effects settle
  /\ (writerPc = "finalAppended" \/ tornTail) \* install.ts: finish() catches failed append so runRecorded() still ends
  /\ ownerLease = "writer"
  /\ ownerLease' = "free"      \* install.ts: runRecorded() -> held.releaseLease()
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
  /\ currentBoot' = "boot2"    \* boot_id changes on machine restart (install.ts: stoppedOwnerProblem())
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerPc, effectInFlight, tornTail,
                 hiddenInTornTail, delegateBoot, closerVars, readerVars>>

\* --- Mover renames settled case operations/ -> settled/ under admission lock ---

MoveSettledCase ==
  /\ storeVersion = "v2"       \* install.ts: moveSettled() -> settledIsPrivate()
  /\ settledDirReady
  /\ admissionLock = "none"
  /\ caseLocation = "operations"
  /\ settled                   \* install.ts: moveSettled() status /= "unresolved"
  /\ ownerLease = "free"       \* install.ts: movable() -> lockFree(owner.lease)
  /\ caseLock = "free"         \* install.ts: movable() -> lockFree(case:<id>)
  /\ caseLocation' = "settled" \* store.ts: moveSettledCase() renameSync
  /\ UNCHANGED <<storeVars, lockVars, closureState, settled, ownSettled, journalRev,
                 writerVars, closerVars, readerVars>>

\* --- Closer protocol (install.ts: stoppedOwnerProblem(), caseUnderLease(), closureDecision(), admitClosure(), closeCase()) ---

CloserReadPreLease ==
  /\ closerPc = "idle"
  /\ caseLocation = "operations"
  /\ ~settled                  \* install.ts: settledCheck(), closeCase() -> caseRead()
  /\ closerPc' = "readPreLease"
  /\ closerReqRev' = journalRev
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, readerVars>>

CloserAdmit ==
  /\ closerPc = "readPreLease"
  /\ admissionLock = "none"    \* install.ts: admitClosure() -> coordinate()
  /\ caseLock = "free"         \* install.ts: admitClosure() -> coordinate()
  /\ caseLocation = "operations"
  /\ admissionLock' = "closer"
  /\ caseLock' = "closer"
  /\ closerPc' = "admitted"
  /\ UNCHANGED <<storeVars, ownerLease, caseVars, writerVars, closerReqRev, readerVars>>

CloserAcquireLeaseAndRecheck ==
  /\ closerPc = "admitted"
  /\ ownerLease = "free"       \* install.ts: caseUnderLease() tryLock(owner.lease)
  /\ ~settled                  \* install.ts: caseUnderLease() -> caseRead() under lease
  /\ journalRev = closerReqRev \* install.ts: caseRead() stale-revision check under lease
  /\ ownerLease' = "closer"
  /\ admissionLock' = "none"   \* install.ts: open(), closeCase() releases admissionLock before publishClosure()
  /\ closerPc' = "leaseHeld"
  /\ UNCHANGED <<storeVars, caseLock, caseVars, writerVars, closerReqRev, readerVars>>

CloserVerifyStoppedOwner ==
  /\ closerPc = "leaseHeld"
  /\ ownerLease = "closer"
  /\ ~hiddenInTornTail         \* install.ts: stoppedOwnerProblem() recordHiddenInTornTail
  /\ (delegateBoot = "none" \/ delegateBoot /= currentBoot) \* install.ts: stoppedOwnerProblem() delegateBoot
  /\ closerPc' = "verified"
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerReqRev, readerVars>>

CloserPublishClosure ==
  /\ closerPc = "verified"
  /\ ownerLease = "closer"
  /\ caseLocation = "operations"
  /\ closureState = "absent"   \* store.ts: publishClosure() linkSync exclusive
  /\ closureState' = "valid"
  /\ settled' = TRUE
  /\ ownerLease' = "free"      \* install.ts: admitClosure() -> release()
  /\ caseLock' = "free"        \* install.ts: admitClosure() -> release()
  /\ closerPc' = "closed"
  /\ UNCHANGED <<storeVars, admissionLock, caseLocation, ownSettled, journalRev, writerVars, closerReqRev, readerVars>>

\* --- Lockless history reader racing MoveSettledCase (store.ts: fromCaseFolders(), readCase()) ---

ReaderStart ==
  /\ readerPc = "idle"
  /\ caseLocation \in {"operations", "settled"} \* target case was published
  /\ readerPc' = "readOps"
  /\ readerSawOps' = (caseLocation = "operations") \* store.ts: fromCaseFolders() reads operations/<id>
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerVars, readerResult>>

ReaderCheckOpsRemains ==
  /\ readerPc = "readOps"
  /\ IF caseLocation = "operations" \* store.ts: fromCaseFolders() -> folderRemains()
     THEN /\ readerResult' = IF readerSawOps THEN "found" ELSE "not-found"
          /\ readerPc' = "done"
     ELSE /\ readerPc' = "readSettled" \* moved during read -> check settled/<id>
          /\ readerResult' = "none"
  /\ UNCHANGED <<storeVars, lockVars, caseVars, writerVars, closerVars, readerSawOps>>

ReaderCheckSettled ==
  /\ readerPc = "readSettled"
  /\ readerResult' = IF caseLocation = "settled" THEN "found" ELSE "not-found" \* store.ts: fromCaseFolders()
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

\* Never verify or publish a closure against a revision different from the close
\* request's revision, and never publish a closure on a case the writer already settled.
NoStaleRevisionClosure ==
  /\ (closerPc \in {"leaseHeld", "verified", "closed"} => closerReqRev = journalRev)
  /\ (closureState = "valid" => closerReqRev = journalRev /\ ~ownSettled)

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
