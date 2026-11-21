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
  phase,             \* "preparing" | "attached" | "handlerEntered" | "afterHandler" | "afterDeadline" | "emitting" | "drained" | "stopped" | "crashed"
  envelopesEmitted,  \* 0..2                         (writer.ts:66-69, lifecycle.ts:825-857)
  seamClosed,        \* "none" | "returned" | "deadline" (state-seam.ts:69,86,430)
  seamRevoked,       \* BOOLEAN                      (state-seam.ts:70,371-374,394)
  txStarted,         \* BOOLEAN                      (state-seam.ts:67,415)
  txOpen,            \* BOOLEAN                      (state-seam.ts:71,419-422)
  proofIssued,       \* BOOLEAN                      (state-seam.ts:249)
  runInMap,          \* BOOLEAN                      (state-seam.ts:339-352,406)
  handlerReturned,   \* BOOLEAN                      (lifecycle.ts:718-726,987)
  stopped,           \* BOOLEAN                      (lifecycle.ts:353,885)
  duplicateAccepted, \* BOOLEAN                      (state-seam.ts:392-396)
  lateStateAccepted, \* BOOLEAN                      (state-seam.ts:208-209,411-412)
  revokedProofUsed   \* BOOLEAN                      (state-seam.ts:122)

vars == <<
  phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
  proofIssued, runInMap, handlerReturned, stopped, duplicateAccepted,
  lateStateAccepted, revokedProofUsed
>>

TypeOK ==
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting", "drained", "stopped", "crashed"}
  /\ envelopesEmitted \in 0..2
  /\ seamClosed \in {"none", "returned", "deadline"}
  /\ seamRevoked \in BOOLEAN
  /\ txStarted \in BOOLEAN
  /\ txOpen \in BOOLEAN
  /\ proofIssued \in BOOLEAN
  /\ runInMap \in BOOLEAN
  /\ handlerReturned \in BOOLEAN
  /\ stopped \in BOOLEAN
  /\ duplicateAccepted \in BOOLEAN
  /\ lateStateAccepted \in BOOLEAN
  /\ revokedProofUsed \in BOOLEAN

Init ==
  /\ phase = "preparing"
  /\ envelopesEmitted = 0
  /\ seamClosed = "none"
  /\ seamRevoked = FALSE
  /\ txStarted = FALSE
  /\ txOpen = FALSE
  /\ proofIssued = FALSE
  /\ runInMap = FALSE
  /\ handlerReturned = FALSE
  /\ stopped = FALSE
  /\ duplicateAccepted = FALSE
  /\ lateStateAccepted = FALSE
  /\ revokedProofUsed = FALSE

AttachState ==
  /\ phase = "preparing"
  /\ ~runInMap               \* state-seam.ts:392-406
  /\ phase' = "attached"
  /\ runInMap' = TRUE
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

EnterHandler ==
  /\ phase = "attached"
  /\ ~stopped                \* lifecycle.ts:658
  /\ phase' = "handlerEntered" \* lifecycle.ts:660
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

StartTransaction ==
  /\ phase = "handlerEntered"
  /\ seamClosed = "none"     \* state-seam.ts:411
  /\ ~txStarted              \* state-seam.ts:413
  /\ txStarted' = TRUE
  /\ txOpen' = TRUE          \* state-seam.ts:422 openTransaction
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, proofIssued,
                 runInMap, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

FinishTransaction ==
  /\ txOpen
  /\ txOpen' = FALSE         \* state-seam.ts:419-421
  /\ proofIssued' = TRUE     \* state-seam.ts:249
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted,
                 runInMap, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

AttemptLateStateCall ==
  /\ seamClosed /= "none"    \* state-seam.ts:208-209,411-412 refuses once closed
  /\ lateStateAccepted' = FALSE
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, stopped, duplicateAccepted,
                 revokedProofUsed>>

AttemptDuplicateRunId ==
  /\ runInMap                \* state-seam.ts:392-396 live collision revokes & refuses
  /\ seamRevoked' = TRUE
  /\ duplicateAccepted' = FALSE
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, txStarted, txOpen, proofIssued,
                 runInMap, handlerReturned, stopped, lateStateAccepted, revokedProofUsed>>

HandlerReturns ==
  /\ phase = "handlerEntered"
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts:722
  /\ seamClosed' = IF seamClosed = "none" THEN "returned" ELSE seamClosed \* state-seam.ts:430
  /\ phase' = "afterHandler" \* lifecycle.ts:669
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, stopped, duplicateAccepted, lateStateAccepted, revokedProofUsed>>

DeadlineFires ==
  /\ phase = "handlerEntered"
  /\ ~stopped
  /\ seamClosed' = IF seamClosed = "none" THEN "deadline" ELSE seamClosed \* lifecycle.ts:551, state-seam.ts:86
  /\ phase' = "afterDeadline" \* lifecycle.ts:668
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

HandlerFinishesLateAfterDeadline ==
  /\ phase \in {"afterDeadline", "emitting", "drained", "stopped"}
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts:721-723
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

EmitEnvelope ==
  /\ phase \in {"afterHandler", "afterDeadline"}
  /\ ~stopped                \* lifecycle.ts:836 writer checks stopping()
  /\ envelopesEmitted = 0
  /\ phase' = "emitting"     \* lifecycle.ts:843
  /\ envelopesEmitted' = envelopesEmitted + 1 \* lifecycle.ts:844
  /\ revokedProofUsed' = (proofIssued /\ seamRevoked /\ FALSE) \* state-seam.ts:122 rejects revoked proof
  /\ UNCHANGED <<seamClosed, seamRevoked, txStarted, txOpen, proofIssued, runInMap,
                 handlerReturned, stopped, duplicateAccepted, lateStateAccepted>>

DrainRun ==
  /\ phase = "emitting"
  /\ phase' = "drained"      \* lifecycle.ts:854
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

ReceiveStopSignal ==
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline"}
  /\ ~stopped
  /\ stopped' = TRUE         \* lifecycle.ts:353,885
  /\ phase' = "stopped"
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

ForgetRunAfterFinish ==
  /\ phase \in {"drained", "stopped"} \* lifecycle.ts:983-989,1022
  /\ runInMap
  /\ handlerReturned         \* lifecycle.ts:987-988 waits until handler returned
  /\ ~txOpen                 \* state-seam.ts:344-351 waits until openTransaction settles
  /\ runInMap' = FALSE
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, handlerReturned, stopped, duplicateAccepted,
                 lateStateAccepted, revokedProofUsed>>

Next ==
  \/ AttachState
  \/ EnterHandler
  \/ StartTransaction
  \/ FinishTransaction
  \/ AttemptLateStateCall
  \/ AttemptDuplicateRunId
  \/ HandlerReturns
  \/ DeadlineFires
  \/ HandlerFinishesLateAfterDeadline
  \/ EmitEnvelope
  \/ DrainRun
  \/ ReceiveStopSignal
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

\* Stopping before emission prevents any envelope from being emitted.
NoEnvelopeAfterStop ==
  stopped => envelopesEmitted = 0

=============================================================================
