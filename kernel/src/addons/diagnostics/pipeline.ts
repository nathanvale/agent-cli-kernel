import type { LogRecord } from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";
import type { DiagnosticsLevel } from "../../kernel/index.ts";
import { limits } from "./limits.ts";
import { markers } from "./records.ts";

export type SelfReport = "redaction-limit" | "redaction-failed";

export type RunPipeline = (
  level: DiagnosticsLevel,
  properties: Readonly<Record<string, unknown>>,
) => void;

const unmapped = Object.freeze({});

// Platform: LogTape 2.4.2 reports a redaction limit only to its process-wide
// meta logger. It also replaces a message placeholder that names no property
// when, and only when, a limit was exceeded, so the run reads that replacement
// as its own report.
function exceededRedactionLimit(record: LogRecord): boolean {
  return record.message[3] !== unmapped;
}

// Interface: One run's own chain: a LogTape record, LogTape field redaction,
// then the run's sink. It never calls LogTape's configure, so it neither reads
// nor changes the process-wide configuration, and no other run or logger in
// the process shares it. Trouble inside the chain becomes a self report.
export function runPipeline(
  category: readonly string[],
  deliver: (record: LogRecord) => void,
  report: (cause: SelfReport) => void,
): RunPipeline {
  const redacting = redactByField(
    (record: LogRecord) => {
      if (exceededRedactionLimit(record)) report("redaction-limit");
      deliver(record);
    },
    {
      fieldPatterns: DEFAULT_REDACT_FIELDS,
      action: () => markers.redacted,
      maxDepth: limits.redactionDepth,
      maxProperties: limits.redactionEntries,
    },
  );
  return (level, properties) => {
    try {
      redacting({
        category,
        level,
        timestamp: Date.now(),
        rawMessage: "{event}{unmapped}",
        message: ["", properties["event"], "", unmapped, ""],
        properties: { ...properties },
      });
    } catch {
      report("redaction-failed");
    }
  };
}
