export type VersionClassification =
  | "malformed"
  | "other-major"
  | "newer-minor"
  | "accepted";
export function classifyVersion(value: unknown): VersionClassification {
  if (typeof value !== "string") return "malformed";
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!match) return "malformed";
  if (match[1] !== "3") return "other-major";
  if (match[3] !== "0") return "malformed";
  return match[2] === "0" ? "accepted" : "newer-minor";
}
