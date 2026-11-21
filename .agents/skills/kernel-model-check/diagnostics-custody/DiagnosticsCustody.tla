------------------------- MODULE DiagnosticsCustody -------------------------
(*
  Formal model of the Diagnostics add-on custody protocol:
    - kernel/src/addons/diagnostics/custody.ts
    - kernel/src/addons/diagnostics/run.ts

  Structure:
    1. Implementation-independent Contract Invariants (what any simpler rebuild
       must preserve).
    2. Current-implementation state machine for two processes competing over
       .allocation-lock, stale lock removal, pruning, and closed markers.
*)
EXTENDS FiniteSets, Naturals

CONSTANTS Procs, MaxFiles

VARIABLES
  lockDir,          \* "absent" | "empty" | p \in Procs  (custody.ts:25,240-284)
  alive,            \* [Procs -> BOOLEAN]                (custody.ts:153-161)
  procPc,           \* [Procs -> {"idle", "staging", "holding", "pruned", "opened", "done", "crashed"}]
  inCritical,       \* SUBSET Procs                      (custody.ts:463-472)
  fileState         \* [Procs -> {"absent", "open", "closedMatched", "closedMismatched", "pruned"}]

vars == <<lockDir, alive, procPc, inCritical, fileState>>

LiveFiles == { p \in Procs : fileState[p] \in {"open", "closedMatched", "closedMismatched"} }

TypeOK ==
  /\ lockDir \in ({"absent", "empty"} \cup Procs)
  /\ alive \in [Procs -> BOOLEAN]
  /\ procPc \in [Procs -> {"idle", "staging", "holding", "pruned", "opened", "done", "crashed"}]
  /\ inCritical \subseteq Procs
  /\ fileState \in [Procs -> {"absent", "open", "closedMatched", "closedMismatched", "pruned"}]

Init ==
  /\ lockDir = "absent"
  /\ alive = [p \in Procs |-> TRUE]
  /\ procPc = [p \in Procs |-> "idle"]
  /\ inCritical = {}
  /\ fileState = [p \in Procs |-> "absent"]

\* --- Lock acquisition: stage pending dir with owner file, then atomic rename (custody.ts:249-284) ---

StageLock(p) ==
  /\ alive[p]
  /\ procPc[p] = "idle"
  /\ procPc' = [procPc EXCEPT ![p] = "staging"] \* custody.ts:256-266
  /\ UNCHANGED <<lockDir, alive, inCritical, fileState>>

AcquireViaRename(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir \in {"absent", "empty"} \* custody.ts:238-247 rename replaces only absent or empty dir
  /\ lockDir' = p
  /\ procPc' = [procPc EXCEPT ![p] = "holding"]
  /\ inCritical' = inCritical \cup {p}
  /\ UNCHANGED <<alive, fileState>>

\* --- Stale lock removal: only when owner is proven dead (custody.ts:202-236) ---

UnlinkStaleOwner(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir \in Procs
  /\ lockDir /= p           \* custody.ts:210 pid !== process.pid
  /\ ~alive[lockDir]        \* custody.ts:210 !alive(pid)
  /\ lockDir' = "empty"     \* custody.ts:229 unlinks owner-* inside .allocation-lock
  /\ UNCHANGED <<alive, procPc, inCritical, fileState>>

RmdirEmptyLock(p) ==
  /\ alive[p]
  /\ procPc[p] = "staging"
  /\ lockDir = "empty"      \* custody.ts:231 rmdirSync(.allocation-lock)
  /\ lockDir' = "absent"
  /\ UNCHANGED <<alive, procPc, inCritical, fileState>>

\* --- Prune closed-matched files and open new run file under lock (custody.ts:346-422) ---

PruneOneClosed(p, q) ==
  /\ alive[p]
  /\ procPc[p] = "holding"
  /\ p \in inCritical
  /\ fileState[q] = "closedMatched" \* custody.ts:319-327,356-374 only confirmed closed files
  /\ fileState' = [fileState EXCEPT ![q] = "pruned"]
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical>>

FinishPruneAndOpen(p) ==
  /\ alive[p]
  /\ procPc[p] = "holding"
  /\ p \in inCritical
  /\ fileState[p] = "absent"
  /\ Cardinality(LiveFiles) + 1 <= MaxFiles \* custody.ts:353-355 capacity bound
  /\ fileState' = [fileState EXCEPT ![p] = "open"] \* custody.ts:411-421 O_CREAT|O_EXCL
  /\ procPc' = [procPc EXCEPT ![p] = "opened"]
  /\ UNCHANGED <<lockDir, alive, inCritical>>

ReleaseLock(p) ==
  /\ alive[p]
  /\ procPc[p] \in {"holding", "opened"} \* custody.ts:276-283 rename(lock, retiring) + discard
  /\ p \in inCritical
  /\ lockDir = p
  /\ lockDir' = "absent"
  /\ inCritical' = inCritical \ {p}
  /\ procPc' = [procPc EXCEPT ![p] = IF procPc[p] = "opened" THEN "done" ELSE "idle"]
  /\ UNCHANGED <<alive, fileState>>

\* --- After lock release, owner closes file and creates .closed-<dev>-<ino>-<size> marker ---

ConfirmClosedMatched(p) ==
  /\ alive[p]
  /\ procPc[p] = "done"
  /\ fileState[p] = "open"
  /\ fileState' = [fileState EXCEPT ![p] = "closedMatched"] \* custody.ts:475-488
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical>>

ExternalTamperAfterClose(p) ==
  /\ fileState[p] = "closedMatched"
  /\ fileState' = [fileState EXCEPT ![p] = "closedMismatched"] \* size/ino changed -> marker invalid
  /\ UNCHANGED <<lockDir, alive, procPc, inCritical>>

\* --- Process crash at any step ---

Crash(p) ==
  /\ alive[p]
  /\ procPc[p] \in {"staging", "holding", "opened"}
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ procPc' = [procPc EXCEPT ![p] = "crashed"]
  /\ inCritical' = inCritical \ {p} \* dead process can execute no more steps
  /\ UNCHANGED <<lockDir, fileState>>

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
  \A p \in Procs : fileState[p] = "pruned" => (procPc[p] = "done")

\* Live file count never exceeds MaxFiles.
CapacityBoundRespected ==
  Cardinality(LiveFiles) <= MaxFiles

=============================================================================
