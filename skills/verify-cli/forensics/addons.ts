import { realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { at, parsedJson } from "../helper/json.ts";
import {
  currentUid,
  fatalUtf8,
  forensicsLimits,
  forensicsSchema,
  formatMode,
  lenientDecoder,
  lstatSafe,
  openListedDirectory,
  readBytesNoFollow,
  textField,
} from "./io.ts";

const lockName = ".allocation-lock";
const ownerPattern = /^owner-([1-9][0-9]{0,9})-([0-9a-f]{16})$/;
const residuePattern =
  /^\.allocation-lock\.(pending|retiring)-([1-9][0-9]{0,9})-([0-9a-f]{16})-[0-9a-f]{16}$/;
const markerPattern = /^(.+)\.closed-([0-9]+)-([0-9]+)-([0-9]+)$/;
const consumedPattern = /^([0-9a-f]{64})\.consumed$/;
const approvalFormatKinds: Readonly<
  Record<string, "grant" | "closure" | "stop">
> = {
  "contract3.approval-grant": "grant",
  "contract3.closure-authority": "closure",
  "contract3.stop-attestation": "stop",
};

export type DiagnosticsFileReport = {
  readonly file: string;
  readonly bytes: number;
  readonly lines: number;
  readonly linesTruncated: boolean;
  readonly redactedLines: number;
  readonly truncatedLines: number;
  readonly invalidJsonLines: number;
  readonly lastEvent: string | null;
  readonly closedMarker: "matched" | "absent" | "mismatched";
};

export type DiagnosticsResidue = {
  readonly name: string;
  readonly kind: "pending" | "retiring";
  readonly pid: number;
  readonly host: string;
};

export type DiagnosticsForensicsReport = {
  readonly schema: typeof forensicsSchema;
  readonly target: "diagnostics";
  readonly path: string;
  readonly status: "clean" | "issues" | "unknown";
  readonly summary: string;
  readonly mode: string;
  readonly trustedAncestors: boolean;
  readonly lock: {
    readonly present: boolean;
    readonly ownerPid: number | null;
    readonly ownerHost: string | null;
    readonly entries: readonly string[];
  };
  readonly residue: readonly DiagnosticsResidue[];
  readonly orphanMarkers: readonly string[];
  readonly files: readonly DiagnosticsFileReport[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
};

function isTrustedDirectory(info: Stats): boolean {
  const uidOk = currentUid === -1 || info.uid === currentUid || info.uid === 0;
  const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
  const modeOk = (info.mode & 0o022) === 0 || stickyRoot;
  return info.isDirectory() && uidOk && modeOk;
}

function checkTrustedAncestors(folder: string): {
  readonly trusted: boolean;
  readonly reason: string | undefined;
} {
  let current: string;
  try {
    current = realpathSync(folder);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      trusted: false,
      reason: `cannot resolve real path for ancestors: ${reason}`,
    };
  }
  for (;;) {
    const stat = lstatSafe(current);
    if (stat.kind !== "ok")
      return {
        trusted: false,
        reason:
          stat.kind === "missing"
            ? `ancestor ${current} is missing`
            : `cannot stat ancestor ${current}: ${stat.reason}`,
      };
    if (!isTrustedDirectory(stat.stats))
      return {
        trusted: false,
        reason: `ancestor ${current} fails the trusted-ancestor permission check`,
      };
    const parent = dirname(current);
    if (parent === current) return { trusted: true, reason: undefined };
    current = parent;
  }
}

function parseLockOwner(entries: readonly string[]) {
  const match =
    entries.length === 1 ? ownerPattern.exec(entries[0] ?? "") : null;
  return {
    ownerPid: match?.[1] ? Number(match[1]) : null,
    ownerHost: match?.[2] ?? null,
  };
}

function readCustodyLock(
  folder: string,
  present: boolean,
): {
  readonly lock: DiagnosticsForensicsReport["lock"];
  readonly truncated: boolean;
  readonly problems: readonly string[];
} {
  if (!present)
    return {
      lock: { present: false, ownerPid: null, ownerHost: null, entries: [] },
      truncated: false,
      problems: [],
    };
  const listed = openListedDirectory("Custody lock", join(folder, lockName));
  if (!listed.ok)
    return {
      lock: { present: true, ownerPid: null, ownerHost: null, entries: [] },
      truncated: false,
      problems: [`.allocation-lock unreadable: ${listed.reason}`],
    };
  const entries = [...listed.names];
  const { ownerPid, ownerHost } = parseLockOwner(entries);
  const problems =
    ownerPid === null
      ? [
          `.allocation-lock has unexpected contents (${String(entries.length)} entries)`,
          ".allocation-lock is present with no valid owner file",
        ]
      : [
          `.allocation-lock is present (owner pid ${String(ownerPid)}, host ${String(ownerHost)})`,
        ];
  return {
    lock: { present: true, ownerPid, ownerHost, entries },
    truncated: listed.truncated,
    problems,
  };
}

function parseResidue(name: string): DiagnosticsResidue | undefined {
  const match = residuePattern.exec(name);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    name,
    kind: match[1] === "pending" ? "pending" : "retiring",
    pid: Number(match[2]),
    host: match[3],
  };
}

