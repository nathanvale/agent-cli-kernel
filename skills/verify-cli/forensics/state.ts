import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  currentUid,
  forensicsSchema,
  listDirectoryBounded,
  lstatSafe,
  openRealDirectory,
  parseC3s1Records,
  plainRecord,
  readBytesNoFollow,
  singleC3s1Record,
  stringList,
  textField,
} from "./io.ts";

const operationPattern = /^op-[0-9a-f]{32}$/;

function journalRevisionOf(
  intentBytes: Uint8Array,
  eventBytes: Uint8Array,
): string {
  return `r-${createHash("sha256").update(intentBytes).update("\n").update(eventBytes).digest("hex")}`;
}

function privateModeOk(stats: Stats): boolean {
  const ownUid = currentUid === -1 || stats.uid === currentUid;
  const noGroupOtherWrite = (stats.mode & 0o022) === 0;
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    ownUid &&
    noGroupOtherWrite
  );
}

export type StateCaseReport = {
  readonly folder: "operations" | "settled";
  readonly operationId: string;
  readonly status:
    | "closed"
    | "completed"
    | "not-applied"
    | "unresolved"
    | "corrupt";
  readonly commandIdentity: string | null;
  readonly runId: string | null;
  readonly effects: readonly string[];
  readonly ownerPid: number | null;
  readonly leasePresent: boolean;
  readonly closes: string | null;
  readonly scopeUnknown: boolean | null;
  readonly eventKinds: readonly string[];
  readonly delegateBoots: readonly (string | null)[];
  readonly tornTail: boolean;
  readonly tornOffset: number | null;
  readonly recordHiddenInTornTail: boolean;
  readonly closure: {
    readonly state: "absent" | "valid" | "damaged" | "unreadable";
    readonly disposition: string | null;
    readonly qualification: string | null;
    readonly journalRevisionMatches: boolean | null;
  };
  readonly revision: string | null;
  readonly problems: readonly string[];
};

function readIntentPart(directory: string, operationId: string) {
  const read = readBytesNoFollow(join(directory, "intent"));
  if (read.kind !== "read")
    return {
      payload: undefined,
      bytes: undefined,
      problem:
        read.kind === "missing"
          ? "intent file is missing"
          : `intent unreadable: ${read.reason}`,
    };
  const payload = singleC3s1Record(read.bytes, "intent");
  const valid = payload !== undefined && payload.operationId === operationId;
  return {
    payload: valid ? payload : undefined,
    bytes: read.bytes,
    problem: valid
      ? undefined
      : "intent record is corrupt or mismatches operationId",
  };
}

type EventsPart = {
  readonly valid: boolean;
  readonly bytes: Uint8Array | undefined;
  readonly eventKinds: readonly string[];
  readonly delegateBoots: readonly (string | null)[];
  readonly tornTail: boolean;
  readonly tornOffset: number | null;
  readonly recordHiddenInTornTail: boolean;
  readonly problems: readonly string[];
};

function failedEvents(
  bytes: Uint8Array | undefined,
  problem: string,
): EventsPart {
  return {
    valid: false,
    bytes,
    eventKinds: [],
    delegateBoots: [],
    tornTail: false,
    tornOffset: null,
    recordHiddenInTornTail: false,
    problems: [problem],
  };
}

function readEventsPart(directory: string): EventsPart {
  const read = readBytesNoFollow(join(directory, "events"));
  if (read.kind !== "read")
    return failedEvents(
      undefined,
      read.kind === "missing"
        ? "events file is missing"
        : `events unreadable: ${read.reason}`,
    );
  const parsed = parseC3s1Records(read.bytes);
  if (!parsed.ok)
    return failedEvents(
      read.bytes,
      `events file has corrupt framing at byte ${String(parsed.failureOffset)}`,
    );
  const problems: string[] = [];
  if (parsed.tornTail)
    problems.push(
      `events file has a torn tail at byte ${String(parsed.tornOffset)}`,
    );
  if (parsed.recordHiddenInTornTail)
    problems.push(
      "a complete C3S1 record starts mid-line inside the torn tail",
    );
  return {
    valid: true,
    bytes: read.bytes,
    eventKinds: parsed.records.map((entry) => entry.kind),
    delegateBoots: parsed.records
      .filter((entry) => entry.kind === "delegate-admitted")
      .map((entry) => textField(entry.payload.boot)),
    tornTail: parsed.tornTail,
    tornOffset: parsed.tornOffset,
    recordHiddenInTornTail: parsed.recordHiddenInTornTail,
    problems,
  };
}

