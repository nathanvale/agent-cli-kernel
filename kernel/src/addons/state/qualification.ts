import { lstatSync, readFileSync, statfsSync } from "node:fs";
import { release } from "node:os";
import { capabilityQualificationTable } from "./capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "./capability-qualification-table.ts";
import { errorCode } from "./coordination.ts";
import { layout } from "./store.ts";

// Interface: the capability qualification run command uses these two, so a
// capability qualification record carries the add-on's own values: the boot
// identity source a row's `bootIdentitySource` must equal, and the rule that
// turns an os.release() string into the major release a row's
// `majorRelease` must equal (decision J, Nathan, 19 November 2026, 13:46).
export const bootIdentitySource = "/proc/sys/kernel/random/boot_id";

export function majorReleaseOf(release: string): string {
  return release.split(".")[0] ?? release;
}

export const deviceFolders = [
  "root",
  "coordination",
  "operations",
  "settled",
  "staging",
] as const;
export type DeviceFolder = (typeof deviceFolders)[number];

// Interface: test-entry stand-ins for what closure reads from the machine
// (journal version 2 design part 3 section 4; a device stands in for the
// state root's filesystem facts Q02.f needs, part 2 section 3). `null`
// stands for a fact that cannot be read.
export type FactOverrides = {
  readonly release?: string;
  readonly filesystem?: number | null;
  readonly bootIdentity?: string | null;
  readonly devices?: Readonly<Partial<Record<DeviceFolder, number | null>>>;
};

type Fact<T> =
  | { readonly read: true; readonly value: T }
  | { readonly read: false; readonly why: string };

type EnvironmentFacts = {
  readonly os: string;
  readonly release: string;
  readonly majorRelease: string;
  readonly filesystem: Fact<number>;
  readonly primitive: Fact<string>;
  readonly bootIdentity: Fact<string>;
  readonly devices: Readonly<Record<DeviceFolder, Fact<number>>>;
};

export type Match =
  | {
      readonly matched: true;
      readonly label: string;
      readonly bootIdentity: string | undefined;
    }
  | { readonly matched: false; readonly detail: string };

export type LocalFilesystemCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly detail: string };

// Interface: `bootIdentity` reads the boot identity now, with a test entry's
// override, and is undefined when it cannot be read or is empty. A matched
// Match carries the boot identity that same match read. `localFilesystem` checks
// whether the state root sits on a local filesystem whose lock is honoured.
export type Qualification = {
  readonly source: "production" | "fixture";
  readonly match: (root: string, primitive: string | undefined) => Match;
  readonly bootIdentity: () => string | undefined;
  readonly localFilesystem: (
    root: string,
    primitive: string | undefined,
  ) => LocalFilesystemCheck;
};

function attempt<T>(read: () => T): Fact<T> {
  try {
    return { read: true, value: read() };
  } catch (error) {
    return { read: false, why: errorCode(error) };
  }
}

function overridden<T>(
  value: T | null | undefined,
  read: () => Fact<T>,
): Fact<T> {
  if (value === undefined) return read();
  return value === null
    ? { read: false, why: "unreadable" }
    : { read: true, value };
}

function nonEmpty(fact: Fact<string>): Fact<string> {
  return fact.read && fact.value === "" ? { read: false, why: "empty" } : fact;
}

function readBootIdentity(overrides: FactOverrides): Fact<string> {
  return nonEmpty(
    overridden(overrides.bootIdentity, () =>
      attempt(() => readFileSync(bootIdentitySource, "utf8").trim()),
    ),
  );
}

function bootIdentityOf(overrides: FactOverrides): string | undefined {
  const fact = readBootIdentity(overrides);
  return fact.read ? fact.value : undefined;
}

export function machineBootIdentity(): string | undefined {
  return bootIdentityOf({});
}