function partitionDiagnosticsEntries(names: readonly string[]) {
  const nameSet = new Set(names);
  const residue: DiagnosticsResidue[] = [];
  const orphanMarkers: string[] = [];
  const markersByBase = new Map<string, string[]>();
  const dataNames: string[] = [];
  const problems: string[] = [];

  for (const name of names) {
    if (name === lockName) continue;
    const foundResidue = parseResidue(name);
    if (foundResidue !== undefined) {
      residue.push(foundResidue);
      problems.push(`custody lock residue present: ${name}`);
      continue;
    }
    const base = markerPattern.exec(name)?.[1];
    if (base !== undefined) {
      markersByBase.set(base, [...(markersByBase.get(base) ?? []), name]);
      if (!nameSet.has(base)) {
        orphanMarkers.push(name);
        problems.push(`orphan closed marker: ${name}`);
      }
      continue;
    }
    dataNames.push(name);
  }
  return {
    lockPresent: nameSet.has(lockName),
    residue,
    orphanMarkers,
    markersByBase,
    dataNames,
    problems,
  };
}

function scanDiagnosticsLines(bytes: Uint8Array) {
  const rawLines = lenientDecoder
    .decode(bytes)
    .split("\n")
    .filter((line) => line.length > 0);
  const linesTruncated = rawLines.length > forensicsLimits.maxDiagnosticsLines;
  const scanned = linesTruncated
    ? rawLines.slice(0, forensicsLimits.maxDiagnosticsLines)
    : rawLines;
  let redactedLines = 0;
  let truncatedLines = 0;
  let invalidJsonLines = 0;
  let lastEvent: string | null = null;
  for (const line of scanned) {
    if (line.includes("[REDACTED]")) redactedLines += 1;
    if (line.includes("[truncated:")) truncatedLines += 1;
    const parsed = parsedJson(line);
    if (parsed === undefined) invalidJsonLines += 1;
    else lastEvent = textField(at(parsed, "event")) ?? lastEvent;
  }
  return {
    lines: rawLines.length,
    linesTruncated,
    redactedLines,
    truncatedLines,
    invalidJsonLines,
    lastEvent,
  };
}

function isOwnPrivateMarker(folder: string, name: string): boolean {
  const stat = lstatSafe(join(folder, name));
  if (stat.kind !== "ok") return false;
  return (
    stat.stats.isDirectory() &&
    !stat.stats.isSymbolicLink() &&
    stat.stats.uid === currentUid &&
    (stat.stats.mode & 0o7777) === 0o700
  );
}

