export type Supplier =
  | "T3-after-R8"
  | "T2-slice-B"
  | "T4"
  | "T5"
  | "T6"
  | "T8"
  | "qualification";

export type StateCase = {
  readonly id: string;
  readonly sources: string;
  readonly observation: string;
  readonly red: string;
} & (
  | {
      readonly status: "executable";
      readonly layer: "process" | "component";
      readonly platform: "coordination" | "any";
      readonly nonRoot?: true;
    }
  | {
      readonly status: "pending";
      readonly supplier: Supplier;
      readonly reason: string;
    }
);

const processLayer = { status: "executable", layer: "process" } as const;
const coordinated = { ...processLayer, platform: "coordination" } as const;
const anyPlatform = { ...processLayer, platform: "any" } as const;
const component = {
  status: "executable",
  layer: "component",
  platform: "any",
} as const;
const transactionComponent = {
  ...component,
  platform: "coordination",
} as const;
const unqualified = {
  status: "pending",
  supplier: "qualification",
  reason:
    "Needs a reviewed qualification row (REC-7b). The foundation table is empty, so the expected foundation outcome is O10 and Q01.",
} as const;
const sliceB = {
  status: "pending",
  supplier: "T2-slice-B",
  reason:
    "Needs a real delegated program started through the programs add-on bound to the recorded effect after slice B.",
} as const;