function readDevices(
  root: string,
  overrides: FactOverrides,
): Readonly<Record<DeviceFolder, Fact<number>>> {
  const paths = layout(root);
  const device = (folder: DeviceFolder, path: string) => {
    const given = overrides.devices;
    return overridden(
      given !== undefined && Object.hasOwn(given, folder)
        ? given[folder]
        : undefined,
      () => attempt(() => lstatSync(path).dev),
    );
  };
  return {
    root: device("root", paths.root),
    coordination: device("coordination", paths.coordination),
    operations: device("operations", paths.operations),
    settled: device("settled", paths.settled),
    staging: device("staging", paths.staging),
  };
}

function readFacts(
  root: string,
  primitive: string | undefined,
  overrides: FactOverrides,
): EnvironmentFacts {
  const observed = overrides.release ?? release();
  return {
    os: process.platform,
    release: observed,
    majorRelease: majorReleaseOf(observed),
    filesystem: overridden(overrides.filesystem, () =>
      attempt(() => statfsSync(root).type),
    ),
    primitive:
      primitive === undefined
        ? { read: false, why: "no coordination route" }
        : { read: true, value: primitive },
    bootIdentity: readBootIdentity(overrides),
    devices: readDevices(root, overrides),
  };
}

function shown<T>(fact: Fact<T>, show: (value: T) => string): string {
  return fact.read ? show(fact.value) : `unreadable (${fact.why})`;
}

function hex(type: number): string {
  return `0x${type.toString(16).toUpperCase()}`;
}

function equals<T>(fact: Fact<T>, expected: T): boolean {
  return fact.read && fact.value === expected;
}

const rowChecks: readonly (readonly [
  string,
  (row: CapabilityQualificationRow, facts: EnvironmentFacts) => boolean,
])[] = [
  ["os", (row, facts) => row.os === facts.os],
  ["major release", (row, facts) => row.majorRelease === facts.majorRelease],
  ["filesystem", (row, facts) => equals(facts.filesystem, row.filesystem.type)],
  [
    "coordination route",
    (row, facts) => equals(facts.primitive, row.primitive),
  ],
  [
    "boot identity",
    (row, facts) =>
      facts.bootIdentity.read && row.bootIdentitySource === bootIdentitySource,
  ],
];

function differences(
  row: CapabilityQualificationRow,
  facts: EnvironmentFacts,
): readonly string[] {
  return rowChecks
    .filter(([, holds]) => !holds(row, facts))
    .map(([name]) => name);
}

function deviceProblem(facts: EnvironmentFacts): string | undefined {
  const { root, ...folders } = facts.devices;
  if (!root.read) return "the state root's device is unreadable";
  const off = Object.entries(folders)
    .filter(([, device]) => !equals(device, root.value))
    .map(([folder]) => `${folder}/`);
  return off.length === 0
    ? undefined
    : `not on the state root's device: ${off.join(", ")}`;
}

function observedText(facts: EnvironmentFacts): string {
  const devices = deviceFolders
    .map((folder) => `${folder} ${shown(facts.devices[folder], String)}`)
    .join(", ");
  return [
    `os ${facts.os}`,
    `release ${facts.release} (major ${facts.majorRelease})`,
    `filesystem ${shown(facts.filesystem, hex)}`,
    `coordination route ${shown(facts.primitive, String)}`,
    `boot identity ${shown(facts.bootIdentity, () => "readable")} from ${bootIdentitySource}`,
    `devices ${devices}`,
  ].join(", ");
}

function rowText(
  row: CapabilityQualificationRow,
  facts: EnvironmentFacts,
): string {
  const differs = differences(row, facts);
  return `${row.id} (os ${row.os}, major ${row.majorRelease}, filesystem ${row.filesystem.name} ${hex(row.filesystem.type)}, coordination route ${row.primitive}, boot identity from ${row.bootIdentitySource}): ${differs.length === 0 ? "every row field matches" : `differs in ${differs.join(", ")}`}`;
}