function summarizeDiagnosticsFile(
  folder: string,
  name: string,
  markers: readonly string[],
): {
  readonly report: DiagnosticsFileReport | undefined;
  readonly problems: readonly string[];
} {
  const read = readBytesNoFollow(join(folder, name));
  if (read.kind !== "read")
    return {
      report: undefined,
      problems: [
        `${name}: ${read.kind === "missing" ? "missing" : read.reason}`,
      ],
    };
  const expected = `${name}.closed-${String(read.stats.dev)}-${String(read.stats.ino)}-${String(read.stats.size)}`;
  const closedMarker: DiagnosticsFileReport["closedMarker"] =
    markers.includes(expected) && isOwnPrivateMarker(folder, expected)
      ? "matched"
      : markers.length > 0
        ? "mismatched"
        : "absent";
  const scanned = scanDiagnosticsLines(read.bytes);
  const problems = [
    ...(closedMarker === "mismatched"
      ? [
          `${name}: closed marker does not match current dev/ino/size or is not an owned 0o0700 directory`,
        ]
      : []),
    ...(scanned.invalidJsonLines > 0
      ? [`${name}: ${String(scanned.invalidJsonLines)} invalid JSON line(s)`]
      : []),
  ];
  return {
    report: {
      file: name,
      bytes: read.bytes.byteLength,
      ...scanned,
      closedMarker,
    },
    problems,
  };
}

function directoryPermissionProblems(
  stats: Stats,
  mode: string,
  ancestorReason: string | undefined,
): readonly string[] {
  const modeBits = stats.mode & 0o7777;
  return [
    ...(modeBits !== 0o700
      ? [`diagnostics directory mode is ${mode}, expected 0o0700`]
      : []),
    ...(currentUid !== -1 && stats.uid !== currentUid
      ? ["diagnostics directory uid does not match current user"]
      : []),
    ...(ancestorReason === undefined ? [] : [ancestorReason]),
  ];
}

export function inspectDiagnosticsFolder(
  folder: string,
):
  | { readonly ok: true; readonly report: DiagnosticsForensicsReport }
  | { readonly ok: false; readonly reason: string } {
  const opened = openListedDirectory("Diagnostics folder", folder);
  if (!opened.ok) return opened;
  const mode = formatMode(opened.stats);
  const ancestors = checkTrustedAncestors(folder);
  const parts = partitionDiagnosticsEntries(opened.names);
  const lockInfo = readCustodyLock(folder, parts.lockPresent);
  const summaries = parts.dataNames.map((name) =>
    summarizeDiagnosticsFile(folder, name, parts.markersByBase.get(name) ?? []),
  );
  const files = summaries.flatMap((item) =>
    item.report === undefined ? [] : [item.report],
  );
  const unclosed = files.filter(
    (item) => item.closedMarker !== "matched",
  ).length;
  const absentMarkers = files.filter(
    (item) => item.closedMarker === "absent",
  ).length;
  const truncated =
    opened.truncated ||
    lockInfo.truncated ||
    files.some((item) => item.linesTruncated);
  const problems = [
    ...directoryPermissionProblems(opened.stats, mode, ancestors.reason),
    ...lockInfo.problems,
    ...parts.problems,
    ...summaries.flatMap((item) => item.problems),
    ...(truncated
      ? ["diagnostics listing or file lines were truncated at forensics limits"]
      : []),
  ];
  const unclosedLabel =
    absentMarkers > 0
      ? `${String(unclosed)} unclosed: may still be running or may have crashed before closing; allocation lock is released on open`
      : `${String(unclosed)} unclosed`;
  const status: DiagnosticsForensicsReport["status"] =
    problems.length > 0 ? "issues" : unclosed > 0 ? "unknown" : "clean";
  return {
    ok: true,
    report: {
      schema: forensicsSchema,
      target: "diagnostics",
      path: folder,
      status,
      summary: `Diagnostics folder (${mode}): ${String(files.length)} file(s) (${unclosedLabel}), lock ${lockInfo.lock.present ? "present" : "absent"}, ${String(parts.residue.length)} residue, ${String(problems.length)} problems.`,
      mode,
      trustedAncestors: ancestors.trusted,
      lock: lockInfo.lock,
      residue: parts.residue,
      orphanMarkers: parts.orphanMarkers,
      files,
      truncated,
      problems,
    },
  };
}