function emptyClosure(state: "absent" | "damaged" | "unreadable") {
  return {
    state,
    disposition: null,
    qualification: null,
    journalRevisionMatches: null,
  };
}

function readClosurePart(
  directory: string,
  operationId: string,
  revision: string | null,
) {
  const read = readBytesNoFollow(join(directory, "closure"));
  if (read.kind === "missing")
    return { closure: emptyClosure("absent"), problem: undefined };
  if (read.kind === "unreadable")
    return {
      closure: emptyClosure("unreadable"),
      problem: `closure unreadable: ${read.reason}`,
    };
  const payload = singleC3s1Record(read.bytes, "closure");
  if (payload === undefined || payload.operationId !== operationId)
    return {
      closure: emptyClosure("damaged"),
      problem: "closure record is damaged",
    };
  const recorded = textField(payload.journalRevision);
  const matches =
    revision !== null && recorded !== null ? recorded === revision : null;
  return {
    closure: {
      state: "valid" as const,
      disposition: textField(payload.disposition),
      qualification: textField(payload.qualification),
      journalRevisionMatches: matches,
    },
    problem:
      matches === false
        ? "closure journalRevision does not match intent+events"
        : undefined,
  };
}

function deriveCaseStatus(
  hasIntent: boolean,
  eventsValid: boolean,
  closureValid: boolean,
  eventKinds: readonly string[],
): StateCaseReport["status"] {
  if (!hasIntent || !eventsValid) return "corrupt";
  if (closureValid) return "closed";
  if (eventKinds.includes("completion")) return "completed";
  if (eventKinds.includes("not-applied")) return "not-applied";
  return "unresolved";
}

function intentFields(payload: Readonly<Record<string, unknown>> | undefined) {
  const owner = plainRecord(payload?.owner);
  const scope = plainRecord(payload?.scope);
  return {
    commandIdentity: textField(payload?.commandIdentity),
    runId: textField(payload?.runId),
    effects: stringList(payload?.effects),
    ownerPid: typeof owner?.pid === "number" ? owner.pid : null,
    closes: textField(payload?.closes),
    scopeUnknown: typeof scope?.unknown === "boolean" ? scope.unknown : null,
  };
}

function inspectStateCase(
  folder: "operations" | "settled",
  directory: string,
  operationId: string,
): StateCaseReport {
  const leaseStat = lstatSafe(join(directory, "owner.lease"));
  const intent = readIntentPart(directory, operationId);
  const events = readEventsPart(directory);
  const revision =
    intent.bytes !== undefined && events.bytes !== undefined
      ? journalRevisionOf(intent.bytes, events.bytes)
      : null;
  const closed = readClosurePart(directory, operationId, revision);
  const status = deriveCaseStatus(
    intent.payload !== undefined,
    events.valid,
    closed.closure.state === "valid",
    events.eventKinds,
  );
  const problems = [
    ...(leaseStat.kind === "error"
      ? [`owner.lease unreadable: ${leaseStat.reason}`]
      : []),
    ...(intent.problem === undefined ? [] : [intent.problem]),
    ...events.problems,
    ...(closed.problem === undefined ? [] : [closed.problem]),
    ...(folder === "settled" && status === "unresolved"
      ? ["unresolved case found inside settled/"]
      : []),
  ];
  return {
    folder,
    operationId,
    status,
    ...intentFields(intent.payload),
    leasePresent: leaseStat.kind === "ok",
    eventKinds: events.eventKinds,
    delegateBoots: events.delegateBoots,
    tornTail: events.tornTail,
    tornOffset: events.tornOffset,
    recordHiddenInTornTail: events.recordHiddenInTornTail,
    closure: closed.closure,
    revision,
    problems,
  };
}

function readFormatJournal(root: string): {
  readonly journal: string | null;
  readonly problem: string | undefined;
} {
  const read = readBytesNoFollow(join(root, "format"));
  if (read.kind !== "read")
    return {
      journal: null,
      problem:
        read.kind === "missing"
          ? "format file is missing"
          : `format file unreadable: ${read.reason}`,
    };
  const payload = singleC3s1Record(read.bytes, "format");
  const journal = textField(payload?.journal);
  const known =
    journal === "contract3.state" || journal === "contract3.state.2";
  return {
    journal,
    problem: known
      ? undefined
      : `format record is invalid or unknown journal (${String(journal)})`,
  };
}

