------------------------- MODULE DiagnosticsCustody -------------------------
(*
  Formal model of the Diagnostics add-on custody protocol:
    - kernel/src/addons/diagnostics/custody.ts
    - kernel/src/addons/diagnostics/run.ts

  Structure:
    1. Implementation-independent Contract Invariants (what any simpler rebuild
       must preserve).
    2. Current-implementation state machine for competing processes over
       .allocation-lock, stale lock removal, pruning, and closed markers.
*)
EXTENDS FiniteSets, Naturals

CONSTANTS Procs, MaxFiles

VARIABLES
  lockDir,          \* "absent" | "empty" | p \in Procs  (custody.ts: lockName, moveOnto(), tryLock())
  alive,            \* [Procs -> BOOLEAN]                (custody.ts: alive())
  procPc,           \* [Procs -> {"idle", "staging", "holding", "opened", "done", "crashed"}]
  inCritical,       \* SUBSET Procs                      (custody.ts: allocate())
  fileState,        \* [Procs -> {"absent", "open", "closedMatched", "closedMismatched", "pruned"}]
  badPrune          \* BOOLEAN                           (tracks pruning any non-closedMatched file)

vars == <<lockDir, alive, procPc, inCritical, fileState, badPrune>>

LiveFiles == { p \in Procs : fileState[p] \in {"open", "closedMatched", "closedMismatched"} }

TypeOK ==
  /\ lockDir \in ({"absent", "empty"} \cup Procs)
  /\ alive \in [Procs -> BOOLEAN]
  /\ procPc \in [Procs -> {"idle", "staging", "holding", "opened", "done", "crashed"}]
  /\ inCritical \subseteq Procs
  /\ fileState \in [Procs -> {"absent", "open", "closedMatched", "closedMismatched", "pruned"}]
  /\ badPrune \in BOOLEAN

Init ==
  /\ lockDir = "absent"
  /\ alive = [p \in Procs |-> TRUE]
  /\ procPc = [p \in Procs |-> "idle"]
  /\ inCritical = {}
  /\ fileState = [p \in Procs |-> "absent"]
  /\ badPrune = FALSE

\* --- Lock acquisition: stage pending dir with owner file, then atomic rename (custody.ts: tryLock()) ---

StageLock(p) ==
  /\ alive[p]
  /\ procPc[p] = "idle"
  /\ procPc' = [procPc EXCEPT ![p] = "staging"] \* custody.ts: tryLock()
  /\ UNCHANGED <<lockDir, alive, inCritical, fileState, badPrune>>

