// Interface: the reviewed capability qualification table (journal version 2
// design part 2 section 3). Closure under a row needs, read at that moment:
// process.platform equal to `os`, the first part of os.release() equal to
// `majorRelease`, the state root's statfs type equal to `filesystem.type`,
// the coordination route equal to `primitive`, `bootIdentitySource` equal to
// the file the add-on reads and that file readable and non-empty, and every
// store folder on the root's device. The other fields are recorded, not
// matched. Empty, so every closure of an unresolved case hands off (O10,
// Q01).

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
