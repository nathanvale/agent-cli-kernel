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
// `source` is "production" for a reviewed row or the unqualified default, and
// "fixture" only for the labelled test entry (fixture.ts), which a host
// never imports.
export type Qualification = {
  readonly label: string;
  readonly source: "production" | "fixture";
  readonly stoppedOwner: "lease-and-no-delegate" | "unavailable";
};

// Production: the reviewed row matching this environment, if any. Takes no
// input, so a caller cannot choose its own qualification.
export function resolveQualification(): Qualification {
  const row = qualificationRows.find(
    (entry) => entry.os === process.platform && entry.osRelease === release(),
  );
  return row
    ? {
        label: row.id,
        source: "production",
        stoppedOwner: "lease-and-no-delegate",
      }
    : {
        label: "unqualified",
        source: "production",
        stoppedOwner: "unavailable",
      };
}

export type CapabilityReport = {
  readonly qualification: string;
  readonly coordination: "available" | "unavailable";
  readonly stoppedOwnerProof: "available" | "fixture-only" | "unavailable";
  readonly automaticReclaim: "unavailable";
  readonly humanAssistedTakeover: "unavailable";
  readonly humanOutcomeUnknownClosure: "available" | "unavailable";
  readonly reasons: readonly string[];
};
