import {
  readRootedFile as readRootedFileWithSeam,
  type RootedFacts,
  type RootedFileResult,
  type RootedRefusal,
} from "./rooted-file.ts";

export type { RootedFacts, RootedFileResult, RootedRefusal };

export function readRootedFile(
  root: string,
  path: string,
  limitBytes: number,
): RootedFileResult {
  return readRootedFileWithSeam(root, path, limitBytes);
}
