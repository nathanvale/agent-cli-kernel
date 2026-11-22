import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  currentUid,
  forensicsSchema,
  formatMode,
  lstatSafe,
  openListedDirectory,
  openRealDirectory,
  parseC3s1Records,
  plainRecord,
  readBytesNoFollow,
  singleC3s1Record,
  stringList,
  textField,
} from "./io.ts";
import {
  invalidEventReason,
  validClosurePayload,
  validIntentPayload,
} from "./state-shape.ts";

const operationPattern = /^op-[0-9a-f]{32}$/;
const unresolvedNextAction =
  "Run the target CLI's ifNoResult command to see the operation and its scope, then check the affected resource by hand. If the command declares supersedeUnresolved, its next run closes this case as outcome unknown when the state root sits on a supported local filesystem (an unsupported filesystem refuses), the owner lease is free, the case is intact, and the new scope covers its conflict keys; otherwise close the case only if the CLI offers a close command on a host qualified for it, or it stays unresolved.";

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
  readonly leaseFilePresent: boolean;
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
  readonly nextAction: string | null;
  readonly problems: readonly string[];
};

type StateFileReader = typeof readBytesNoFollow;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function readIntentPart(
  directory: string,
  operationId: string,
  readFile: StateFileReader,
) {
  const read = readFile(join(directory, "intent"));
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
  const valid = validIntentPayload(payload, operationId);
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

function readEventsPart(
  directory: string,
  declaredEffects: readonly string[] | undefined,
  readFile: StateFileReader,
): EventsPart {
  const read = readFile(join(directory, "events"));
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
  const eventProblem = invalidEventReason(parsed.records, declaredEffects);
  if (eventProblem !== undefined) return failedEvents(read.bytes, eventProblem);
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

function verifyClosureRevision(
  directory: string,
  eventsBytes: Uint8Array | undefined,
  revision: string | null,
  recorded: string | null,
  readFile: StateFileReader,
): {
  readonly matches: boolean | null;
  readonly problem: string | undefined;
} {
  if (revision === null || recorded === null)
    return { matches: null, problem: undefined };
  if (recorded === revision) return { matches: true, problem: undefined };
  const afterEvents = readFile(join(directory, "events"));
  const changed =
    eventsBytes === undefined ||
    afterEvents.kind !== "read" ||
    !sameBytes(eventsBytes, afterEvents.bytes);
  if (changed)
    return {
      matches: null,
      problem:
        "case changed during inspection (events updated while reading closure)",
    };
  return {
    matches: false,
    problem: "closure journalRevision does not match intent+events",
  };
}

function readClosurePart(
  directory: string,
  operationId: string,
  eventsBytes: Uint8Array | undefined,
  revision: string | null,
  readFile: StateFileReader,
) {
  const read = readFile(join(directory, "closure"));
  if (read.kind === "missing")
    return { closure: emptyClosure("absent"), problem: undefined };
  if (read.kind === "unreadable")
    return {
      closure: emptyClosure("unreadable"),
      problem: `closure unreadable: ${read.reason}`,
    };
  const payload = singleC3s1Record(read.bytes, "closure");
  if (!validClosurePayload(payload, operationId) || payload === undefined)
    return {
      closure: emptyClosure("damaged"),
      problem: "closure record is damaged",
    };
  const checked = verifyClosureRevision(
    directory,
    eventsBytes,
    revision,
    textField(payload.journalRevision),
    readFile,
  );
  return {
    closure: {
      state: "valid" as const,
      disposition: textField(payload.disposition),
      qualification: textField(payload.qualification),
      journalRevisionMatches: checked.matches,
    },
    problem: checked.problem,
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
  const firstFinal = eventKinds.find(
    (kind) => kind === "completion" || kind === "not-applied",
  );
  if (firstFinal === "completion") return "completed";
  if (firstFinal === "not-applied") return "not-applied";
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
  readFile: StateFileReader,
): StateCaseReport {
  const leaseStat = lstatSafe(join(directory, "owner.lease"));
  const intent = readIntentPart(directory, operationId, readFile);
  const declaredEffects =
    intent.payload === undefined
      ? undefined
      : stringList(intent.payload.effects);
  const events = readEventsPart(directory, declaredEffects, readFile);
  const revision =
    intent.bytes !== undefined && events.bytes !== undefined
      ? journalRevisionOf(intent.bytes, events.bytes)
      : null;
  const closed = readClosurePart(
    directory,
    operationId,
    events.bytes,
    revision,
    readFile,
  );
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
    leaseFilePresent: leaseStat.kind === "ok",
    eventKinds: events.eventKinds,
    delegateBoots: events.delegateBoots,
    tornTail: events.tornTail,
    tornOffset: events.tornOffset,
    recordHiddenInTornTail: events.recordHiddenInTornTail,
    closure: closed.closure,
    revision,
    nextAction: status === "unresolved" ? unresolvedNextAction : null,
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
  readonly modeProblem: string | undefined;
} {
  const dirPath = join(root, name);
  if (lstatSafe(dirPath).kind === "missing")
    return {
      names: [],
      total: 0,
      truncated: false,
      problem: `${name}/ directory is missing`,
      modeProblem: undefined,
    };
  const listed = openListedDirectory(`${name}/`, dirPath);
  if (!listed.ok)
    return {
      names: [],
      total: 0,
      truncated: false,
      problem: `${name}/ unreadable: ${listed.reason}`,
      modeProblem: undefined,
    };
  return {
    names: [...listed.names],
    total: listed.total,
    truncated: listed.truncated,
    problem: undefined,
    modeProblem: privateModeOk(listed.stats)
      ? undefined
      : `${name}/ permissions/ownership failed private check (${formatMode(listed.stats)})`,
  };
}

function scanCaseEntry(
  folder: "operations" | "settled",
  dirPath: string,
  name: string,
  readFile: StateFileReader,
): {
  readonly report: StateCaseReport | undefined;
  readonly problems: readonly string[];
} {
  if (!operationPattern.test(name))
    return {
      report: undefined,
      problems: [`${folder}/ contains unexpected entry ${name}`],
    };
  const caseDir = join(dirPath, name);
  const openedCase = openRealDirectory(`${folder}/${name}`, caseDir);
  if (!openedCase.ok)
    return {
      report: undefined,
      problems: [`${folder}/${name}: ${openedCase.reason}`],
    };
  const report = inspectStateCase(folder, caseDir, name, readFile);
  return {
    report,
    problems: report.problems.map((issue) => `${folder}/${name}: ${issue}`),
  };
}

function scanCaseBucket(
  root: string,
  folder: "operations" | "settled",
  required: boolean,
  readFile: StateFileReader,
): {
  readonly cases: readonly StateCaseReport[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
} {
  const dirPath = join(root, folder);
  if (lstatSafe(dirPath).kind === "missing")
    return {
      cases: [],
      truncated: false,
      problems: required ? [`${folder}/ directory is missing`] : [],
    };
  const listed = openListedDirectory(`${folder}/`, dirPath);
  if (!listed.ok)
    return {
      cases: [],
      truncated: false,
      problems: [`${folder}/ unreadable: ${listed.reason}`],
    };
  const entries = listed.names.map((name) =>
    scanCaseEntry(folder, dirPath, name, readFile),
  );
  const modeProblem = !privateModeOk(listed.stats)
    ? [
        `${folder}/ permissions/ownership failed private check (${formatMode(listed.stats)})`,
      ]
    : [];
  return {
    cases: entries.flatMap((entry) =>
      entry.report === undefined ? [] : [entry.report],
    ),
    truncated: listed.truncated,
    problems: [...modeProblem, ...entries.flatMap((entry) => entry.problems)],
  };
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
  readonly nextAction: string | null;
  readonly problems: readonly string[];
};

function optionalProblem(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
}

function stagingProblems(
  staging: ReturnType<typeof listSubdir>,
): readonly string[] {
  if (staging.problem !== undefined) return [staging.problem];
  const leftover =
    staging.names.length > 0
      ? [
          `staging/ holds ${String(staging.total)} leftover entr${staging.total === 1 ? "y" : "ies"}`,
        ]
      : [];
  return [...leftover, ...optionalProblem(staging.modeProblem)];
}

function collectRootProblems(
  rootStats: Stats,
  rootMode: string,
  fmt: ReturnType<typeof readFormatJournal>,
  coord: ReturnType<typeof listSubdir>,
  staging: ReturnType<typeof listSubdir>,
  ops: ReturnType<typeof scanCaseBucket>,
  settled: ReturnType<typeof scanCaseBucket>,
  truncated: boolean,
): readonly string[] {
  return [
    ...(privateModeOk(rootStats)
      ? []
      : [
          `state root permissions/ownership failed private check (${rootMode})`,
        ]),
    ...optionalProblem(fmt.problem),
    ...optionalProblem(coord.problem),
    ...optionalProblem(coord.modeProblem),
    ...stagingProblems(staging),
    ...ops.problems,
    ...settled.problems,
    ...(truncated
      ? ["state journal listing was truncated at forensics limits"]
      : []),
  ];
}

export function inspectStateRoot(
  root: string,
  readFile: typeof readBytesNoFollow = readBytesNoFollow,
):
  | { readonly ok: true; readonly report: StateForensicsReport }
  | { readonly ok: false; readonly reason: string } {
  const opened = openListedDirectory("State root", root);
  if (!opened.ok) return opened;
  const rootMode = formatMode(opened.stats);
  const fmt = readFormatJournal(root);
  const coord = listSubdir(root, "coordination");
  const staging = listSubdir(root, "staging");
  const ops = scanCaseBucket(root, "operations", true, readFile);
  const settled = scanCaseBucket(
    root,
    "settled",
    fmt.journal === "contract3.state.2",
    readFile,
  );
  const truncated =
    coord.truncated || staging.truncated || ops.truncated || settled.truncated;
  const problems = collectRootProblems(
    opened.stats,
    rootMode,
    fmt,
    coord,
    staging,
    ops,
    settled,
    truncated,
  );
  const cases = [...ops.cases, ...settled.cases];
  const unresolved = cases.filter(
    (entry) => entry.status === "unresolved",
  ).length;
  const corrupt = cases.filter((entry) => entry.status === "corrupt").length;
  const nextAction = unresolved > 0 ? unresolvedNextAction : null;
  const summaryBase = `State journal ${fmt.journal ?? "unknown"}: ${String(cases.length)} cases (${String(unresolved)} unresolved, ${String(corrupt)} corrupt), ${String(staging.names.length)} staged, ${String(problems.length)} problems.`;
  return {
    ok: true,
    report: {
      schema: forensicsSchema,
      target: "state",
      path: root,
      status: problems.length === 0 && unresolved === 0 ? "clean" : "issues",
      summary:
        nextAction === null
          ? summaryBase
          : `${summaryBase} Next: ${nextAction}`,
      rootMode,
      journal: fmt.journal,
      coordinationLocks: coord.names,
      stagingEntries: staging.names,
      cases,
      truncated,
      nextAction,
      problems,
    },
  };
}
