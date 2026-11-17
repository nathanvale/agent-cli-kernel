export type ApprovalCase = {
  readonly id: string;
  readonly sources: string;
  readonly observation: string;
} & (
  | {
      readonly status: "executable";
      readonly layer: "component" | "child-process";
      readonly expected: {
        readonly outcome:
          | "admitted"
          | "denied"
          | "input-refused"
          | "lock-refused"
          | "killed"
          | "unavailable"
          | "verified"
          | "refused"
          | "operational-failure"
          | "coordination-error";
        readonly consumeDelta: 0 | 1;
        readonly effectDelta: 0 | 1;
        readonly grantUnchanged: boolean;
      };
      readonly red: string;
    }
  | {
      readonly status: "pending";
      readonly owner: "T2" | "T3" | "T6" | "T8";
      readonly reason: string;
    }
);

const deny = {
  outcome: "denied",
  consumeDelta: 0,
  effectDelta: 0,
  grantUnchanged: true,
} as const;
const refuse = { ...deny, outcome: "refused" } as const;
const inputRefused = { ...deny, outcome: "input-refused" } as const;
const applied = {
  outcome: "admitted",
  consumeDelta: 1,
  effectDelta: 1,
  grantUnchanged: true,
} as const;
const preflightOnly = { ...deny, outcome: "admitted" } as const;