function matchFacts(
  rows: readonly CapabilityQualificationRow[],
  facts: EnvironmentFacts,
  label: (row: CapabilityQualificationRow) => string,
): Match {
  const devices = deviceProblem(facts);
  const row =
    devices === undefined
      ? rows.find((entry) => differences(entry, facts).length === 0)
      : undefined;
  if (row)
    return {
      matched: true,
      label: label(row),
      bootIdentity: facts.bootIdentity.read
        ? facts.bootIdentity.value
        : undefined,
    };
  const rowsText =
    rows.length === 0
      ? "no capability qualification row"
      : rows.map((entry) => rowText(entry, facts)).join("; ");
  return {
    matched: false,
    detail: `observed ${observedText(facts)}${devices === undefined ? "" : `; ${devices}`}; qualified: ${rowsText}`,
  };
}

// Platform: Linux <linux/magic.h> f_type values for local filesystems that
// honour flock(2): btrfs, ext2/3/4, xfs, tmpfs, zfs, f2fs, and bcachefs.
// Refuses NFS (0x6969), SMB/CIFS (0x517B, 0xFE534D42, 0xFF534D42), overlay
// (0x794C7630), FUSE (0x65735546), 9p (0x01021997), and unknown types.
const linuxLocalFilesystems: ReadonlySet<number> = new Set([
  0x9123683e, 0xef53, 0x58465342, 0x01021994, 0x2fc12fc1, 0xf2f52010,
  0xca451a4e,
]);

// Platform: Darwin assigns statfs f_type numbers per boot by VFS registration
// order, while the root volume "/" is always mounted on the local APFS boot
// filesystem. Matching the root volume's observed f_type accepts local APFS
// volumes across macOS releases while rejecting network mounts (NFS, SMB, AFP,
// WebDAV) and unknown filesystems without needing FFI or subprocesses.
function darwinLocalFilesystemType(): number | undefined {
  try {
    return statfsSync("/").type;
  } catch {
    return undefined;
  }
}

function localFilesystemAllowed(os: string, type: number): boolean {
  if (os === "linux") return linuxLocalFilesystems.has(type);
  if (os === "darwin") return type === darwinLocalFilesystemType();
  return false;
}

function checkLocalFilesystem(facts: EnvironmentFacts): LocalFilesystemCheck {
  if (!facts.primitive.read)
    return {
      allowed: false,
      detail: `coordination route ${facts.primitive.why}`,
    };
  const devices = deviceProblem(facts);
  if (devices !== undefined) return { allowed: false, detail: devices };
  if (!facts.filesystem.read)
    return {
      allowed: false,
      detail: `filesystem unreadable (${facts.filesystem.why})`,
    };
  if (localFilesystemAllowed(facts.os, facts.filesystem.value))
    return { allowed: true };
  return {
    allowed: false,
    detail: `os ${facts.os}, filesystem ${hex(facts.filesystem.value)} is not a supported local filesystem for coordination locks`,
  };
}

function qualificationOver(
  source: Qualification["source"],
  rows: readonly CapabilityQualificationRow[],
  overrides: FactOverrides,
  label: (row: CapabilityQualificationRow) => string,
): Qualification {
  return Object.freeze({
    source,
    match: (root: string, primitive: string | undefined) =>
      matchFacts(rows, readFacts(root, primitive, overrides), label),
    bootIdentity: () => bootIdentityOf(overrides),
    localFilesystem: (root: string, primitive: string | undefined) =>
      checkLocalFilesystem(readFacts(root, primitive, overrides)),
  });
}

export function resolveQualification(): Qualification {
  return qualificationOver(
    "production",
    capabilityQualificationTable,
    {},
    (row) => row.id,
  );
}

export function candidateQualification(
  fixtureLabel: string,
  candidate: CapabilityQualificationRow,
  overrides: FactOverrides,
): Qualification {
  const row = Object.freeze({
    ...candidate,
    filesystem: Object.freeze({ ...candidate.filesystem }),
  });
  return qualificationOver(
    "fixture",
    Object.freeze([row]),
    Object.freeze({
      ...overrides,
      ...(overrides.devices === undefined
        ? {}
        : { devices: Object.freeze({ ...overrides.devices }) }),
    }),
    () => `fixture:${fixtureLabel}`,
  );
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
