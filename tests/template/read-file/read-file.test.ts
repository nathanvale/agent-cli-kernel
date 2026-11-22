import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { folderFiles } from "../../../scripts/planted-fault-folders.ts";
import { patchText } from "../../../scripts/planted-fault-patch.ts";
import {
  errorCode,
  isAbsentError,
  isMissingDirectoryError,
  readOptionalDirectory,
  readOptionalUtf8,
} from "../../../scripts/read-file.ts";
import { testFolder } from "../../support/test-folder.ts";

class InheritedCode {
  declare code: string;
}
InheritedCode.prototype.code = "ENOENT";

const folders: string[] = [];

function scratch(): string {
  const dir = testFolder("read-file-");
  folders.push(dir);
  return dir;
}

function expectThrownCode(run: () => unknown, expected: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(errorCode(caught)).toBe(expected);
}

function withLockedPath(
  path: string,
  restoreMode: number,
  check: () => void,
): void {
  chmodSync(path, 0o000);
  try {
    check();
  } finally {
    chmodSync(path, restoreMode);
  }
}

afterEach(() => {
  while (folders.length > 0) {
    const dir = folders.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

test("errorCode reads own string codes and absence predicates accept only ENOENT and ENOTDIR for files and ENOENT for directories", () => {
  expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
  expect(errorCode(new InheritedCode())).toBeUndefined();
  expect(errorCode({ code: 42 })).toBeUndefined();
  expect(errorCode(null)).toBeUndefined();
  expect(errorCode("ENOENT")).toBeUndefined();

  expect(isAbsentError({ code: "ENOENT" })).toBe(true);
  expect(isAbsentError({ code: "ENOTDIR" })).toBe(true);
  expect(isAbsentError(new InheritedCode())).toBe(false);
  expect(isAbsentError({ code: "EISDIR" })).toBe(false);
  expect(isAbsentError({ code: "EACCES" })).toBe(false);
  expect(isAbsentError(new Error("boom"))).toBe(false);

  expect(isMissingDirectoryError({ code: "ENOENT" })).toBe(true);
  expect(isMissingDirectoryError(new InheritedCode())).toBe(false);
  expect(isMissingDirectoryError({ code: "ENOTDIR" })).toBe(false);
  expect(isMissingDirectoryError({ code: "EACCES" })).toBe(false);
});

test("readOptionalUtf8 returns undefined only on absence and rethrows EISDIR", () => {
  const dir = scratch();
  const present = join(dir, "present.txt");
  const missing = join(dir, "missing.txt");
  const throughFile = join(present, "child.txt");
  const subfolder = join(dir, "subfolder");
  writeFileSync(present, "hello\n");
  mkdirSync(subfolder);

  expect(readOptionalUtf8(present)).toBe("hello\n");
  expect(readOptionalUtf8(missing)).toBeUndefined();
  expect(readOptionalUtf8(throughFile)).toBeUndefined();
  expectThrownCode(() => readOptionalUtf8(subfolder), "EISDIR");
});

test.skipIf(process.getuid?.() === 0)(
  "readOptionalUtf8 rethrows EACCES on an unreadable file",
  () => {
    const dir = scratch();
    const locked = join(dir, "locked.txt");
    writeFileSync(locked, "secret");
    withLockedPath(locked, 0o600, () => {
      expectThrownCode(() => readOptionalUtf8(locked), "EACCES");
    });
  },
);

test("readOptionalDirectory returns undefined only on ENOENT and rethrows ENOTDIR", () => {
  const dir = scratch();
  const folder = join(dir, "items");
  const file = join(dir, "plain.txt");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.json"), "{}");
  writeFileSync(file, "not a folder");

  expect(readOptionalDirectory(join(dir, "missing"))).toBeUndefined();
  expect(readOptionalDirectory(folder)?.map((entry) => entry.name)).toEqual([
    "a.json",
  ]);
  expectThrownCode(() => readOptionalDirectory(file), "ENOTDIR");
});

test.skipIf(process.getuid?.() === 0)(
  "readOptionalDirectory rethrows EACCES on an unreadable directory",
  () => {
    const dir = scratch();
    const lockedDir = join(dir, "locked-dir");
    mkdirSync(lockedDir);
    withLockedPath(lockedDir, 0o700, () => {
      expectThrownCode(() => readOptionalDirectory(lockedDir), "EACCES");
    });
  },
);

test("folderFiles refuses a regular file or symlink loop instead of reading it as empty", () => {
  const dir = scratch();
  writeFileSync(join(dir, "records"), "not a folder");
  expectThrownCode(
    () => folderFiles(dir, "records", "fault record"),
    "ENOTDIR",
  );

  const loopA = join(dir, "loop-a");
  const loopB = join(dir, "loop-b");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);
  expectThrownCode(() => folderFiles(dir, "loop-a", "fault record"), "ELOOP");
});

test("patchText refuses a directory or symlink loop instead of reporting a missing patch", () => {
  const dir = scratch();
  mkdirSync(join(dir, "as-folder.patch"));
  expectThrownCode(
    () => patchText(dir, { id: "demo", patch: "as-folder.patch" }),
    "EISDIR",
  );

  const loopA = join(dir, "loop-a.patch");
  const loopB = join(dir, "loop-b.patch");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);
  expectThrownCode(
    () => patchText(dir, { id: "demo", patch: "loop-a.patch" }),
    "ELOOP",
  );
});
