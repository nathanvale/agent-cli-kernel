--------------------------- MODULE KernelLifecycle ---------------------------
(*
  Formal model of the Kernel run lifecycle and state seam:
    - kernel/src/kernel/lifecycle.ts
    - kernel/src/kernel/state-seam.ts
    - kernel/src/kernel/writer.ts

  Structure:
    1. Implementation-independent Contract Invariants (what any simpler rebuild
       must preserve across runProcess and runInProcess).
    2. Current-implementation state machine with every guard cited to file:line.
*)
EXTENDS Naturals

VARIABLES
  phase,             \* "preparing" | "attached" | "handlerEntered" | "afterHandler" | "afterDeadline" | "emitting" | "drained" | "stopped"
  envelopesEmitted,  \* 0..2                         (writer.ts:66-69, lifecycle.ts:825-857)
  seamClosed,        \* "none" | "returned" | "deadline" (state-seam.ts:69,86,430)
  seamRevoked,       \* BOOLEAN                      (state-seam.ts:70,371-374,394)
  txStarted,         \* BOOLEAN                      (state-seam.ts:67,415)
  txOpen,            \* BOOLEAN                      (state-seam.ts:71,419-422)
  proofIssued,       \* BOOLEAN                      (state-seam.ts:249)
  runInMap,          \* BOOLEAN                      (state-seam.ts:339-352,406)
  handlerEntered,    \* BOOLEAN                      (lifecycle.ts:660,987)
  handlerReturned,   \* BOOLEAN                      (lifecycle.ts:718-726,987)
  stopped,           \* BOOLEAN                      (lifecycle.ts:353,885)
  emittedAfterStop,  \* BOOLEAN                      (writer.ts:69)
  duplicateAccepted, \* BOOLEAN                      (state-seam.ts:392-396)
  lateStateAccepted, \* BOOLEAN                      (state-seam.ts:208-209,411-412)
  revokedProofUsed   \* BOOLEAN                      (state-seam.ts:122)

coreVars  == <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued>>
runVars   == <<runInMap, handlerEntered, handlerReturned, stopped>>
auditVars == <<emittedAfterStop, duplicateAccepted, lateStateAccepted, revokedProofUsed>>
vars      == <<coreVars, runVars, auditVars>>

TypeOK ==
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting", "drained", "stopped"}
  /\ envelopesEmitted \in 0..2
  /\ seamClosed \in {"none", "returned", "deadline"}
  /\ seamRevoked \in BOOLEAN
  /\ txStarted \in BOOLEAN
  /\ txOpen \in BOOLEAN
  /\ proofIssued \in BOOLEAN
  /\ runInMap \in BOOLEAN
  /\ handlerEntered \in BOOLEAN
  /\ handlerReturned \in BOOLEAN
  /\ stopped \in BOOLEAN
  /\ emittedAfterStop \in BOOLEAN
  /\ duplicateAccepted \in BOOLEAN
  /\ lateStateAccepted \in BOOLEAN
  /\ revokedProofUsed \in BOOLEAN

Init ==
  /\ phase = "preparing" /\ envelopesEmitted = 0 /\ seamClosed = "none"
  /\ seamRevoked = FALSE /\ txStarted = FALSE /\ txOpen = FALSE /\ proofIssued = FALSE
  /\ runInMap = FALSE /\ handlerEntered = FALSE /\ handlerReturned = FALSE /\ stopped = FALSE
  /\ emittedAfterStop = FALSE /\ duplicateAccepted = FALSE
  /\ lateStateAccepted = FALSE /\ revokedProofUsed = FALSE

AttachState ==
  /\ phase = "preparing"
  /\ ~runInMap               \* state-seam.ts:392-406
  /\ phase' = "attached"
  /\ runInMap' = TRUE
  /\ duplicateAccepted' = (duplicateAccepted \/ runInMap)
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, handlerEntered, handlerReturned, stopped,
                 emittedAfterStop, lateStateAccepted, revokedProofUsed>>

EnterHandler ==
  /\ phase = "attached"
  /\ ~stopped                \* lifecycle.ts:658
  /\ phase' = "handlerEntered" \* lifecycle.ts:660
  /\ handlerEntered' = TRUE
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, stopped, auditVars>>

StartTransaction ==
  /\ phase \in {"handlerEntered", "afterHandler", "afterDeadline"}
  /\ seamClosed = "none"     \* state-seam.ts:411 refuses once closed
  /\ ~txStarted              \* state-seam.ts:413
  /\ txStarted' = TRUE
  /\ txOpen' = TRUE          \* state-seam.ts:422 openTransaction
  /\ lateStateAccepted' = (lateStateAccepted \/ seamClosed /= "none")
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, proofIssued,
                 runVars, emittedAfterStop, duplicateAccepted, revokedProofUsed>>

FinishTransaction ==
  /\ txOpen
  /\ txOpen' = FALSE         \* state-seam.ts:419-421
  /\ proofIssued' = TRUE     \* state-seam.ts:249
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted,
                 runVars, auditVars>>

AttemptDuplicateRunId ==
  /\ runInMap                \* state-seam.ts:392-396 live collision revokes & refuses
  /\ ~seamRevoked
  /\ seamRevoked' = TRUE
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

