--------------------------- MODULE KernelLifecycle ---------------------------
(*
  Formal model of the Kernel run lifecycle and state seam:
    - kernel/src/kernel/lifecycle.ts
    - kernel/src/kernel/state-seam.ts
    - kernel/src/kernel/writer.ts

  Structure:
    1. Implementation-independent Contract Invariants (what any simpler rebuild
       must preserve across runProcess and runInProcess).
    2. Current-implementation state machine with every guard cited to file and symbol.
*)
EXTENDS Naturals

VARIABLES
  phase,             \* "preparing" | "attached" | "handlerEntered" | "afterHandler" | "afterDeadline" | "emitting" | "drained" | "stopped"
  envelopesEmitted,  \* 0..2                         (writer.ts: createWriter() -> emit(), lifecycle.ts: deliver())
  seamClosed,        \* "none" | "returned" | "deadline" (state-seam.ts: AttachedRun.closed, closeAtDeadline(), attachState() -> close())
  seamRevoked,       \* BOOLEAN                      (state-seam.ts: AttachedRun.revoked, revokeIssued(), attachState())
  txStarted,         \* BOOLEAN                      (state-seam.ts: AttachedRun.transactionStarted, attachState() -> capability.transaction())
  txOpen,            \* BOOLEAN                      (state-seam.ts: AttachedRun.openTransaction, attachState() -> capability.transaction())
  proofIssued,       \* BOOLEAN                      (state-seam.ts: stateIssuer() -> transactionProof())
  runInMap,          \* BOOLEAN                      (state-seam.ts: forgetAttachment(), attachState())
  handlerEntered,    \* BOOLEAN                      (lifecycle.ts: runDeclaredCommand(), forgetWhenReturned())
  handlerReturned,   \* BOOLEAN                      (lifecycle.ts: handlerOf(), forgetWhenReturned())
  stopped,           \* BOOLEAN                      (lifecycle.ts: stopEvery(), runInvocation(), runAndReturn())
  emittedAfterStop,  \* BOOLEAN                      (writer.ts: createWriter() -> write(), emit())
  duplicateAccepted, \* BOOLEAN                      (state-seam.ts: attachState())
  lateStateAccepted, \* BOOLEAN                      (state-seam.ts: stateIssuer() -> recordedEffect(), attachState() -> capability.transaction())
  revokedProofUsed   \* BOOLEAN                      (state-seam.ts: knownProof())

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
  /\ ~runInMap               \* state-seam.ts: attachState()
  /\ phase' = "attached"
  /\ runInMap' = TRUE
  /\ duplicateAccepted' = (duplicateAccepted \/ runInMap)
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, handlerEntered, handlerReturned, stopped,
                 emittedAfterStop, lateStateAccepted, revokedProofUsed>>

EnterHandler ==
  /\ phase = "attached"
  /\ ~stopped                \* lifecycle.ts: runDeclaredCommand()
  /\ phase' = "handlerEntered" \* lifecycle.ts: runDeclaredCommand(), enterHandler()
  /\ handlerEntered' = TRUE
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen,
                 proofIssued, runInMap, handlerReturned, stopped, auditVars>>

StartTransaction ==
  /\ phase \in {"handlerEntered", "afterHandler", "afterDeadline"}
  /\ seamClosed = "none"     \* state-seam.ts: attachState() -> capability.transaction() refuses once closed
  /\ ~txStarted              \* state-seam.ts: attachState() -> capability.transaction()
  /\ txStarted' = TRUE
  /\ txOpen' = TRUE          \* state-seam.ts: attachState() -> openTransaction
  /\ lateStateAccepted' = (lateStateAccepted \/ seamClosed /= "none")
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, proofIssued,
                 runVars, emittedAfterStop, duplicateAccepted, revokedProofUsed>>

FinishTransaction ==
  /\ txOpen
  /\ txOpen' = FALSE         \* state-seam.ts: attachState() -> capability.transaction() ended()
  /\ proofIssued' = TRUE     \* state-seam.ts: stateIssuer() -> transactionProof()
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted,
                 runVars, auditVars>>

AttemptDuplicateRunId ==
  /\ runInMap                \* state-seam.ts: attachState(), revokeIssued() live collision revokes & refuses
  /\ ~seamRevoked
  /\ seamRevoked' = TRUE
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

AttemptDuplicateAttach ==
  /\ phase \in {"attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting", "drained", "stopped"}
  /\ ~runInMap               \* state-seam.ts: attachState() refuses while runInMap
  /\ duplicateAccepted' = (duplicateAccepted \/ runInMap)
  /\ UNCHANGED <<coreVars, runVars, emittedAfterStop, lateStateAccepted, revokedProofUsed>>

