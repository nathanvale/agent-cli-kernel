// Interface: the reviewed capability qualification table (journal version 2
// design part 2 section 3). A row enables the stopped-owner condition only
// where every matched field equals what closure observes. Rows land one per
// pull request, each with its committed capability qualification record, its
// independent review and Nathan's countersignature. Empty until then, so
// every closure of an unresolved case hands off (O10, Q01).

export const movedStateRoot =
  "A state root moved to another machine: no machine identity is recorded (decision P, Nathan, 19 November 2026).";

export type CapabilityQualificationRow = {
  readonly id: string;
  readonly os: string;
  readonly majorRelease: string;
  readonly observedRelease: string;
  readonly filesystem: { readonly name: string; readonly type: number };
  readonly primitive: string;
  readonly bootIdentitySource: string;
  readonly processIdentity: string;
  readonly namespace: string;
  readonly delegatedWriters: string;
  readonly failureCases: readonly [typeof movedStateRoot, ...string[]];
  readonly evidence: {
    readonly record: string;
    readonly review: {
      readonly session: string;
      readonly countersignature: string;
      readonly date: string;
    };
  };
};

export const capabilityQualificationTable: readonly CapabilityQualificationRow[] =
  Object.freeze([]);