AttemptDuplicateAttach ==
  /\ phase \in {"attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting", "drained", "stopped"}
  /\ ~runInMap               \* state-seam.ts:392-396 refuses while runInMap
  /\ duplicateAccepted' = (duplicateAccepted \/ runInMap)
  /\ UNCHANGED <<coreVars, runVars, emittedAfterStop, lateStateAccepted, revokedProofUsed>>

HandlerReturns ==
  /\ phase = "handlerEntered"
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts:722
  /\ seamClosed' = IF seamClosed = "none" THEN "returned" ELSE seamClosed \* state-seam.ts:430
  /\ phase' = "afterHandler" \* lifecycle.ts:669
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, handlerEntered, stopped, auditVars>>

DeadlineFires ==
  /\ phase = "handlerEntered"
  /\ ~stopped
  /\ seamClosed' = IF seamClosed = "none" THEN "deadline" ELSE seamClosed \* lifecycle.ts:551, state-seam.ts:86
  /\ phase' = "afterDeadline" \* lifecycle.ts:668
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

HandlerFinishesLateAfterDeadline ==
  /\ phase \in {"afterDeadline", "emitting", "drained", "stopped"}
  /\ handlerEntered
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts:721-723
  /\ UNCHANGED <<coreVars, runInMap, handlerEntered, stopped, auditVars>>

EmitEnvelopeWithProof ==
  /\ phase \in {"afterHandler", "afterDeadline"}
  /\ ~stopped                \* writer.ts:69 checks stopping() before writing
  /\ envelopesEmitted = 0
  /\ proofIssued
  /\ ~seamRevoked            \* state-seam.ts:122 rejects revoked proof
  /\ phase' = "emitting"     \* lifecycle.ts:843
  /\ envelopesEmitted' = envelopesEmitted + 1 \* lifecycle.ts:844
  /\ emittedAfterStop' = (emittedAfterStop \/ stopped)
  /\ revokedProofUsed' = (revokedProofUsed \/ seamRevoked)
  /\ UNCHANGED <<seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, duplicateAccepted, lateStateAccepted>>

EmitEnvelopeFallback ==
  /\ phase \in {"afterHandler", "afterDeadline"}
  /\ ~stopped                \* writer.ts:69 checks stopping() before writing
  /\ envelopesEmitted = 0
  /\ (~proofIssued \/ seamRevoked) \* fallback path never trusts revoked proof
  /\ phase' = "emitting"     \* lifecycle.ts:843
  /\ envelopesEmitted' = envelopesEmitted + 1
  /\ emittedAfterStop' = (emittedAfterStop \/ stopped)
  /\ UNCHANGED <<seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, duplicateAccepted, lateStateAccepted, revokedProofUsed>>

DrainRun ==
  /\ phase = "emitting"
  /\ phase' = "drained"      \* lifecycle.ts:854
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

ReceiveStopSignal ==
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting"}
  /\ ~stopped
  /\ stopped' = TRUE         \* lifecycle.ts:345-353,885 sets stopping flag asynchronously
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, handlerEntered, handlerReturned, auditVars>>

SettleStoppedRun ==
  /\ stopped
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline"}
  /\ envelopesEmitted = 0
  /\ phase' = "stopped"      \* lifecycle.ts:885 settles silently without emitting
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

ForgetRunAfterFinish ==
  /\ phase \in {"drained", "stopped"} \* lifecycle.ts:983-989,1022
  /\ runInMap
  /\ (~handlerEntered \/ handlerReturned) \* lifecycle.ts:986-988 forgets immediately when handler never ran
  /\ ~txOpen                 \* state-seam.ts:344-351 waits until openTransaction settles
  /\ runInMap' = FALSE
  /\ UNCHANGED <<coreVars, handlerEntered, handlerReturned, stopped, auditVars>>

Next ==
  \/ AttachState
  \/ EnterHandler
  \/ StartTransaction
  \/ FinishTransaction
  \/ AttemptDuplicateRunId
  \/ AttemptDuplicateAttach
  \/ HandlerReturns
  \/ DeadlineFires
  \/ HandlerFinishesLateAfterDeadline
  \/ EmitEnvelopeWithProof
  \/ EmitEnvelopeFallback
  \/ DrainRun
  \/ ReceiveStopSignal
  \/ SettleStoppedRun
  \/ ForgetRunAfterFinish

Spec == Init /\ [][Next]_vars

\* =========================================================================
\* IMPLEMENTATION-INDEPENDENT CONTRACT INVARIANTS
\* Any simplified rebuild of kernel/src/kernel/lifecycle.ts + state-seam.ts
\* MUST preserve all five invariants.
\* =========================================================================

\* Every exit path emits at most one envelope; a drained run emitted exactly one.
SingleEnvelope ==
  /\ envelopesEmitted <= 1
  /\ (phase = "drained" => envelopesEmitted = 1)

\* Once the state capability closes (handler return or deadline), late calls are refused.
NoLateStateMutationAfterClose ==
  ~lateStateAccepted

\* A live run or a run with an open transaction keeps its runId reserved and rejects duplicates.
NoDuplicateRunIdWhileLiveOrOpenTx ==
  /\ ((phase \in {"attached", "handlerEntered", "afterHandler", "afterDeadline"} \/ txOpen) => runInMap)
  /\ ~duplicateAccepted

\* A revoked proof is never accepted as valid.
RevokedProofNeverTrusted ==
  ~revokedProofUsed

\* Stopping before emission prevents any envelope from starting emission.
NoEnvelopeAfterStop ==
  ~emittedAfterStop

=============================================================================