HandlerReturns ==
  /\ phase = "handlerEntered"
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts: handlerOf()
  /\ seamClosed' = IF seamClosed = "none" THEN "returned" ELSE seamClosed \* state-seam.ts: attachState() -> close()
  /\ phase' = "afterHandler" \* lifecycle.ts: runDeclaredCommand(), afterHandler()
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, handlerEntered, stopped, auditVars>>

DeadlineFires ==
  /\ phase = "handlerEntered"
  /\ ~stopped
  /\ seamClosed' = IF seamClosed = "none" THEN "deadline" ELSE seamClosed \* lifecycle.ts: afterDeadline(), state-seam.ts: closeAtDeadline()
  /\ phase' = "afterDeadline" \* lifecycle.ts: runDeclaredCommand(), afterDeadline()
  /\ UNCHANGED <<envelopesEmitted, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

HandlerFinishesLateAfterDeadline ==
  /\ phase \in {"afterDeadline", "emitting", "drained", "stopped"}
  /\ handlerEntered
  /\ ~handlerReturned
  /\ handlerReturned' = TRUE \* lifecycle.ts: handlerOf()
  /\ UNCHANGED <<coreVars, runInMap, handlerEntered, stopped, auditVars>>

EmitEnvelopeWithProof ==
  /\ phase \in {"afterHandler", "afterDeadline"}
  /\ ~stopped                \* writer.ts: createWriter() -> write(), emit() checks stopping() before writing
  /\ envelopesEmitted = 0
  /\ proofIssued
  /\ ~seamRevoked            \* state-seam.ts: knownProof() rejects revoked proof
  /\ phase' = "emitting"     \* lifecycle.ts: deliver()
  /\ envelopesEmitted' = envelopesEmitted + 1 \* lifecycle.ts: deliver() -> writer.emit()
  /\ emittedAfterStop' = (emittedAfterStop \/ stopped)
  /\ revokedProofUsed' = (revokedProofUsed \/ seamRevoked)
  /\ UNCHANGED <<seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, duplicateAccepted, lateStateAccepted>>

EmitEnvelopeFallback ==
  /\ phase \in {"afterHandler", "afterDeadline"}
  /\ ~stopped                \* writer.ts: createWriter() -> write(), emit() checks stopping() before writing
  /\ envelopesEmitted = 0
  /\ (~proofIssued \/ seamRevoked) \* writer.ts: createWriter() -> fallback() never trusts revoked proof
  /\ phase' = "emitting"     \* lifecycle.ts: deliver()
  /\ envelopesEmitted' = envelopesEmitted + 1 \* lifecycle.ts: deliver() -> writer.emit()
  /\ emittedAfterStop' = (emittedAfterStop \/ stopped)
  /\ UNCHANGED <<seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, duplicateAccepted, lateStateAccepted, revokedProofUsed>>

DrainRun ==
  /\ phase = "emitting"
  /\ phase' = "drained"      \* lifecycle.ts: runInvocation()
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

ReceiveStopSignal ==
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline", "emitting"}
  /\ ~stopped
  /\ stopped' = TRUE         \* lifecycle.ts: inFlightOn(), stopEvery() sets stopping flag asynchronously
  /\ UNCHANGED <<phase, envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runInMap, handlerEntered, handlerReturned, auditVars>>

SettleStoppedRun ==
  /\ stopped
  /\ phase \in {"preparing", "attached", "handlerEntered", "afterHandler", "afterDeadline"}
  /\ envelopesEmitted = 0
  /\ phase' = "stopped"      \* lifecycle.ts: stopEvery(), runInvocation(), runAndReturn() settles silently without emitting
  /\ UNCHANGED <<envelopesEmitted, seamClosed, seamRevoked, txStarted, txOpen, proofIssued,
                 runVars, auditVars>>

ForgetRunAfterFinish ==
  /\ phase \in {"drained", "stopped"} \* lifecycle.ts: forgetWhenReturned(), runAndReturn()
  /\ runInMap
  /\ (~handlerEntered \/ handlerReturned) \* lifecycle.ts: forgetWhenReturned() forgets immediately when handler never ran
  /\ ~txOpen                 \* state-seam.ts: forgetAttachment() waits until openTransaction settles
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

\* A live run, an unfinished handler, or an open transaction keeps its runId reserved and rejects duplicates.
NoDuplicateRunIdWhileLiveOrOpenTx ==
  /\ ((phase \in {"attached", "handlerEntered", "afterHandler", "afterDeadline"}
       \/ (handlerEntered /\ ~handlerReturned)
       \/ txOpen) => runInMap)
  /\ ~duplicateAccepted

\* A revoked proof is never accepted as valid.
RevokedProofNeverTrusted ==
  ~revokedProofUsed

\* Stopping before emission prevents any envelope from starting emission.
NoEnvelopeAfterStop ==
  ~emittedAfterStop

=============================================================================
