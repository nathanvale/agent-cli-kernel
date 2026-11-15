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

export type MinorFields = {
  readonly minor: number;
  readonly fields: Readonly<
    Record<string, { readonly required: boolean; readonly meaning: string }>
  >;
  readonly commonCauses: readonly string[];
};
// Field names are own keys only: an inherited name such as toString is never a
// declared field, in a table or in a payload from another CLI (F07, F08).
export function versionReader(tables: readonly MinorFields[]) {
  if (
    tables.length === 0 ||
    tables.some((table, index) => table.minor !== index)
  )
    throw new Error("Reader must retain contiguous minor tables from zero.");
  for (let index = 1; index < tables.length; index++) {
    const older = tables[index - 1];
    const newer = tables[index];
    if (!older || !newer) throw new Error("Missing minor table.");
    compatibleMinor(older, newer);
  }
  const admitted = structuredClone(tables);
  return {
    classify(value: unknown): VersionClassification {
      const base = classifyVersion(value);
      if (base !== "newer-minor" || typeof value !== "string") return base;
      const minor = Number(value.split(".")[1]);
      return minor < admitted.length ? "accepted" : "newer-minor";
    },
    fields(version: string, value: Readonly<Record<string, unknown>>): boolean {
      if (this.classify(version) !== "accepted") return false;
      const table = admitted[Number(version.split(".")[1])];
      return (
        table !== undefined &&
        Object.keys(value).every((key) => Object.hasOwn(table.fields, key)) &&
        Object.entries(table.fields).every(
          ([key, field]) => !field.required || Object.hasOwn(value, key),
        )
      );
    },
    meaning(version: string, key: string): string | undefined {
      if (this.classify(version) !== "accepted") return undefined;
      const fields = admitted[Number(version.split(".")[1])]?.fields;
      return fields && Object.hasOwn(fields, key)
        ? fields[key]?.meaning
        : undefined;
    },
  };
}

function compatibleMinor(older: MinorFields, newer: MinorFields): void {
  if (
    JSON.stringify([...older.commonCauses].sort()) !==
    JSON.stringify([...newer.commonCauses].sort())
  )
    throw new Error("Common causes change only with a major.");
  for (const [key, field] of Object.entries(older.fields)) {
    const candidate = Object.hasOwn(newer.fields, key)
      ? newer.fields[key]
      : undefined;
    if (
      !candidate ||
      candidate.meaning !== field.meaning ||
      candidate.required !== field.required
    )
      throw new Error(
        "A minor cannot remove, rename, require or reinterpret a field.",
      );
  }
  for (const [key, field] of Object.entries(newer.fields))
    if (!Object.hasOwn(older.fields, key) && field.required)
      throw new Error("A new minor field must be optional.");
}