function listSubdir(
  root: string,
  name: string,
): {
  readonly names: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
  readonly problem: string | undefined;
} {
  const listed = listDirectoryBounded(join(root, name));
  if (listed.kind !== "ok")
    return {
      names: [],
      total: 0,
      truncated: false,
      problem:
        listed.kind === "missing"
          ? `${name}/ directory is missing`
          : `${name}/ unreadable: ${listed.reason}`,
    };
  return {
    names: [...listed.names],
    total: listed.total,
    truncated: listed.truncated,
    problem: undefined,
  };
}

function scanCaseBucket(
  root: string,
  folder: "operations" | "settled",
  required: boolean,
): {
  readonly cases: readonly StateCaseReport[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
} {
  const dirPath = join(root, folder);
  const listed = listDirectoryBounded(dirPath);
  if (listed.kind !== "ok")
    return {
      cases: [],
      truncated: false,
      problems:
        listed.kind === "missing"
          ? required
            ? [`${folder}/ directory is missing`]
            : []
          : [`${folder}/ unreadable: ${listed.reason}`],
    };
  const cases: StateCaseReport[] = [];
  const problems: string[] = [];
  for (const name of listed.names) {
    if (!operationPattern.test(name)) {
      problems.push(`${folder}/ contains unexpected entry ${name}`);
      continue;
    }
    const report = inspectStateCase(folder, join(dirPath, name), name);
    cases.push(report);
    for (const issue of report.problems)
      problems.push(`${folder}/${name}: ${issue}`);
  }
  return { cases, truncated: listed.truncated, problems };
}

export type StateForensicsReport = {
  readonly schema: typeof forensicsSchema;
  readonly target: "state";
  readonly path: string;
  readonly status: "clean" | "issues";
  readonly summary: string;
  readonly rootMode: string;
  readonly journal: string | null;
  readonly coordinationLocks: readonly string[];
  readonly stagingEntries: readonly string[];
  readonly cases: readonly StateCaseReport[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
};

export function inspectStateRoot(
  root: string,
):
  | { readonly ok: true; readonly report: StateForensicsReport }
  | { readonly ok: false; readonly reason: string } {
  const opened = openRealDirectory("State root", root);
  if (!opened.ok) return opened;
  const rootMode = `0o${(opened.stats.mode & 0o7777).toString(8).padStart(4, "0")}`;
  const fmt = readFormatJournal(root);
  const coord = listSubdir(root, "coordination");
  const staging = listSubdir(root, "staging");
  const ops = scanCaseBucket(root, "operations", true);
  const settled = scanCaseBucket(
    root,
    "settled",
    fmt.journal === "contract3.state.2",
  );
  const problems = [
    ...(privateModeOk(opened.stats)
      ? []
      : [
          `state root permissions/ownership failed private check (${rootMode})`,
        ]),
    ...(fmt.problem === undefined ? [] : [fmt.problem]),
    ...(coord.problem === undefined ? [] : [coord.problem]),
    ...(staging.problem === undefined
      ? staging.names.length > 0
        ? [
            `staging/ holds ${String(staging.total)} leftover entr${staging.total === 1 ? "y" : "ies"}`,
          ]
        : []
      : [staging.problem]),
    ...ops.problems,
    ...settled.problems,
  ];
  const cases = [...ops.cases, ...settled.cases];
  const unresolved = cases.filter(
    (entry) => entry.status === "unresolved",
  ).length;
  const corrupt = cases.filter((entry) => entry.status === "corrupt").length;
  return {
    ok: true,
    report: {
      schema: forensicsSchema,
      target: "state",
      path: root,
      status: problems.length === 0 && unresolved === 0 ? "clean" : "issues",
      summary: `State journal ${fmt.journal ?? "unknown"}: ${String(cases.length)} cases (${String(unresolved)} unresolved, ${String(corrupt)} corrupt), ${String(staging.names.length)} staged, ${String(problems.length)} problems.`,
      rootMode,
      journal: fmt.journal,
      coordinationLocks: coord.names,
      stagingEntries: staging.names,
      cases,
      truncated:
        coord.truncated ||
        staging.truncated ||
        ops.truncated ||
        settled.truncated,
      problems,
    },
  };
}