export type ApprovalEntryReport = {
  readonly file: string;
  readonly kind:
    | "consumed"
    | "grant"
    | "closure"
    | "stop"
    | "malformed"
    | "other";
  readonly keyHash: string | null;
  readonly operation: string | null;
  readonly expiresAt: number | null;
  readonly expired: boolean | null;
  readonly problems: readonly string[];
};

export type ApprovalForensicsReport = {
  readonly schema: typeof forensicsSchema;
  readonly target: "approval";
  readonly path: string;
  readonly status: "clean" | "issues";
  readonly summary: string;
  readonly entries: readonly ApprovalEntryReport[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
};

const approvalIdentityEncoder = new TextEncoder();
const approvalControlPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const approvalExpectedKeys: Readonly<
  Record<"grant" | "closure" | "stop", readonly string[]>
> = {
  grant: [
    "authority",
    "effects",
    "expiresAt",
    "format",
    "operation",
    "preview",
    "resource",
    "resourceRevision",
    "version",
  ],
  closure: [
    "disposition",
    "evidence",
    "expiresAt",
    "format",
    "operation",
    "scope",
    "version",
  ],
  stop: [
    "expiresAt",
    "format",
    "operation",
    "owner",
    "scope",
    "version",
    "writers",
  ],
};

function validApprovalIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    approvalIdentityEncoder.encode(value).byteLength <= 256 &&
    !approvalControlPattern.test(value)
    ? value
    : undefined;
}

function validApprovalIdentitySet(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return false;
  const seen = new Set<string>();
  for (const item of value) {
    const checked = validApprovalIdentity(item);
    if (checked === undefined || seen.has(checked)) return false;
    seen.add(checked);
  }
  return true;
}

function hasExactApprovalKeys(
  kind: "grant" | "closure" | "stop",
  parsed: unknown,
): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  const expected = approvalExpectedKeys[kind];
  const actual = Object.keys(parsed).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasApprovalIdentities(
  parsed: unknown,
  keys: readonly string[],
): boolean {
  return keys.every(
    (key) => validApprovalIdentity(at(parsed, key)) !== undefined,
  );
}

function hasApprovalPayloadFields(
  kind: "grant" | "closure" | "stop",
  parsed: unknown,
): boolean {
  if (
    !hasExactApprovalKeys(kind, parsed) ||
    validApprovalIdentity(at(parsed, "operation")) === undefined
  )
    return false;
  if (kind === "grant")
    return (
      hasApprovalIdentities(parsed, [
        "preview",
        "authority",
        "resource",
        "resourceRevision",
      ]) && validApprovalIdentitySet(at(parsed, "effects"))
    );
  if (kind === "closure")
    return (
      at(parsed, "disposition") === "outcome-unknown" &&
      hasApprovalIdentities(parsed, ["evidence", "scope"])
    );
  return (
    hasApprovalIdentities(parsed, ["owner", "scope"]) &&
    validApprovalIdentitySet(at(parsed, "writers"))
  );
}

function classifyApprovalKind(
  format: string | null,
  version: unknown,
  operation: string | null,
  expiresAt: number | null,
): ApprovalEntryReport["kind"] {
  if (
    format === null ||
    version !== 1 ||
    operation === null ||
    expiresAt === null ||
    !Object.hasOwn(approvalFormatKinds, format)
  )
    return "malformed";
  return approvalFormatKinds[format] ?? "malformed";
}

const approvalLimitBytes = 16 * 1024;
const approvalDepthLimit = 8;

function withinApprovalDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= approvalDepthLimit) return false;
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.every((item) => withinApprovalDepth(item, depth + 1));
}