export const approvalCases: readonly ApprovalCase[] = [
  {
    id: "A01.a-preflight-non-consuming",
    sources: "CMD-9 step 5, CMD-15",
    observation:
      "Preflight against a valid unconsumed grant admits without writing the grant, ledger or resource.",
    status: "executable",
    layer: "component",
    expected: preflightOnly,
    red: "Preflight writes the consumption marker.",
  },
  {
    id: "A01.b-apply-consumes-once",
    sources: "CMD-9 step 7, CMD-15, V-47",
    observation:
      "Apply under exclusive coordination consumes the grant once and the effect ledger gains exactly one entry.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Consumption is skipped or not durable before the effect.",
  },
  {
    id: "A01.c-preview-records-intent",
    sources: "CMD-10b, CMD-4",
    observation:
      "Preview persists P, E and R0 without a domain effect or grant consumption.",
    status: "pending",
    owner: "T3",
    reason: "Preview persistence is a state add-on transaction.",
  },
  {
    id: "A01.d-completion-after-readback",
    sources: "CMD-10a, CMD-11",
    observation:
      "Apply reports completed only from journal plus independent read-back.",
    status: "pending",
    owner: "T3",
    reason: "Transaction read-back and completion proof belong to T3.",
  },
  {
    id: "A01.e-cli-preview-apply",
    sources: "V-47",
    observation:
      "The admitted CLI previews and applies through the real front door.",
    status: "pending",
    owner: "T2",
    reason: "Front door, writer and process exits belong to T2.",
  },
  {
    id: "A02.a-malformed-syntax",
    sources: "CMD-9 step 3 before 5, V-20",
    observation:
      "Unknown option refuses as input with zero authority contacts and no ledger write.",
    status: "executable",
    layer: "component",
    expected: inputRefused,
    red: "Authority preflight runs before input parsing.",
  },
  {
    id: "A02.b-invalid-decoded-input",
    sources: "CMD-9 step 3, CMD-9a",
    observation:
      "Schema-invalid decoded value refuses as input with zero authority contacts.",
    status: "executable",
    layer: "component",
    expected: inputRefused,
    red: "Authority preflight runs before schema validation.",
  },
  {
    id: "A02.c-invalid-future-binding",
    sources: "CMD-9 step 3, INPUT-4",
    observation:
      "Invalid caller-supplied future binding refuses as input with zero authority contacts.",
    status: "executable",
    layer: "component",
    expected: inputRefused,
    red: "Authority preflight runs before future-binding validation.",
  },
  {
    id: "A02.d-cli-input-before-authority",
    sources: "V-20",
    observation:
      "Real CLI process shows the admitted input cause and exit, never DOMAIN_AUTHORITY_REQUIRED.",
    status: "pending",
    owner: "T2",
    reason: "Public input refusal envelope and exit belong to T2.",
  },
  {
    id: "A03.a-missing",
    sources: "CMD-15, V-47",
    observation: "No grant for the preview: preflight denies.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "Missing grant reported differently from other denials.",
  },
  {
    id: "A03.b-stale-expired",
    sources: "CMD-15, V-47",
    observation: "Expired grant: preflight denies, grant bytes preserved.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "Expiry check removed or expired grant rewritten.",
  },
  {
    id: "A03.c-stale-revision",
    sources: "CMD-15, CMD-10b, V-47",
    observation: "Grant bound to an older revision: preflight denies.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "Revision binding removed.",
  },
  {
    id: "A03.d-consumed",
    sources: "CMD-15, V-47",
    observation:
      "Consumed grant: preflight denies, marker preserved and not rewritten.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "Consumed marker ignored or rewritten on denial.",
  },
  {
    id: "A03.e-mismatched",
    sources: "CMD-15, V-47",
    observation: "Grant for another operation: preflight denies.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "Operation binding removed.",
  },
  {
    id: "A03.f-identical-kernel-refusal",
    sources: "CMD-15, V-47",
    observation:
      "Through the kernel, all five denial variants give one deep-equal refusal and identical thrown-nothing behaviour.",
    status: "executable",
    layer: "component",
    expected: deny,
    red: "One variant discloses its reason.",
  },
  {
    id: "A03.g-identical-consume-refusal",
    sources: "CMD-15, V-20",
    observation:
      "Under exclusive coordination, missing, stale, consumed and mismatched grants each give the same not-admitted result with no new marker and no effect.",
    status: "executable",
    layer: "child-process",
    expected: deny,
    red: "Under-lock revalidation consumes or reports a reason.",
  },
  {
    id: "A03.h-cli-identical-envelope",
    sources: "V-47",
    observation:
      "Complete validated public envelopes are identical except run identity.",
    status: "pending",
    owner: "T6",
    reason: "Public envelope comparison needs the T2 writer and T6 checker.",
  },
  ...[
    ["a-malformed-json", "Grant bytes are not JSON."],
    ["b-truncated", "Grant JSON is truncated."],
    ["c-forged-field", "Grant carries an extra grantedBy field."],
    ["d-wrong-type", "A bound field has the wrong type."],
    ["e-oversized", "Grant exceeds the read bound."],
    ["f-symlink", "Grant location is a symlink to a valid grant."],
    ["g-non-regular", "Grant location is a directory or FIFO; no hang."],
    ["h-invalid-utf8", "Grant bytes are invalid UTF-8."],
    ["i-excess-depth", "Grant nests deeper than the guard."],
    ["j-hard-link", "Grant file has more than one link."],
    ["k-prototype-key", "Grant carries an own __proto__ key."],
    ["l-traversal-preview", "Preview identity contains path traversal."],
  ].map(
    ([variant, observation]): ApprovalCase => ({
      id: `A04.${variant}`,
      sources: "CMD-9a, CMD-15, REC-5",
      observation: `${observation} Preflight denies; nothing is written.`,
      status: "executable",
      layer: "component",
      expected: deny,
      red: "Hardened read accepts shape alone or follows the substitution.",
    }),
  ),
  {
    id: "A04.m-unreadable",
    sources: "CMD-15, coordinator A04 caution",
    observation:
      "Unreadable grant store is an operational failure, not a denial and never a success.",
    status: "executable",
    layer: "component",
    expected: { ...deny, outcome: "operational-failure" },
    red: "Read failure folded into admission or silent success.",
  },
  ...[
    ["a-preview", "preview identity"],
    ["b-revision", "resource revision"],
    ["c-authority", "authority context"],
    ["d-effect-subset", "effect set (subset)"],
    ["e-effect-superset", "effect set (superset)"],
    ["f-operation", "operation identity"],
    ["g-resource", "resource identity"],
    ["h-effect-duplicate", "effect set (duplicate entry)"],
  ].map(
    ([variant, binding]): ApprovalCase => ({
      id: `A05.${variant}`,
      sources: "CMD-10b, CMD-15, V-47",
      observation: `Request differs from the grant only in ${binding}: preflight denies; the identical twin admits.`,
      status: "executable",
      layer: "component",
      expected: deny,
      red: `Remove the ${binding} binding check.`,
    }),
  ),
  ...[
    ["a-expire", "The grant expires"],
    ["b-revision", "The current resource revision changes"],
    ["c-effects", "The grant is replaced with a different effect set"],
    ["d-authority", "The grant is replaced with another authority context"],
    ["e-operation", "The grant is replaced for another operation"],
  ].map(
    ([variant, change]): ApprovalCase => ({
      id: `A06.${variant}`,
      sources: "CMD-15, V-20",
      observation: `${change} while the contender waits for held coordination. Under-lock revalidation refuses.`,
      status: "executable",
      layer: "child-process",
      expected: deny,
      red: "Revalidation reuses the preflight snapshot.",
    }),
  ),
  {
    id: "A07.a-refusal-preserves",
    sources: "CMD-12, CMD-15, V-20",
    observation:
      "Held scope refuses acquisition; the still-valid grant stays unconsumed and the resource unchanged.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "lock-refused" },
    red: "Consume during preflight or on lock refusal.",
  },
  {
    id: "A07.b-later-success-once",
    sources: "CMD-15, V-20",
    observation:
      "After legitimate release the same grant applies exactly once.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Lock refusal consumed the grant.",
  },
  {
    id: "A07.c-held-lock-station",
    sources: "CMD-10, CMD-12",
    observation:
      "Held-lock cause and guidance are host-owned, distinct from authority and unresolved-case refusals.",
    status: "pending",
    owner: "T2",
    reason: "Public held-lock station emission needs the T2 front door.",
  },
  {
    id: "A08.a-locked-contenders",
    sources: "CMD-15, V-20",
    observation:
      "Two real contenders share G/P/E behind one scope: one consumption, one effect, the loser refuses.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Replace exclusive-create consumption with check-then-write.",
  },
  {
    id: "A08.b-consumption-atomic-without-lock",
    sources: "CMD-15",
    observation:
      "Two contenders each holding a non-shared fixture scope race consumption: exactly one is admitted.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Replace exclusive-create consumption with overwrite.",
  },
  {
    id: "A09.a-phase-observations",
    sources: "CMD-9, CMD-15, V-20",
    observation:
      "Before acquisition: unconsumed, no effect. Holding: a probe cannot acquire. Before effect: marker durable, no effect. After effect: one effect.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Consumption returns before the marker is durable.",
  },
  {
    id: "A09.b-inactive-coordination",
    sources: "CMD-15",
    observation:
      "Consumption with released coordination is a coordination error; no consumption.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "coordination-error" },
    red: "Remove the active-coordination check.",
  },
  {
    id: "A09.c-foreign-scope",
    sources: "CMD-15, REC-2",
    observation:
      "Coordination for another resource or run is a coordination error; no consumption.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "coordination-error" },
    red: "Remove the scope binding check.",
  },
  {
    id: "A09.d-integrated-intent-order",
    sources: "CMD-11, CMD-15",
    observation:
      "Journal intent precedes the effect and consumption precedes it inside the real transaction.",
    status: "pending",
    owner: "T3",
    reason: "Intent and transaction ordering belong to the state add-on.",
  },
  {
    id: "A10.a-kill-after-preflight",
    sources: "CMD-15, V-20, REC-7",
    observation:
      "SIGKILL after preflight: unconsumed, no effect; inspection does not replay.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "killed" },
    red: "Preflight persists consumption.",
  },
  {
    id: "A10.b-kill-after-acquire",
    sources: "CMD-15, V-20, REC-7",
    observation:
      "SIGKILL holding coordination before consumption: unconsumed; after fixture-qualified release the grant applies once.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "killed" },
    red: "Consumption persisted on acquisition.",
  },
  {
    id: "A10.c-qualified-reclaim",
    sources: "REC-7, REC-7b",
    observation: "Real stopped-owner proof and qualified reclaim.",
    status: "pending",
    owner: "T3",
    reason: "Lock protocol, stopped-owner proof and reclaim belong to T3.",
  },
  {
    id: "A11.a-kill-after-consume",
    sources: "CMD-15, V-20",
    observation:
      "SIGKILL after durable consumption, before the effect: consumed, no effect, repeat denied, no refund.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "killed", consumeDelta: 1 },
    red: "Refund on restart or consumed grant starts the effect.",
  },
  {
    id: "A11.b-uncertain-facts",
    sources: "CMD-11, REC-1",
    observation: "Recovery preserves uncertain facts; no false outcome.",
    status: "pending",
    owner: "T3",
    reason: "Journal crash transitions belong to T3.",
  },
  {
    id: "A12.a-kill-after-effect",
    sources: "CMD-11, CMD-15, V-20",
    observation:
      "SIGKILL after the effect, before response: consumed, effect count stays one, repeat denied.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "killed", consumeDelta: 1, effectDelta: 1 },
    red: "Restart repeats the effect.",
  },
  {
    id: "A12.b-closure-truth",
    sources: "REC-1, REC-4",
    observation: "Missing response does not imply unchanged; final closure.",
    status: "pending",
    owner: "T3",
    reason: "Final closure truth belongs to T3/T8.",
  },
  {
    id: "A13.a-torn-marker",
    sources: "CMD-15, REC-9",
    observation:
      "An empty, partial, directory or symlink marker counts as consumed: preflight and revalidation deny, no effect.",
    status: "executable",
    layer: "child-process",
    expected: deny,
    red: "Treat an unparseable marker as fresh.",
  },
  {
    id: "A13.b-kill-inside-primitive",
    sources: "CMD-15, REC-9",
    observation:
      "Kill between exclusive create and flush at the frozen storage boundary.",
    status: "pending",
    owner: "T3",
    reason:
      "No production pause point exists inside the primitive; crash-transition injection belongs to T3's frozen storage table.",
  },
  {
    id: "A14.a-reuse-denied",
    sources: "CMD-10b, CMD-15, V-47",
    observation:
      "Reusing a consumed preview with identical input denies; effect count unchanged.",
    status: "executable",
    layer: "child-process",
    expected: deny,
    red: "Permit reuse because other bindings match.",
  },
  {
    id: "A14.b-reissued-grant-denied",
    sources: "CMD-10b, CMD-15",
    observation:
      "A fresh grant written for an already consumed preview still denies.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, grantUnchanged: false },
    red: "Consumption keyed by grant bytes instead of preview.",
  },
  {
    id: "A15.a-inspection-under-held-lock",
    sources: "CMD-15",
    observation:
      "While another process holds coordination, inspection admits without acquiring or consuming.",
    status: "executable",
    layer: "child-process",
    expected: preflightOnly,
    red: "Route inspection through consuming admission.",
  },
  {
    id: "C01.a-exact-closure",
    sources: "REC-3, REC-5",
    observation:
      "Separated fixture authority: preflight verifies without consuming; under coordination consumes once.",
    status: "executable",
    layer: "child-process",
    expected: { ...applied, outcome: "verified", effectDelta: 0 },
    red: "Consume before coordination or skip revalidation.",
  },
  {
    id: "C01.b-closure-record",
    sources: "REC-4, REC-5",
    observation:
      "One closure record after consumption, effects unchanged, disclosure to the person.",
    status: "pending",
    owner: "T3",
    reason: "Closure records and disclosure belong to T3 and the host.",
  },
  ...[
    ["a-operation", "operation"],
    ["b-disposition", "disposition"],
    ["c-evidence", "evidence snapshot"],
    ["d-scope", "scope"],
  ].map(
    ([variant, binding]): ApprovalCase => ({
      id: `C02.${variant}`,
      sources: "REC-5, CMD-15",
      observation: `Current item differs in ${binding}: refuse without consumption.`,
      status: "executable",
      layer: "component",
      expected: refuse,
      red: `Remove the ${binding} binding check.`,
    }),
  ),
  {
    id: "C02.e-change-while-waiting",
    sources: "REC-5, CMD-15",
    observation:
      "Evidence changes while waiting for coordination: under-lock revalidation refuses.",
    status: "executable",
    layer: "child-process",
    expected: refuse,
    red: "Reuse preflight snapshot.",
  },
  {
    id: "C03.a-same-user-file",
    sources: "REC-5, V-42",
    observation:
      "Caller-writable grantedBy human file under caller credentials: unavailable with handoff.",
    status: "executable",
    layer: "component",
    expected: { ...deny, outcome: "unavailable" },
    red: "Treat a caller-writable source as qualified.",
  },
  {
    id: "C03.b-caller-created-record",
    sources: "REC-5, V-42",
    observation:
      "Caller creates a record in a read-only directory it owns: still unavailable.",
    status: "executable",
    layer: "component",
    expected: { ...deny, outcome: "unavailable", grantUnchanged: false },
    red: "Trust permission bits the caller can change.",
  },
  {
    id: "C03.c-production-qualification",
    sources: "REC-5, V-42",
    observation: "Forgery attempts against a real integration fail.",
    status: "pending",
    owner: "T8",
    reason: "No credential provider is selected; host qualification only.",
  },
  {
    id: "C04.a-no-source",
    sources: "REC-5, T4 exclusion",
    observation:
      "No qualified source: closure and stop are unavailable with a human handoff.",
    status: "executable",
    layer: "component",
    expected: { ...deny, outcome: "unavailable" },
    red: "Enable capability after a fixture verifier passes.",
  },
  {
    id: "S01.a-exact-attestation",
    sources: "REC-7a, REC-10",
    observation:
      "Preflight non-consuming; under coordination revalidates and consumes once.",
    status: "executable",
    layer: "child-process",
    expected: { ...applied, outcome: "verified", effectDelta: 0 },
    red: "Consume before coordination.",
  },
  {
    id: "S01.b-owner-replacement",
    sources: "REC-7, REC-7a",
    observation: "Replace the owner once through qualified mechanics.",
    status: "pending",
    owner: "T3",
    reason: "Owner replacement belongs to T3's takeover protocol.",
  },
  ...[
    ["a-forged", "a forged record"],
    ["b-stale", "an expired attestation"],
    ["c-consumed", "an already consumed attestation"],
    ["d-wrong-owner", "a wrong owner incarnation"],
    ["e-wrong-operation", "a wrong operation"],
    ["f-wrong-writers", "a wrong delegated writer set"],
    ["g-wrong-scope", "a wrong scope"],
    ["h-live-conflict", "a known live writer"],
  ].map(
    ([variant, problem]): ApprovalCase => ({
      id: `S02.${variant}`,
      sources: "REC-7a, REC-10, V-49",
      observation: `Attestation with ${problem}: refuse, no new consumption.`,
      status: "executable",
      layer: "component",
      expected: refuse,
      red: "Remove the corresponding binding or trust check.",
    }),
  ),
  {
    id: "S03.a-inactive-coordination",
    sources: "REC-7, REC-7a",
    observation:
      "Valid attestation with released coordination: coordination error, attestation preserved.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "coordination-error" },
    red: "Human confirmation bypasses exclusivity.",
  },
  {
    id: "S03.b-qualified-exclusivity",
    sources: "REC-7b",
    observation: "Unqualified environment refuses takeover.",
    status: "pending",
    owner: "T3",
    reason: "Environment qualification table belongs to T3.",
  },
  {
    id: "S04.a-replaced-owner",
    sources: "REC-7a, V-49",
    observation:
      "Owner replaced between preflight and coordinated reread: the old attestation refuses.",
    status: "executable",
    layer: "child-process",
    expected: refuse,
    red: "Revalidate the preflight snapshot.",
  },
  {
    id: "S04.b-two-claimants",
    sources: "REC-10, V-49",
    observation: "Two claimants and a new contender: at most one owner.",
    status: "pending",
    owner: "T3",
    reason: "Ownership protocol belongs to T3.",
  },
  {
    id: "S05.a-kill-after-attestation-consume",
    sources: "REC-7a",
    observation:
      "SIGKILL after attestation consumption: consumed, no refund; closure and approval markers untouched.",
    status: "executable",
    layer: "child-process",
    expected: { ...deny, outcome: "killed", consumeDelta: 1 },
    red: "Refund attestation or consume closure/domain authority.",
  },
  {
    id: "S05.b-replacement-crash",
    sources: "REC-7a",
    observation: "Kill after replacement before acknowledgement.",
    status: "pending",
    owner: "T3",
    reason: "Replacement mechanics belong to T3.",
  },
  {
    id: "S06.a-stop-not-closure",
    sources: "REC-5, REC-7a",
    observation: "A stop attestation presented as closure authority refuses.",
    status: "executable",
    layer: "component",
    expected: refuse,
    red: "Reuse one authority item across effects.",
  },
  {
    id: "S06.b-closure-not-stop",
    sources: "REC-5, REC-7a",
    observation: "A closure grant presented as stop attestation refuses.",
    status: "executable",
    layer: "component",
    expected: refuse,
    red: "Reuse one authority item across effects.",
  },
  {
    id: "S06.c-approval-separate",
    sources: "REC-7, CMD-15",
    observation:
      "Consuming a stop attestation leaves the domain approval grant usable once.",
    status: "executable",
    layer: "child-process",
    expected: applied,
    red: "Share one consumption namespace.",
  },
];
