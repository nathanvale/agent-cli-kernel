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
        Object.keys(value).every((key) => key in table.fields) &&
        Object.entries(table.fields).every(
          ([key, field]) => !field.required || key in value,
        )
      );
    },
    meaning(version: string, key: string): string | undefined {
      if (this.classify(version) !== "accepted") return undefined;
      return admitted[Number(version.split(".")[1])]?.fields[key]?.meaning;
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
    const candidate = newer.fields[key];
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
    if (!(key in older.fields) && field.required)
      throw new Error("A new minor field must be optional.");
}
