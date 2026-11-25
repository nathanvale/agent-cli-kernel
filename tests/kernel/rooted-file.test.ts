import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readRootedFile } from "../../kernel/src/shared/rooted-file.ts";
import { ownedFolders } from "../support/fixture-files.ts";

const folder = ownedFolders();
const limitBytes = 1024;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("readRootedFile", () => {
  test("refuses every link and escape class member with its full Repair message", () => {
    const base = folder("rooted-file-class-");
    const root = join(base, "root");
    const realBase = realpathSync.native(base);
    const realRoot = join(realBase, "root");
    const outsideDir = join(base, "outside");
    const outsideFile = join(outsideDir, "secret.txt");
    mkdirSync(root, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsideFile, "secret");

    const fileLink = join(root, "file-link.txt");
    symlinkSync(outsideFile, fileLink);

    const danglingLink = join(root, "dangling.txt");
    symlinkSync(join(outsideDir, "missing.txt"), danglingLink);

    const hardLink = join(root, "hard-link.txt");
    linkSync(outsideFile, hardLink);

    const linkedDir = join(root, "linked");
    symlinkSync(outsideDir, linkedDir);

    const cases = [
      {
        name: "symbolic-link to outside file",
        path: "file-link.txt",
        reason: "symbolic-link",
        message: `file-link.txt is a symbolic link. Repair: replace the link with a regular file inside ${realRoot}.`,
      },
      {
        name: "dangling symbolic-link",
        path: "dangling.txt",
        reason: "symbolic-link",
        message: `dangling.txt is a symbolic link. Repair: replace the link with a regular file inside ${realRoot}.`,
      },
      {
        name: "hard-link",
        path: "hard-link.txt",
        reason: "hard-link",
        message:
          "hard-link.txt is a hard link (link count 2). Repair: replace it with a copy, or remove the other link.",
      },
      {
        name: "linked-folder",
        path: "linked/secret.txt",
        reason: "linked-folder",
        message: `linked/secret.txt crosses linked folder ${join(realRoot, "linked")}. Repair: replace the symbolic link with a real folder inside ${realRoot}.`,
      },
      {
        name: "relative outside-root escape",
        path: "../outside/secret.txt",
        reason: "outside-root",
        message: `../outside/secret.txt is outside root ${realRoot}. Repair: pass a path inside ${realRoot}.`,
      },
      {
        name: "absolute outside-root path",
        path: outsideFile,
        reason: "outside-root",
        message: `${outsideFile} is outside root ${realRoot}. Repair: pass a path inside ${realRoot}.`,
      },
    ] as const;

    for (const row of cases) {
      expect(readRootedFile(root, row.path, limitBytes)).toEqual({
        kind: "refused",
        path: row.path,
        reason: row.reason,
        message: row.message,
      });
    }
  });

  test("admits honest controls: plain file, nested plain file, and root given through a linked path", () => {
    const base = folder("rooted-file-honest-");
    const realRoot = join(base, "real-root");
    const nestedDir = join(realRoot, "nested", "deep");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(realRoot, "plain.txt"), "plain-body");
    writeFileSync(join(nestedDir, "leaf.txt"), "nested-body");

    const linkedRoot = join(base, "linked-root");
    symlinkSync(realRoot, linkedRoot);

    const plain = readRootedFile(realRoot, "plain.txt", limitBytes);
    expect(plain.kind).toBe("read");
    if (plain.kind === "read") {
      expect(text(plain.bytes)).toBe("plain-body");
      expect(plain.facts.size).toBe(10);
    }

    const nested = readRootedFile(realRoot, "nested/deep/leaf.txt", limitBytes);
    expect(nested.kind).toBe("read");
    if (nested.kind === "read") expect(text(nested.bytes)).toBe("nested-body");

    const viaLinkedRootRelative = readRootedFile(
      linkedRoot,
      "plain.txt",
      limitBytes,
    );
    expect(viaLinkedRootRelative.kind).toBe("read");
    if (viaLinkedRootRelative.kind === "read")
      expect(text(viaLinkedRootRelative.bytes)).toBe("plain-body");

    const viaLinkedRootAbsolute = readRootedFile(
      linkedRoot,
      join(linkedRoot, "nested/deep/leaf.txt"),
      limitBytes,
    );
    expect(viaLinkedRootAbsolute.kind).toBe("read");
    if (viaLinkedRootAbsolute.kind === "read")
      expect(text(viaLinkedRootAbsolute.bytes)).toBe("nested-body");
  });

  test("refuses directories, FIFOs, and files over the byte limit with full Repair messages", () => {
    const base = folder("rooted-file-bounds-");
    const root = join(base, "root");
    const realRoot = join(realpathSync.native(base), "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "big.txt"), "x".repeat(limitBytes + 1));

    expect(readRootedFile(root, "sub", limitBytes)).toEqual({
      kind: "refused",
      path: "sub",
      reason: "not-regular",
      message: `sub is not a regular file. Repair: replace it with a regular file inside ${realRoot}.`,
    });

    expect(readRootedFile(root, "big.txt", limitBytes)).toEqual({
      kind: "refused",
      path: "big.txt",
      reason: "over-limit",
      message: `big.txt is ${String(limitBytes + 1)} bytes, above the ${String(limitBytes)} byte limit. Repair: reduce the file size to at most ${String(limitBytes)} bytes.`,
    });
  });

  test("returns missing for absent files and folders, and rethrows non-ENOENT errors", () => {
    const base = folder("rooted-file-errors-");
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    expect(readRootedFile(root, "absent.txt", limitBytes)).toEqual({
      kind: "missing",
    });
    expect(readRootedFile(root, "no-dir/absent.txt", limitBytes)).toEqual({
      kind: "missing",
    });
    expect(
      readRootedFile(join(base, "no-root"), "absent.txt", limitBytes),
    ).toEqual({
      kind: "missing",
    });

    if (process.getuid?.() !== 0) {
      const locked = join(root, "locked.txt");
      writeFileSync(locked, "nope");
      chmodSync(locked, 0o000);
      try {
        expect(() => readRootedFile(root, "locked.txt", limitBytes)).toThrow(
          /EACCES|Permission denied/,
        );
      } finally {
        chmodSync(locked, 0o600);
      }
    }
  });
});
