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

export const qualificationRows: readonly QualificationRow[] = Object.freeze([]);

export type Qualification = {
  readonly label: string;
  readonly source: "production" | "fixture";
  readonly stoppedOwner: "lease-and-no-delegate" | "unavailable";
};

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
  readonly coordinationRoute: string;
  readonly stoppedOwnerProof: "available" | "fixture-only" | "unavailable";
  readonly automaticReclaim: "unavailable";
  readonly humanAssistedTakeover: "unavailable";
  readonly humanOutcomeUnknownClosure: "available" | "unavailable";
  readonly reasons: readonly string[];
};
