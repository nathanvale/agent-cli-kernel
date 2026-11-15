import type { DiagnosticFacts, Diagnostics } from "../types.ts";
import { integer, keys, record } from "./primitives.ts";
const fields = [
  "file",
  "sinkFailure",
  "droppedRecords",
  "unflushedRecords",
  "truncatedRecords",
  "countsComplete",
  "closed",
];
function fact(name: string, value: unknown): boolean {
  switch (name) {
    case "file":
      return (
        value === null ||
        (typeof value === "string" &&
          value.startsWith("/") &&
          value.trim().length > 1 &&
          !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
      );
    case "sinkFailure":
      return (
        value === null ||
        value === "capacity" ||
        value === "setup" ||
        value === "write" ||
        value === "flush-timeout" ||
        value === "close"
      );
    case "droppedRecords":
    case "unflushedRecords":
    case "truncatedRecords":
      return integer(value);
    case "countsComplete":
    case "closed":
      return typeof value === "boolean";
    default:
      return false;
  }
}
function facts(
  value: unknown,
  complete: boolean,
): value is Partial<DiagnosticFacts> {
  if (
    !record(value) ||
    !keys(value, complete ? fields : [], complete ? [] : fields)
  )
    return false;
  if (!Object.entries(value).every(([name, entry]) => fact(name, entry)))
    return false;
  return value.sinkFailure !== "flush-timeout" || value.closed !== true;
}
export function diagnostics(value: unknown): value is Diagnostics {
  if (!record(value)) return false;
  if (value.status === "unavailable")
    return (
      keys(value, ["status", "reason", "trusted"]) &&
      (value.reason === "status-invalid" ||
        value.reason === "status-unavailable") &&
      facts(value.trusted, false)
    );
  if (value.status !== "available" || !keys(value, ["status", ...fields]))
    return false;
  const { status: _status, ...accounting } = value;
  void _status;
  return facts(accounting, true);
}
