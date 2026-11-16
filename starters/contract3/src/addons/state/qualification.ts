// Environment qualification gate (REC-7b, REC-8, DESIGN.md section 10).
// A row may enable the runtime stopped-owner proof only after independent
// review of V-22 and V-42 for exactly that environment. The foundation table
// is empty, so every gated capability is unavailable with a handoff.
import { release } from "node:os";

export type QualificationRow = {
  readonly id: string;
  readonly os: string;
  readonly osRelease: string;
  readonly filesystem: string;
  readonly primitive: string;
  readonly processIdentity: string;
  readonly namespace: string;
  readonly delegatedWriters: string;
  readonly failureCases: readonly string[];
  readonly evidence: readonly string[];
};

// Reviewed rows only. Empty for the foundation (expected outcome O10, Q01).
export const qualificationRows: readonly QualificationRow[] = Object.freeze([]);

// What a closure needs before its stopped-owner condition may be evaluated.
// `label` is stamped into every closure the qualification enables.
export type Qualification = {
  readonly label: string;
  readonly stoppedOwner: "lease-and-no-delegate" | "unavailable";
};

const fixtures = new WeakSet<object>();
export function registerFixture(value: Qualification): Qualification {
  const frozen = Object.freeze({ ...value });
  fixtures.add(frozen);
  return frozen;
}

// Production: the row matching this environment, if any. A host cannot pass
// its own object as a qualification: only the labelled fixture module's
// registered values are accepted, and those are stamped `fixture:`.
export function resolveQualification(supplied: unknown): Qualification {
  if (
    typeof supplied === "object" &&
    supplied !== null &&
    fixtures.has(supplied)
  ) {
    const label: unknown = Reflect.get(supplied, "label");
    const stoppedOwner: unknown = Reflect.get(supplied, "stoppedOwner");
    return {
      label: `fixture:${typeof label === "string" ? label : "unnamed"}`,
      stoppedOwner:
        stoppedOwner === "lease-and-no-delegate"
          ? "lease-and-no-delegate"
          : "unavailable",
    };
  }
  const row = qualificationRows.find(
    (entry) => entry.os === process.platform && entry.osRelease === release(),
  );
  return row
    ? { label: row.id, stoppedOwner: "lease-and-no-delegate" }
    : { label: "unqualified", stoppedOwner: "unavailable" };
}

export type CapabilityReport = {
  readonly qualification: string;
  readonly coordination: "available" | "unavailable";
  readonly stoppedOwnerProof: "available" | "unavailable";
  readonly automaticReclaim: "unavailable";
  readonly humanAssistedTakeover: "unavailable";
  readonly humanOutcomeUnknownClosure: "available" | "unavailable";
  readonly reasons: readonly string[];
};
