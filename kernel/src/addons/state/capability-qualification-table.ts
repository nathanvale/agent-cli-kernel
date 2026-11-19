// Interface: the reviewed capability qualification table (journal version 2
// design part 2 section 3). Closure under a row needs, read at that moment:
// process.platform equal to `os`, the first part of os.release() equal to
// `majorRelease`, the state root's statfs type equal to `filesystem.type`,
// the coordination route equal to `primitive`, `bootIdentitySource` equal to
// the file the add-on reads and that file readable and non-empty, and every
// store folder on the root's device. The other fields are recorded, not
// matched. Where no row matches, every closure of an unresolved case hands
// off (O10, Q01). A row cites its committed capability qualification record
// and names its review (Q03.a).

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
  Object.freeze([
    {
      id: "linux-7-btrfs",
      os: "linux",
      majorRelease: "7",
      observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
      filesystem: { name: "btrfs", type: 0x9123683e },
      primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
      bootIdentitySource: "/proc/sys/kernel/random/boot_id",
      processIdentity: "boot identity only (journal version 2)",
      namespace:
        "a non-root user (uid 1000) in an OrbStack container; the container machine owns the operating-system kernel and the boot identity",
      delegatedWriters:
        "closure after a delegate start only when every recorded delegate start names a boot identity other than the current one (journal version 2 design part 2 section 5)",
      failureCases: [
        movedStateRoot,
        "A state root shared between containers: one state root belongs to one machine (decided by Nathan, 19 November 2026).",
        "A state root on the container's writable layer (overlay 0x794C7630; decided by Nathan, 19 November 2026), on a bind mount of a folder shared from another system, or on a network mount (journal version 2 design part 2 section 2.1): no row.",
        "A delegated program on the same boot: closure refuses delegate-recorded until the container machine restarts; restarting only the container keeps the boot identity.",
        "Remote work a delegated program started (CMD-14).",
      ],
      evidence: {
        record:
          "tests/kernel/state/capability-qualification/linux-7-btrfs.json",
        review: {
          session: "local_6613a802-3afb-42b7-8df7-2c9c698e49a1",
          countersignature: "",
          date: "2026-11-20",
        },
      },
    },
  ]);