function decodeApprovalJson(bytes: Uint8Array): unknown {
  try {
    const parsed = parsedJson(fatalUtf8.decode(bytes));
    return withinApprovalDepth(parsed, 0) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function inspectApprovalJson(
  name: string,
  bytes: Uint8Array,
  now: number,
): ApprovalEntryReport {
  const parsed = decodeApprovalJson(bytes);
  const operation = textField(at(parsed, "operation"));
  const expiresRaw = at(parsed, "expiresAt");
  const expiresAt =
    typeof expiresRaw === "number" &&
    Number.isSafeInteger(expiresRaw) &&
    expiresRaw > 0
      ? expiresRaw
      : null;
  const expired = expiresAt === null ? null : expiresAt <= now;
  const baseKind = classifyApprovalKind(
    textField(at(parsed, "format")),
    at(parsed, "version"),
    operation,
    expiresAt,
  );
  const kind =
    baseKind === "grant" || baseKind === "closure" || baseKind === "stop"
      ? hasApprovalPayloadFields(baseKind, parsed)
        ? baseKind
        : "malformed"
      : baseKind;
  const problems = [
    ...(kind === "malformed"
      ? ["unrecognised or malformed approval JSON record"]
      : []),
    ...(expired === true ? ["record is expired"] : []),
  ];
  return {
    file: name,
    kind,
    keyHash: null,
    operation,
    expiresAt,
    expired,
    problems,
  };
}

function inspectApprovalEntry(
  folder: string,
  name: string,
  now: number,
): ApprovalEntryReport {
  const isJson = name.endsWith(".json");
  const read = readBytesNoFollow(
    join(folder, name),
    isJson ? approvalLimitBytes : forensicsLimits.maxFileBytes,
  );
  if (read.kind !== "read")
    return {
      file: name,
      kind: isJson ? "malformed" : "other",
      keyHash: null,
      operation: null,
      expiresAt: null,
      expired: null,
      problems: [read.kind === "missing" ? "missing" : read.reason],
    };
  const keyHash = consumedPattern.exec(name)?.[1];
  if (keyHash !== undefined) {
    const parsed = parsedJson(lenientDecoder.decode(read.bytes));
    const problems =
      read.bytes.byteLength > 0 && parsed === undefined
        ? ["consumed marker body is not valid JSON"]
        : [];
    return {
      file: name,
      kind: "consumed",
      keyHash,
      operation:
        textField(at(parsed, "runId")) ?? textField(at(parsed, "operation")),
      expiresAt: null,
      expired: null,
      problems,
    };
  }
  if (isJson) {
    if (read.stats.nlink !== 1)
      return {
        file: name,
        kind: "malformed",
        keyHash: null,
        operation: null,
        expiresAt: null,
        expired: null,
        problems: ["approval record has multiple hard links"],
      };
    return inspectApprovalJson(name, read.bytes, now);
  }
  return {
    file: name,
    kind: "other",
    keyHash: null,
    operation: null,
    expiresAt: null,
    expired: null,
    problems: ["unexpected file in approval folder"],
  };
}

export function inspectApprovalFolder(
  folder: string,
  now = Date.now(),
):
  | { readonly ok: true; readonly report: ApprovalForensicsReport }
  | { readonly ok: false; readonly reason: string } {
  const opened = openListedDirectory("Approval folder", folder);
  if (!opened.ok) return opened;
  const entries = opened.names.map((name) =>
    inspectApprovalEntry(folder, name, now),
  );
  const problems = [
    ...entries.flatMap((entry) =>
      entry.problems.map((issue) => `${entry.file}: ${issue}`),
    ),
    ...(opened.truncated
      ? ["approval folder listing was truncated at forensics limits"]
      : []),
  ];
  const consumed = entries.filter((entry) => entry.kind === "consumed").length;
  return {
    ok: true,
    report: {
      schema: forensicsSchema,
      target: "approval",
      path: folder,
      status: problems.length === 0 ? "clean" : "issues",
      summary: `Approval folder: ${String(entries.length)} entry(s) (${String(consumed)} consumed), ${String(problems.length)} problems.`,
      entries,
      truncated: opened.truncated,
      problems,
    },
  };
}