AcquireViaRename(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir \in {"absent", "empty"} \* custody.ts: moveOnto() rename replaces only absent or empty dir
  /\ lockDir' = p
  /\ procPc' = [procPc EXCEPT ![p] = "holding"]
  /\ inCritical' = inCritical \cup {p}
  /\ UNCHANGED <<alive, fileState, badPrune>>

\* --- Stale lock removal: only when owner is proven dead (custody.ts: ownerProvenGone(), removeStaleLock()) ---

UnlinkStaleOwner(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir \in Procs
  /\ lockDir /= p           \* custody.ts: ownerProvenGone() pid !== process.pid
  /\ ~alive[lockDir]        \* custody.ts: ownerProvenGone() !alive(pid)
  /\ lockDir' = "empty"     \* custody.ts: removeStaleLock() unlinks owner-* inside .allocation-lock
  /\ UNCHANGED <<alive, procPc, inCritical, fileState, badPrune>>

RmdirEmptyLock(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir = "empty"      \* custody.ts: removeStaleLock() rmdirSync(.allocation-lock)
  /\ lockDir' = "absent"
  /\ UNCHANGED <<alive, procPc, inCritical, fileState, badPrune>>

\* --- Prune closed-matched files and open new run file under lock (custody.ts: prune(), open()) ---

PruneOneClosed(p, q) ==
  /\ alive[p]
  /\ procPc[p] = "holding"
  /\ p \in inCritical
  /\ fileState[q] \in {"open", "closedMatched", "closedMismatched"}
  /\ fileState[q] = "closedMatched" \* custody.ts: classify(), prune() only confirmed closed files
  /\ fileState' = [fileState EXCEPT ![q] = "pruned"]
  /\ badPrune' = (badPrune \/ fileState[q] /= "closedMatched")
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical>>

FinishPruneAndOpen(p) ==
  /\ alive[p]
  /\ procPc[p] = "holding"
  /\ p \in inCritical
  /\ fileState[p] = "absent"
  /\ Cardinality(LiveFiles) + 1 <= MaxFiles \* custody.ts: prune() -> room() capacity bound
  /\ fileState' = [fileState EXCEPT ![p] = "open"] \* custody.ts: open() O_CREAT|O_EXCL
  /\ procPc' = [procPc EXCEPT ![p] = "opened"]
  /\ UNCHANGED <<lockDir, alive, inCritical, badPrune>>

ReleaseLock(p) ==
  /\ alive[p]
  /\ procPc[p] \in {"holding", "opened"} \* custody.ts: tryLock() release renames lock to retiring and calls discard()
  /\ p \in inCritical
  /\ lockDir = p
  /\ lockDir' = "absent"
  /\ inCritical' = inCritical \ {p}
  /\ procPc' = [procPc EXCEPT ![p] = IF procPc[p] = "opened" THEN "done" ELSE "idle"]
  /\ UNCHANGED <<alive, fileState, badPrune>>

\* --- After lock release, owner closes file and creates .closed-<dev>-<ino>-<size> marker ---

ConfirmClosedMatched(p) ==
  /\ alive[p]
  /\ procPc[p] = "done"
  /\ fileState[p] = "open"
  /\ fileState' = [fileState EXCEPT ![p] = "closedMatched"] \* custody.ts: confirmClosed()
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical, badPrune>>

ExternalTamperAfterClose(p) ==
  /\ fileState[p] = "closedMatched"
  /\ fileState' = [fileState EXCEPT ![p] = "closedMismatched"] \* size/ino changed -> marker invalid
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical, badPrune>>

\* --- Process crash at any step (including between ReleaseLock and ConfirmClosedMatched) ---

Crash(p) ==
  /\ alive[p]
  /\ (procPc[p] \in {"staging", "holding", "opened"} \/ (procPc[p] = "done" /\ fileState[p] = "open"))
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ procPc' = [procPc EXCEPT ![p] = "crashed"]
  /\ inCritical' = inCritical \ {p} \* dead process can execute no more steps
  /\ UNCHANGED <<lockDir, fileState, badPrune>>

Next ==
  \E p \in Procs :
    \/ StageLock(p)
    \/ AcquireViaRename(p)
    \/ UnlinkStaleOwner(p)
    \/ RmdirEmptyLock(p)
    \/ (\E q \in Procs : PruneOneClosed(p, q))
    \/ FinishPruneAndOpen(p)
    \/ ReleaseLock(p)
    \/ ConfirmClosedMatched(p)
    \/ ExternalTamperAfterClose(p)
    \/ Crash(p)

Spec == Init /\ [][Next]_vars

\* =========================================================================
\* IMPLEMENTATION-INDEPENDENT CONTRACT INVARIANTS
\* Any simplified rebuild of kernel/src/addons/diagnostics/ MUST preserve all four.
\* =========================================================================

\* At most one live process holds allocation custody at a time.
MutualExclusion ==
  Cardinality(inCritical) <= 1

\* A live holder's lock is never displaced by another process.
LiveHolderNeverDisplaced ==
  \A p \in inCritical : alive[p] => lockDir = p

\* Pruning never removes a file that is still open or whose closed marker mismatched.
NeverPruneUnclosed ==
  ~badPrune

\* Live file count never exceeds MaxFiles.
CapacityBoundRespected ==
  Cardinality(LiveFiles) <= MaxFiles

=============================================================================
