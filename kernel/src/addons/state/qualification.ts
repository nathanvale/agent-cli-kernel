import { lstatSync, readFileSync, statfsSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { capabilityQualificationTable } from "./capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "./capability-qualification-table.ts";
import { errorCode } from "./coordination.ts";

const bootIdentitySource = "/proc/sys/kernel/random/boot_id";

const storeFolders = [
  "coordination",
  "operations",
  "settled",
  "staging",
] as const;
export type DeviceFolder = "root" | (typeof storeFolders)[number];

// Interface: test-entry stand-ins for what closure reads from the machine
// (journal version 2 design part 3 section 4). `null` stands for a fact that
// cannot be read. A device override replaces lstat's device for that folder.
export type FactOverrides = {
  readonly release?: string;
  readonly filesystem?: number | null;
  readonly bootIdentity?: string | null;
  readonly devices?: Readonly<Partial<Record<DeviceFolder, number>>>;
};

type Fact<T> =
  | { readonly read: true; readonly value: T }
  | { readonly read: false; readonly why: string };

type EnvironmentFacts = {
  readonly os: string;
  readonly release: string;
  readonly majorRelease: Fact<string>;
  readonly filesystem: Fact<number>;
  readonly primitive: Fact<string>;
  readonly bootIdentity: Fact<string>;
  readonly devices: readonly (readonly [DeviceFolder, Fact<number>])[];
};

export type Match =
  | { readonly matched: true; readonly label: string }
  | { readonly matched: false; readonly detail: string };

export type Qualification = {
  readonly source: "production" | "fixture";
  readonly match: (root: string, primitive: string | undefined) => Match;
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

function deviceOf(
  root: string,
  folder: DeviceFolder,
  overrides: FactOverrides,
): Fact<number> {
  const devices = overrides.devices;
  const given =
    devices !== undefined && Object.hasOwn(devices, folder)
      ? devices[folder]
      : undefined;
  return overridden(given, () =>
    attempt(() => lstatSync(folder === "root" ? root : join(root, folder)).dev),
  );
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
    majorRelease: nonEmpty({
      read: true,
      value: observed.split(".")[0] ?? "",
    }),
    filesystem: overridden(overrides.filesystem, () =>
      attempt(() => statfsSync(root).type),
    ),
    primitive:
      primitive === undefined
        ? { read: false, why: "no coordination route" }
        : { read: true, value: primitive },
    bootIdentity: nonEmpty(
      overridden(overrides.bootIdentity, () =>
        attempt(() => readFileSync(bootIdentitySource, "utf8").trim()),
      ),
    ),
    devices: (["root", ...storeFolders] as const).map(
      (folder) => [folder, deviceOf(root, folder, overrides)] as const,
    ),
  };
}

function shown<T>(fact: Fact<T>, show: (value: T) => string): string {
  return fact.read ? show(fact.value) : `unreadable (${fact.why})`;
}

function hex(type: number): string {
  return `0x${type.toString(16).toUpperCase()}`;
}

function offRootDevice(facts: EnvironmentFacts): readonly string[] {
  const [first, ...folders] = facts.devices;
  const root = first?.[1];
  if (!root?.read) return ["root"];
  return folders
    .filter(([, device]) => !device.read || device.value !== root.value)
    .map(([folder]) => `${folder}/`);
}

function differences(
  row: CapabilityQualificationRow,
  facts: EnvironmentFacts,
): readonly string[] {
  const { majorRelease, filesystem, primitive, bootIdentity } = facts;
  return [
    ...(row.os === facts.os ? [] : ["os"]),
    ...(majorRelease.read && majorRelease.value === row.majorRelease
      ? []
      : ["major release"]),
    ...(filesystem.read && filesystem.value === row.filesystem.type
      ? []
      : ["filesystem"]),
    ...(primitive.read && primitive.value === row.primitive
      ? []
      : ["coordination route"]),
    ...(bootIdentity.read && row.bootIdentitySource === bootIdentitySource
      ? []
      : ["boot identity"]),
  ];
}

function observedText(facts: EnvironmentFacts): string {
  const devices = facts.devices
    .map(([folder, device]) => `${folder} ${shown(device, String)}`)
    .join(", ");
  return [
    `os ${facts.os}`,
    `release ${facts.release} (major ${shown(facts.majorRelease, String)})`,
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
  const nested = offRootDevice(facts);
  const row =
    nested.length === 0
      ? rows.find((entry) => differences(entry, facts).length === 0)
      : undefined;
  if (row) return { matched: true, label: label(row) };
  const qualified =
    rows.length === 0
      ? "no capability qualification row"
      : rows.map((entry) => rowText(entry, facts)).join("; ");
  const folders =
    nested.length === 0
      ? ""
      : `; not on the state root's device: ${nested.join(", ")}`;
  return {
    matched: false,
    detail: `observed ${observedText(facts)}${folders}; qualified: ${qualified}`,
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
