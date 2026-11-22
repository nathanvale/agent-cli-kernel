import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { idOrder } from "./planted-fault-patch.ts";
import { readOptionalDirectory } from "./read-file.ts";

export type RecordEntry = { readonly file: string; readonly entry: unknown };

export type FolderFile = {
  readonly file: string;
  readonly id: string;
  readonly text: string;
};

const fileExtension = ".json";
const systemNoise = ".DS_Store";

export function folderFiles(
  root: string,
  folder: string,
  kind: string,
): FolderFile[] {
  const list = `${folder}${fileExtension}`;
  if (existsSync(join(root, list)))
    throw new Error(
      `${list} is the old single list of each ${kind}, which nothing reads any more. Repair: move each entry in it to its own file, ${folder}/<id>${fileExtension}, then delete ${list}.`,
    );
  const entries = readOptionalDirectory(join(root, folder));
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.name !== systemNoise)
    .map((entry) => {
      const file = `${folder}/${entry.name}`;
      const notOne = () =>
        new Error(
          `${file} is not a ${kind} file. Repair: keep each ${kind} as a plain file named <id>${fileExtension}, with no leading dot, and nothing else in ${folder}.`,
        );
      if (!entry.isFile()) throw notOne();
      if (entry.name.startsWith(".")) throw notOne();
      if (!entry.name.endsWith(fileExtension)) throw notOne();
      return {
        file,
        id: entry.name.slice(0, -fileExtension.length),
        text: readFileSync(join(root, file), "utf8"),
      };
    })
    .toSorted((left, right) => idOrder(left.id, right.id));
}

function parsedEntry(where: string, stem: string, text: string): RecordEntry {
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${where} is not one JSON fault record: ${error instanceof Error ? error.message : String(error)}. Repair: write one JSON object with the five record fields.`,
      { cause: error },
    );
  }
  const id = new Map<string, unknown>(
    typeof entry === "object" && entry !== null ? Object.entries(entry) : [],
  ).get("id");
  if (typeof id === "string" && id !== "" && id !== stem)
    throw new Error(
      `${where} holds the record ${id}. Repair: rename the file ${id}${fileExtension}, or correct its id.`,
    );
  return { file: where, entry };
}

export function recordFiles(root: string, folder: string): RecordEntry[] {
  return folderFiles(root, folder, "fault record").map(({ file, id, text }) =>
    parsedEntry(file, id, text),
  );
}