export const stateCases: readonly StateCase[] = [
  {
    id: "J01.a-intent-durable-before-effect",
    ...coordinated,
    sources: "REC-1; CMD-11; V-23",
    observation:
      "Killed at K-intent: the test reader finds one intent bound to command, run, sorted effects, canonical scope and revisions, with no secret bytes; ledger count 0; pending lists it.",
    red: "Perform the effect before the intent is published.",
  },
  {
    id: "J01.b-fault-after-intent-never-completed",
    ...coordinated,
    sources: "REC-1; CMD-11; V-23",
    observation:
      "The resource write faults after the intent: the result is never completed and the case is listed pending or unknown.",
    red: "Record completion when the operation returns.",
  },
  {
    id: "J01.c-crash-before-publication",
    ...coordinated,
    sources: "CMD-11; REC-8",
    observation:
      "Killed after the staging intent and before publication: no operation is listed, ledger count 0, and the next overlapping change is admitted.",
    red: "Treat staging as published operations.",
  },
  {
    id: "J02.a-readback-false-no-completion",
    ...coordinated,
    sources: "CMD-10a; CMD-11; V-23",
    observation:
      "The write leaves a different resource: no completion record and the result is never SUCCESS_COMPLETED.",
    red: "Record completion before read-back.",
  },
  {
    id: "J02.b-valid-twin-completes",
    ...coordinated,
    sources: "CMD-10a; CMD-11; V-23",
    observation:
      "Write plus independent read-back: completion record present, SUCCESS_COMPLETED, effects.completed equals the declared effects, exit 0.",
    red: "Omit the completion record.",
  },
  {
    id: "J03.a-silent-no-op",
    ...coordinated,
    sources: "CMD-11; REC-1; V-23",
    observation:
      "The sink accepts the call but leaves the resource unchanged: never success, the effect is not completed, it is uncertain, ledger count 0.",
    red: "Trust the write call's return as read-back.",
  },
  {
    id: "J04.a-torn-completion",
    ...coordinated,
    sources: "CMD-11; DISC-14; REC-9 row 9",
    observation:
      "Truncate the final completion record: the case is listed again and history never reports it completed.",
    red: "Parse a valid-looking prefix of the final record.",
  },
  {
    id: "J04.b-checksum-completion",
    ...coordinated,
    sources: "CMD-11; DISC-14",
    observation:
      "Flip one payload byte of the final completion record: the case is listed again.",
    red: "Skip checksum validation.",
  },
  {
    id: "J04.c-corrupt-intent-refuses",
    ...coordinated,
    sources: "CMD-11; DISC-14 item 5",
    observation:
      "Corrupt an intent: the report refuses honestly and never returns an empty successful list.",
    red: "Skip an unreadable intent and report the rest.",
  },
  {
    id: "J04.d-torn-closure",
    ...coordinated,
    sources: "REC-4; REC-9 row 9",
    observation:
      "Truncate a closure record: it is not a valid closure, the case is listed again, and a new closure is refused as conflicting with the damaged record.",
    red: "Accept a closure file by its presence.",
  },
  {
    id: "J04.e-corrupt-middle-record-refuses",
    ...coordinated,
    sources: "CMD-11; DISC-14 item 5",
    observation:
      "Damage a non-final event record: the report refuses honestly.",
    red: "Treat any damage as a torn tail.",
  },
  {
    id: "J04.f-torn-effect-started",
    ...coordinated,
    sources: "CMD-11; REC-1",
    observation:
      "A torn final effect-started record: the case is listed and recovery classifies the effect uncertain unless the observer proves it present.",
    red: "Classify a torn tail as not started.",
  },
  {
    id: "J05.a-readback-failure-unknown",
    ...coordinated,
    sources: "CMD-11; WIRE-16; V-23",
    observation:
      "The read-back throws after the write: failed, unknown, effect uncertain, handoff, retryable false, exit 1, never 75, never completed.",
    red: "Map read-back failure to completed or a transient cause.",
  },
  {
    id: "J06.a-partial-versus-unknown",
    ...coordinated,
    sources: "CMD-11; WIRE-10; WIRE-12",
    observation:
      "Two effects, killed after the first is ledger-confirmed and before the second starts: history reads back the first as completed and the never-started absent second as remaining.",
    red: "Classify from the journal without the observer.",
  },
  {
    id: "J06.b-started-second-uncertain",
    ...coordinated,
    sources: "CMD-11; REC-1",
    observation:
      "Killed after the second effect started but before it happened: history reports the second uncertain, never remaining.",
    red: "Treat current absence as non-application.",
  },
  {
    id: "J07.a-diagnostics-removed",
    status: "pending",
    supplier: "T5",
    reason:
      "No diagnostics add-on writes files yet; the state add-on reads none, but the repeat-after-removal observation needs T5's files.",
    sources: "REC-2; CMD-16; REC-9 row 10",
    observation:
      "Repeat J01, P01 and K02 after deleting diagnostics: same pending, admission, closure and scope.",
    red: "Derive any admission, scope or recovery fact from diagnostics.",
  },

  {
    id: "L01.a-kill-at-intent-listed",
    ...coordinated,
    sources: "DISC-14; V-19",
    observation:
      "Killed at K-intent: listed once with matching identities and sorted unique effects.",
    red: "Report an empty list while an intent has no outcome.",
  },
  {
    id: "L01.b-kill-at-effect-listed",
    ...coordinated,
    sources: "DISC-14; V-19",
    observation: "Killed at K-effect: listed once.",
    red: "Report an empty list while an intent has no outcome.",
  },
  {
    id: "L01.c-kill-at-complete-absent",
    ...coordinated,
    sources: "DISC-14 item 3; V-19",
    observation:
      "Killed at K-complete after its completion record: not listed (the valid completion ends the listing) and history retains the intent and completion.",
    red: "Delete history at completion.",
  },
  {
    id: "L01.d-unknown-result-listed",
    ...coordinated,
    sources: "DISC-14; V-19",
    observation: "A run that recorded an unknown result is listed.",
    red: "End the listing on any final record.",
  },
  {
    id: "L01.e-completed-run-absent",
    ...coordinated,
    sources: "DISC-14; V-19",
    observation: "A completed run is absent from the report.",
    red: "List resolved runs.",
  },
  {
    id: "L02.a-live-listed-without-blocking",
    ...coordinated,
    sources: "DISC-14; REC-2; V-19",
    observation:
      "A live run held after its intent is listed, and the report returns while the writer still holds its coordination locks.",
    red: "Hide live intents or block the report on coordination.",
  },
  {
    id: "L03.a-report-read-only",
    ...coordinated,
    sources: "DISC-14; DISC-14a; CMD-4; V-19",
    observation:
      "Every state, coordination and resource byte is identical before and after the report; inspect, unchanged, empty collections; success guidance is the declared fixed step, never done.",
    red: "The report writes or derives done.",
  },
  {
    id: "L04.a-corrupt-journal-refuses",
    ...coordinated,
    nonRoot: true,
    sources: "DISC-14 item 5; DISC-15; V-19",
    observation:
      "A corrupt format record or unreadable operations directory refuses with the report's admitted cause, never an empty success.",
    red: "Treat unreadable state as an empty successful report.",
  },
  {
    id: "L04.b-missing-store-refuses",
    ...anyPlatform,
    sources: "DISC-14 item 5",
    observation:
      "A missing state root refuses honestly instead of reporting nothing unfinished.",
    red: "Report an empty list for a missing store.",
  },
  {
    id: "L04.c-empty-report-guidance",
    ...coordinated,
    sources: "DISC-15; REC-6",
    observation:
      "A genuinely empty report carries the fixed inspection guidance and no retry or repeat step.",
    red: "Offer a retry step from an empty report.",
  },
  {
    id: "L05.a-history-before-and-after-closure",
    ...coordinated,
    sources: "REC-6; STEP-10",
    observation:
      "History for a validated operation identity shows intent, scope, journal facts and no closure, then the closure disposition after closure, with no secret bytes and no state change.",
    red: "Let history mutate state.",
  },
  {
    id: "L05.b-unresolved-handoff-binds-history",
    ...coordinated,
    sources: "REC-6; STEP-10; STEP-12; STEP-13",
    observation:
      "The unresolved-case refusal hands off to the history route with args equal to the blocking operation identity.",
    red: "Substitute caller text into the fixed guidance.",
  },
  {
    id: "L05.c-history-refuses-invalid-identity",
    ...anyPlatform,
    sources: "REC-6; CMD-9a",
    observation:
      "A malformed operation identity is refused by input validation before any read.",
    red: "Read a caller-chosen path.",
  },
  {
    id: "L06.a-every-changing-command-names-inspect",
    ...anyPlatform,
    sources: "DISC-13; CMD-10; V-19; GATE-7 K2 K5 K6",
    observation:
      "Discovery shows every changing specimen command, including the recovery command, naming the declared inspect report as ifNoResult; compiler locks K2, K5 and K6 stay in tests/kernel/locks.",
    red: "Remove the state-owned value requirement.",
  },
  {
    id: "L06.b-abort-then-report",
    ...coordinated,
    sources: "LIFE-12; DISC-14; T2 L06 follow-up",
    observation:
      "The process aborts (SIGABRT) after its intent: no envelope, and the report lists the intent.",
    red: "Treat a missing result as unchanged.",
  },

  {
    id: "K01.a-recovery-is-changing",
    ...coordinated,
    sources: "REC-3; REC-4; CMD-4; REC-9 row 6",
    observation:
      "The close command is declared changing with its own effect, stations and inspect ifNoResult; recording closure reports its own completed recovery effect, never inspect and never the original operation's success.",
    red: "Expose closure through the report or history route.",
  },
  {
    id: "K02.a-kill-after-effect-two-later-changes",
    ...coordinated,
    sources: "REC-3; REC-4; REC-9 row 1; V-42",
    observation:
      "Killed at K-effect, closed completed under fixture qualification, only that case leaves the report while an unrelated case stays, then two later overlapping changes succeed; the first effect count stays 1 throughout.",
    red: "Replay during recovery, keep a global barrier, or remove the unrelated case.",
  },
  {
    id: "K03.a-absence-is-not-not-applied",
    ...coordinated,
    sources: "REC-1; REC-4; REC-9 row 3; V-42",
    observation:
      "A sent message later deleted: not-applied closure is refused, no closure, still listed, no resend, send count stays 1.",
    red: "Treat absence as non-application.",
  },
  {
    id: "K03.b-exclusion-permits-not-applied",
    ...coordinated,
    sources: "REC-1; REC-4; V-42",
    observation:
      "Host evidence that independently rules out every attempted effect permits not-applied closure.",
    red: "Refuse every not-applied closure.",
  },
  {
    id: "K04.a-unknown-closure-unavailable",
    ...coordinated,
    sources: "REC-4; REC-5; REC-9 row 4; V-42",
    observation:
      "Without a qualified authority source an outcome-unknown closure is unavailable with a handoff; the case stays listed and no record is written.",
    red: "Close as outcome-unknown without authority.",
  },
  {
    id: "K04.b-unknown-closure-with-fixture-authority",
    status: "pending",
    supplier: "T3-after-R8",
    reason:
      "The state-side human closure path is not built: outcome-unknown is refused unconditionally and close() has no authority input. T3 builds it after the R8 item-identity decision, with T4's C01 fixture authority; the state side records the item fields only.",
    sources: "REC-4; REC-5; T4 C01 C04",
    observation:
      "With a valid fixture grant, outcome-unknown ends the case; original facts byte-identical; no replay.",
    red: "Rewrite original effect facts into the closure.",
  },
  {
    id: "K05.a-forged-closure-authority",
    ...coordinated,
    sources: "REC-5; REC-9 row 5; V-42",
    observation:
      "A caller flag or same-user grant file offered as closure authority is refused: no closure, still listed, barrier retained.",
    red: "Accept a caller-writable representation as authority.",
  },
  {
    id: "K05.b-actual-credential-nonforgeability",
    status: "pending",
    supplier: "qualification",
    reason:
      "Real authority source qualification under actual caller credentials; no provider is selected (REC-5).",
    sources: "REC-5; V-42; T4 C03",
    observation:
      "Under the caller's own credentials, creating or altering a valid human grant fails.",
    red: "Accept a same-user writable grant.",
  },
  {
    id: "K06.a-closure-retry-same-identity",
    ...coordinated,
    sources: "REC-4; CMD-11; REC-9 row 9",
    observation:
      "Repeating the closure request with the same identity returns the prior disposition with no new record and no domain effect.",
    red: "Rerun recovery effects or append a second closure.",
  },
  {
    id: "K06.b-conflicting-closure-refused",
    ...coordinated,
    sources: "REC-4",
    observation:
      "A different closure identity or content for a closed case is refused and the closure bytes are unchanged.",
    red: "Overwrite the closure.",
  },
  {
    id: "K06.c-stale-revision-refused",
    ...coordinated,
    sources: "REC-4",
    observation:
      "A closure request naming an earlier journal revision is refused with no record.",
    red: "Skip the revision check.",
  },
  {
    id: "K06.d-closure-record-fields",
    ...coordinated,
    sources: "REC-4; CMD-11",
    observation:
      "The closure record carries operation, closure identity, disposition, reason, evidence observations, the closed journal revision and the qualification label.",
    red: "Omit the closed journal revision.",
  },
  {
    id: "K06.e-kill-before-closure-publication",
    ...coordinated,
    sources: "REC-4; REC-9 row 9",
    observation:
      "Killed after the closure is staged and before it is linked: no valid closure, still listed, a later valid closure succeeds.",
    red: "Publish the closure before it is complete.",
  },
  {
    id: "K07.a-closed-stays-closed",
    ...coordinated,
    sources: "REC-4; REC-9 row 8; V-42",
    observation:
      "A later legitimate change diverging from closure-time evidence leaves the closure, no relisting, no renewed barrier, no replay.",
    red: "Reopen when the resource differs from closure-time evidence.",
  },
  {
    id: "K08.a-live-writer-blocks-closure",
    ...coordinated,
    sources: "REC-3; REC-4; REC-9 row 2",
    observation:
      "Closure of a live paused run is refused as held by a live owner, closure count 0; proven-independent work still proceeds.",
    red: "Allow closure while the owner lease is held.",
  },
  {
    id: "K08.b-recorded-delegate-blocks-closure",
    ...coordinated,
    sources: "REC-7; REC-9 row 13",
    observation:
      "A killed run whose journal shows an admitted delegate start: closure is unavailable even under fixture qualification.",
    red: "Treat a free owner lease as stop proof despite a delegate.",
  },
  {
    id: "K08.c-surviving-delegate-process",
    ...sliceB,
    sources: "REC-9 row 13; V-22",
    observation:
      "Parent killed with a surviving delegated program: closure and overlapping work blocked, independent scope proceeds.",
    red: "Treat parent death as a stopped operation.",
  },
  {
    id: "K09.a-no-proxy-completion",
    ...coordinated,
    sources: "REC-4; REC-2; CMD-13",
    observation:
      "A later overlapping run never appends to the earlier case's events and is refused by the unresolved-case station.",
    red: "Reconcile an earlier operation inside a later operation.",
  },

  {
    id: "P01.a-symlink-alias",
    ...coordinated,
    sources: "REC-2; REC-9 row 10; V-42",
    observation:
      "A symbolic link alias of the unresolved resource is refused by the unresolved-case station with the earlier case's binding.",
    red: "Compare raw path spelling.",
  },
  {
    id: "P01.b-hardlink-alias",
    ...coordinated,
    sources: "REC-2; V-42",
    observation: "A hard link alias is refused the same way.",
    red: "Drop the inode key.",
  },
  {
    id: "P01.c-case-alias",
    ...coordinated,
    sources: "REC-2; V-42",
    observation:
      "A case and normalisation alias on the admitted volume is refused the same way.",
    red: "Drop name folding.",
  },
  {
    id: "P01.d-different-command-same-resource",
    ...coordinated,
    sources: "REC-2",
    observation:
      "A different command naming the same resource is refused the same way.",
    red: "Scope by command name.",
  },
  {
    id: "P01.e-renamed-resource",
    ...coordinated,
    sources: "REC-2; REC-9 row 10",
    observation:
      "The resource renamed after the earlier intent and addressed by its new name is refused the same way.",
    red: "Use only the stored keys from intent time.",
  },
  {
    id: "P01.f-host-key-alias",
    ...coordinated,
    sources: "REC-2",
    observation:
      "A different opaque host identifier the host resolves to the same resource is refused the same way.",
    red: "Compare opaque identifiers.",
  },
  {
    id: "P01.g-distinct-resource-proceeds",
    ...coordinated,
    sources: "REC-2",
    observation:
      "A truly distinct resource twin is admitted and completes once.",
    red: "Refuse all work while a case is unresolved.",
  },
  {
    id: "P02.a-proven-disjoint-proceeds",
    ...coordinated,
    sources: "REC-2; DISC-15; REC-9 row 2; V-42",
    observation:
      "With an unresolved case on X and a live paused writer on Y, a disjoint operation completes once and the admission coordination lock is free afterwards.",
    red: "Hold the admission lock for the whole operation.",
  },
  {
    id: "P03.a-unknown-scope-conflicts",
    ...coordinated,
    sources: "REC-2; REC-9 row 11; V-42",
    observation:
      "An operation with unknown scope is refused while any case is unresolved, and an unresolved unknown-scope case blocks every later operation.",
    red: "Treat unknown scope as empty.",
  },
  {
    id: "P03.b-shared-invariant-conflicts",
    ...coordinated,
    sources: "REC-2; REC-9 row 11",
    observation:
      "Different resources sharing a declared invariant with the unresolved case are refused.",
    red: "Ignore invariants.",
  },
  {
    id: "P04.a-scope-before-coordination",
    ...coordinated,
    sources: "REC-2; CMD-9; CMD-9a",
    observation:
      "Invalid input is refused by its input cause while the test holds the admission coordination lock: no wait, no intent, no lock contention, state unchanged.",
    red: "Acquire coordination before input validation.",
  },
  {
    id: "P05.a-unresolved-case-station",
    ...coordinated,
    sources: "CMD-10; REC-2; WIRE-13; STEP-12",
    observation:
      "Overlap refusal: the distinct unresolved-case station, refused, unchanged, inventory complete, empty collections, not retryable, handoff to history bound to the blocking case, never the held-lock cause.",
    red: "Reuse the held-lock cause.",
  },
  {
    id: "P06.a-two-overlapping-contenders",
    ...coordinated,
    sources: "REC-2; CMD-12",
    observation:
      "Two overlapping contenders released together from a barrier: exactly one intent is admitted, the other is refused, and at most one effect happens.",
    red: "Check unresolved cases outside the admission lock.",
  },
  {
    id: "P06.b-contender-versus-closure",
    ...coordinated,
    sources: "REC-2; CMD-12",
    observation:
      "A contender racing the closure of its blocking case is either refused before the closure or admitted after it, never against a stale snapshot.",
    red: "Check then act without coordination.",
  },

  {
    id: "O01.a-held-lock-refusal",
    ...coordinated,
    sources: "CMD-10; CMD-12; V-22",
    observation:
      "A live owner holds the scope: the contender gets the held-lock station, refused, unchanged, not retryable, exit 3 not 75, handoff naming the owner case's history.",
    red: "Declare a retryable held-lock station.",
  },
  {
    id: "O01.b-admission-rejects-missing-stations",
    ...component,
    sources: "CMD-10; V-22",
    observation:
      "Composition rejects a changing command without the held-lock station, without the unresolved-case station, or with one cause for both.",
    red: "Accept a declaration without either station.",
  },
  {
    id: "O02.a-lock-ordering",
    ...coordinated,
    sources: "REC-2; CMD-12",
    observation:
      "Two operations declaring two resources in opposite orders, released together: both end in completion or a bounded refusal, no deadlock, and the intents record the same ascending acquisition order.",
    red: "Acquire in caller order.",
  },
  {
    id: "O03.a-bounded-admission-wait",
    ...coordinated,
    sources: "CMD-12; LIFE-4; V-22",
    observation:
      "The test holds the admission coordination lock: the contender ends within its bound with the temporary refusal, never a hang.",
    red: "Remove the wait bound.",
  },
  {
    id: "O03.b-signal-during-wait",
    ...coordinated,
    sources: "CMD-12; LIFE-3; V-22",
    observation:
      "SIGTERM while waiting for admission: real exit 143, no envelope, no intent.",
    red: "Ignore stop requests while waiting.",
  },
  {
    id: "O03.c-deadline-during-wait",
    ...coordinated,
    sources: "CMD-12; LIFE-6",
    observation:
      "A deadline expiring while waiting: the matching deadline row, no intent.",
    red: "Wait past the deadline.",
  },
  {
    id: "O04.a-age-is-not-proof",
    ...coordinated,
    sources: "REC-7; CMD-12; V-22",
    observation:
      "A live owner whose files are made old: closure refused as live, no closure write, handoff.",
    red: "Decide by file age.",
  },
  {
    id: "O04.b-stopped-process-still-owner",
    ...coordinated,
    sources: "REC-7; V-22",
    observation:
      "An owner process suspended with SIGSTOP after a kill was requested is still live: closure refused.",
    red: "Decide by a sent signal.",
  },
  {
    id: "O05.a-pid-not-consulted",
    ...coordinated,
    sources: "REC-7; REC-9 row 7; V-22",
    observation:
      "A crashed case whose owner record names a live unrelated PID: the decision is the same as without it (unavailable in production), and durable state is unchanged.",
    red: "Decide by PID presence.",
  },
  {
    id: "O06.a-delegated-writer",
    ...sliceB,
    sources: "REC-7; REC-7a; REC-9 row 13; V-22",
    observation:
      "Parent SIGKILLed with surviving direct and detached delegates: reclaim and closure blocked; independent scope proceeds.",
    red: "Treat parent death as a stopped operation.",
  },
  {
    id: "O07.a-two-closers",
    ...coordinated,
    sources: "REC-7; REC-9 row 7; V-22",
    observation:
      "Two closure commands for one crashed case released together under fixture qualification: exactly one closure record; the other is refused or returns the same disposition.",
    red: "Close without the key coordination locks.",
  },
  {
    id: "O07.b-reclaim-race",
    ...unqualified,
    sources: "REC-7; V-22",
    observation:
      "Qualified reclaim with two reclaimers and a contender: at most one owner.",
    red: "Non-atomic check then unlink.",
  },
  {
    id: "O08.a-takeover-crash-points",
    ...unqualified,
    sources: "REC-7; REC-9 row 12; V-22",
    observation:
      "Kill a reclaimer at each takeover phase: exactly one owner or safe refusal.",
    red: "Publish replacement before coordination.",
  },
  {
    id: "O09.a-reclaim-is-coordination-only",
    ...coordinated,
    sources: "REC-7; REC-3; V-22",
    observation:
      "After the owner is killed the kernel frees its coordination locks; a new overlapping operation acquires them yet is refused by the unresolved-case station; closure count 0, effect count unchanged.",
    red: "Treat free coordination locks as closure.",
  },
  {
    id: "O10.a-unqualified-closure-unavailable",
    ...coordinated,
    sources: "REC-7b; REC-8",
    observation:
      "Production specimen: closing a crashed case is unavailable with a handoff, no closure write, protection retained.",
    red: "Fall back to lease or PID heuristics without a row.",
  },
  {
    id: "O10.b-unqualified-takeover-unavailable",
    ...anyPlatform,
    sources: "REC-7a; REC-7b",
    observation:
      "Human-assisted takeover is unavailable with a handoff and changes nothing.",
    red: "Accept an attestation without a qualified row.",
  },

  {
    id: "H01.a-attestation-satisfies-stop-only",
    ...unqualified,
    sources: "REC-7a; REC-10; V-49",
    observation:
      "Qualified environment: preflight, coordination, re-read, consumption, then replacement; case stays unresolved.",
    red: "Replace before durable consumption.",
  },
  {
    id: "H02.a-attestation-cannot-bypass-exclusivity",
    ...anyPlatform,
    sources: "REC-7a; REC-7b; REC-10; V-49",
    observation:
      "A well-formed attestation file on an unqualified environment: refused unavailable, attestation bytes unchanged and unconsumed, ownership unchanged.",
    red: "Let an attestation skip the qualification gate.",
  },
  {
    id: "H03.a-attestation-race-and-crash",
    ...unqualified,
    sources: "REC-7a; REC-10; V-49",
    observation:
      "Replacement race and crash after consumption: at most one owner, no refund, no replay.",
    red: "Infer replacement from consumption.",
  },

  {
    id: "T01.a-host-transient-exit-75",
    ...coordinated,
    sources: "WIRE-15; WIRE-17; DISC-8; V-27",
    observation:
      "A host temporary condition confirmed before intent: real exit 75, TRANSIENT_NOT_STARTED, retry step, delay inside the bounds, state unchanged, not listed; the same invocation after the delay performs the effect once.",
    red: "Exit 3 with the same envelope.",
  },
  {
    id: "T01.b-admission-busy-exit-75",
    ...coordinated,
    sources: "WIRE-15; CMD-12; V-27",
    observation:
      "Admission coordination busy beyond its bound: exit 75 with a bounded delay, distinct from held-lock; the retry after release succeeds once.",
    red: "Map admission busy to the held-lock station.",
  },
  {
    id: "T02.a-attempt-unchanged-exit-75",
    ...coordinated,
    sources: "WIRE-15; WIRE-16; REC-4; V-27",
    observation:
      "A temporary failure after the intent and before any effect: exit 75, TRANSIENT_ATTEMPT_UNCHANGED, the run's own not-applied record ends its listing, and the retry performs the effect once.",
    red: "Leave the intent listed so the retry is refused.",
  },
  {
    id: "T03.a-delay-out-of-bounds",
    ...anyPlatform,
    sources: "DISC-8; LIFE-7; LIFE-9; V-27",
    observation:
      "A delay below the minimum or above the maximum: no exit 75 and no retry step; the fallback gives exit 1 and retryable false.",
    red: "Skip bound validation in the writer.",
  },
  {
    id: "T03.b-bad-bounds-rejected",
    ...component,
    sources: "DISC-8; V-27",
    observation:
      "Station declarations with non-positive bounds or a maximum below the minimum are rejected.",
    red: "Accept any bounds.",
  },
  {
    id: "T04.a-no-75-with-uncertainty",
    ...coordinated,
    sources: "WIRE-16; V-27",
    observation:
      "A temporary dependency failure after an uncertain mutation: unknown, exit 1, handoff, never 75.",
    red: "Map a post-effect temporary event to a transient cause.",
  },
  {
    id: "T04.b-held-lock-never-75",
    ...coordinated,
    sources: "CMD-12; V-22; V-27",
    observation: "Held-lock contention exits 3, never 75.",
    red: "Make held-lock transient.",
  },

  {
    id: "Q01.a-production-defaults-unavailable",
    ...anyPlatform,
    sources: "REC-5; REC-7b; REC-8",
    observation:
      "The production qualification table is empty and every gated capability reports unavailable with its reason.",
    red: "Enable a capability with no row.",
  },
  {
    id: "Q01.b-fixture-never-enables",
    ...component,
    sources: "REC-7b; Q01",
    observation:
      "Using the fixture qualification in one installation leaves the production table and another installation's capabilities unchanged, and stamps closures fixture.",
    red: "Let the fixture write the production table.",
  },
  {
    id: "Q01.c-transitions-mapped",
    ...component,
    sources: "REC-8",
    observation:
      "Every transition row in the frozen design maps to at least one case identity in this table.",
    red: "Add an unmapped transition.",
  },

  {
    id: "Q01.d-host-cannot-import-test-seams",
    ...component,
    sources: "REC-7b; Q01; CMD-17",
    observation:
      "A host-like module importing the state add-on's fixture or internals, statically or dynamically, fails lint; importing its index does not.",
    red: "Drop the state deep-import ban.",
  },

  {
    id: "J04.g-mid-file-length-damage-refuses",
    ...coordinated,
    sources: "CMD-11; DISC-14 item 5; DESIGN.md section 4",
    observation:
      "A record length running past the end of the file while valid records follow is corrupt, and the report refuses.",
    red: "Read a short record as a torn tail without looking for a later record.",
  },
  {
    id: "J04.h-final-lf-missing-not-state",
    ...coordinated,
    sources: "CMD-11; DESIGN.md section 4",
    observation:
      "A final completion record missing only its trailing LF is not state: the case is listed again.",
    red: "Accept a final record without its LF.",
  },
  {
    id: "K06.f-same-identity-different-content",
    ...coordinated,
    sources: "REC-4",
    observation:
      "The same closure identity with another disposition or reason is refused as conflicting; closure bytes unchanged.",
    red: "Treat any closure with the same identity as already closed.",
  },
  {
    id: "K06.g-unknown-operation-not-found",
    ...coordinated,
    sources: "REC-3; REC-6",
    observation:
      "Closing a well-formed operation identity that names no case is refused as not found.",
    red: "Report a missing case as a corrupt store.",
  },
  {
    id: "K06.h-unreadable-case-unavailable",
    ...coordinated,
    nonRoot: true,
    sources: "REC-3; DISC-14 item 5",
    observation:
      "Closing an existing but unreadable case is refused as unavailable with its reason, never as not found; no closure.",
    red: "Fold a read failure into not found.",
  },
  {
    id: "P03.c-incomplete-scope-conflicts",
    ...coordinated,
    sources: "REC-2; REC-9 row 11",
    observation:
      "A declaration where one of two resources cannot be resolved conflicts with an unresolved case on a different resource.",
    red: "Drop an unresolvable resource instead of making the scope unknown.",
  },
  {
    id: "P06.c-admission-held-until-intent-published",
    ...coordinated,
    sources: "REC-2; CMD-12",
    observation:
      "While an unknown-scope writer is staged under the admission lock, an overlapping contender gets the temporary refusal and is never admitted.",
    red: "Release the admission lock before the intent is published.",
  },
  {
    id: "P06.d-unresolved-scan-under-admission",
    ...coordinated,
    sources: "REC-2; CMD-12",
    observation:
      "An unresolved case that appears while a contender waits for the admission lock is seen by that contender's scan after it acquires the lock.",
    red: "Read the unresolved scan before acquiring coordination.",
  },
  {
    id: "S05.a-approval-lost-versus-unavailable",
    ...transactionComponent,
    sources: "CMD-15",
    observation:
      "A rejection with consumed true is approval-lost and one with consumed false is approval-unavailable; neither publishes an intent.",
    red: "Merge approval-lost into approval-unavailable.",
  },
  {
    id: "B06.a-effect-recorded-once",
    ...transactionComponent,
    sources: "CMD-11; DESIGN.md section 8 step 1",
    observation:
      "A second record of the same effect in one run is rejected and writes no second effect-started.",
    red: "Allow an effect to be recorded twice.",
  },

  {
    id: "S01.a-consumed-under-coordination-before-intent",
    ...coordinated,
    sources: "CMD-9 step 7; CMD-15; A19",
    observation:
      "A valid approved apply consumes under the issued scope after admission and before the intent; the intent records the preview reference and no grant bytes; effect count 1.",
    red: "Consume before acquiring coordination.",
  },
  {
    id: "S02.a-denial-under-coordination",
    ...coordinated,
    sources: "CMD-15",
    observation:
      "A grant invalid at revalidation: denied, unchanged, no intent, no effect.",
    red: "Write intent before revalidation.",
  },
  {
    id: "S03.a-store-failure-preserves-item",
    ...coordinated,
    nonRoot: true,
    sources: "CMD-15",
    observation:
      "The approval ledger is unavailable: the operational outcome, distinct from denial; the item is preserved and no intent is written.",
    red: "Report store failure as denial.",
  },
  {
    id: "S04.a-held-lock-preserves-grant",
    ...coordinated,
    sources: "CMD-12; CMD-15; T4 A07",
    observation:
      "Held-lock refusal of an approved apply leaves the grant unconsumed and usable after release.",
    red: "Consume before coordination.",
  },

  {
    id: "B01.a-admit-start-active-effect",
    ...transactionComponent,
    sources: "CMD-14; V-21",
    observation:
      "admitStart for the current run and active effect appends delegate-admitted before calling start.",
    red: "Start before the durable record.",
  },
  {
    id: "B02.a-admit-start-after-close-rejected",
    ...transactionComponent,
    sources: "CMD-14; GATE-7 K3",
    observation:
      "A retained capability used after its effect closed is rejected before start is called.",
    red: "Skip the lifetime check.",
  },
  {
    id: "B03.a-admit-start-wrong-run-or-effect",
    ...transactionComponent,
    sources: "CMD-14",
    observation:
      "Wrong run identity or wrong effect is rejected before start is called.",
    red: "Check only the effect name.",
  },
  {
    id: "B04.a-emergency-record",
    ...transactionComponent,
    sources: "LIFE-6a",
    observation:
      "emergencyRecord appends one emergency event to the active operation, at most once, and never throws.",
    red: "Write more than once or throw.",
  },
  {
    id: "B05.a-closing-waits-for-admitted-start",
    ...transactionComponent,
    sources: "CMD-14; T2 P04",
    observation:
      "An admitted start in flight delays the effect's read-back until it settles; a start requested after closing began is rejected.",
    red: "Close without waiting for admitted starts.",
  },
  {
    id: "C01.a-coordination-exclusive-across-processes",
    ...coordinated,
    sources: "CMD-12; REC-7; DESIGN 7; Linux expectations C1, C5",
    observation:
      "While a separate process holds file F through the add-on's coordination route, another process is refused F (busy), still acquires an unrelated file G, and acquires F only after the holder is gone.",
    red: "Take a lock that does not exclude another process (for example numeric O_EXLOCK on Linux).",
  },
  {
    id: "C01.b-coordination-nonblocking",
    ...coordinated,
    sources: "CMD-12; DESIGN 7 and 7.1; Linux expectations C2",
    observation:
      "A contender's attempt on a held file returns refused in under 100 ms while the holder still lives and holds.",
    red: "Take the coordination lock with a blocking call.",
  },
  {
    id: "C01.c-sigkill-release-first-attempt-no-residue",
    ...coordinated,
    sources: "DESIGN 3 and 7; CMD-12; REC-7; Linux expectations C3",
    observation:
      "After the holder is killed with SIGKILL and its exit observed, the first attempt acquires, and the folder lists the same names, sizes and bytes as before the holder started.",
    red: "Coordinate with a lock file or a record that must be cleaned after a crash.",
  },
  {
    id: "C01.d-other-descriptor-close-keeps-hold",
    ...coordinated,
    sources: "CMD-12; REC-2; DESIGN 7.2; Linux expectations C4a, 4.5",
    observation:
      "The holder opens and closes a second descriptor on the held file and a contender is still refused; the same body with the lockf(F_TLOCK) control observes the contender acquiring (control detected).",
    red: "Use a process-owned POSIX record lock (fcntl F_SETLK or lockf).",
  },
  {
    id: "C01.e-spawned-child-does-not-hold",
    ...coordinated,
    sources: "DESIGN 7.2; REC-7; Linux expectations C4b, 4.5",
    observation:
      "The holder spawns a long-lived child, through Bun.spawn and through the C library's system(), and is killed with SIGKILL; a contender acquires while the child lives. The same body with a holder that hands its locked descriptor to the child observes the contender refused (control detected).",
    red: "Open the coordination file without close-on-exec, so a child shares the open file description (the system() child shows it only on a Bun that does not set close-on-exec itself: seen on 1.4.0 and 1.4.2, not on 1.4.4).",
  },
  {
    id: "C01.f-same-process-second-open-refused",
    ...coordinated,
    sources: "CMD-12; DESIGN 7.1; Linux expectations C4c, 4.5",
    observation:
      "A second, independent open in the holding process is refused; the same body with the lockf(F_TLOCK) control observes it acquiring (control detected).",
    red: "Use a process-owned POSIX record lock (fcntl F_SETLK or lockf).",
  },
  {
    id: "C01.g-stopped-holder-still-holds",
    ...coordinated,
    sources: "REC-7; Linux expectations C4d; case O04.b",
    observation:
      "A holder stopped with SIGSTOP still holds; a contender is refused.",
    red: "Release or reclaim on a sent signal.",
  },
  {
    id: "C01.h-no-fallback-when-route-unavailable",
    ...coordinated,
    sources:
      "REC-7; REC-8; CMD-12; T3 Exclusions; Linux expectations section 2",
    observation:
      "With the fixture seam that makes the route's start-up self-check fail, a change and a recovery command each refuse with DOMAIN_SX_UNAVAILABLE, exit 3, not retryable, empty stderr and collections, a message naming coordination-self-check-failed with the platform, kernel release and qualified scope, never advising removal; the state root is never created and the ledger is empty. Capabilities report coordination unavailable with that reason; the read route stays read-only.",
    red: "Fall back to a lock file, or continue without a coordination lock, when the route is unavailable.",
  },
  {
    id: "C01.i-no-age-pid-or-fallback-path",
    ...anyPlatform,
    sources: "CMD-12; REC-7; REC-7b; T3 Exclusions; Linux expectations C6",
    observation:
      "The coordination route modules read no time stamp, PID, process table or host name and open no create-exclusive lock file.",
    red: "Decide acquisition or ownership by lock age or PID absence.",
  },
  {
    id: "C01.j-failure-after-admission-releases-everything",
    ...transactionComponent,
    sources:
      "REC-8; CMD-12; DESIGN 7.1 step 3; Linux expectations section 2 item 7",
    observation:
      "In one live process, a key coordination call that fails after the admission and earlier key coordination locks were taken refuses coordination-failed, publishes nothing, and leaves the admission and every earlier key coordination lock free to a separate open in the same process.",
    red: "Return the refusal without releasing what was taken (invisible to a process that exits).",
  },
  {
    id: "C01.k-self-check-decision",
    ...component,
    sources:
      "Linux route decision (Nathan, 16 November 2026, 14:22); REC-8; Linux review follow-up F1",
    observation:
      "The start-up self-check calls flock(-1, LOCK_EX | LOCK_NB) once and accepts only -1 with EBADF; 0, -1 with any other code and an unreadable code each refuse with a step naming what was returned. An accepted route maps 0 to held, EAGAIN to busy and anything else, including an unreadable code, to failed.",
    red: "Accept the binding whatever flock(-1) returns.",
  },
  {
    id: "Q01.e-host-cannot-reach-seams-by-other-spellings",
    ...anyPlatform,
    sources: "REC-7b; Q01; T3 delta review F1",
    observation:
      "Host-like source fails lint for each of the six reviewed spellings that loaded the fixture (computed and template import(), createRequire, a doubled slash, a ./ segment, ../state/fixture.ts or ../state/install.ts from another add-on folder) and for import.meta.require, and the same holds for the kernel's internals; importing the public index still passes.",
    red: "Match only the canonical spelling of the banned path.",
  },
  {
    id: "Q01.f-foreign-call-confined-to-linux-route",
    ...anyPlatform,
    sources:
      "Linux route decision (Nathan, 16 November 2026, 14:22); CMD-16; CMD-17",
    observation:
      "bun:ffi imported statically or dynamically from any contract source file other than the state add-on's linux-flock.ts fails lint; the same import in linux-flock.ts passes, and the committed linux-flock.ts lints clean.",
    red: "Allow bun:ffi everywhere, or ban it in the route module too.",
  },
];
