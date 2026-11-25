import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readRootedFile } from "../../kernel/src/shared/rooted-file.ts";
import { ownedFolders } from "../support/fixture-files.ts";
import { spawnBounded } from "./kernel-repair/swarm-process.ts";

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

    const physicalRoot = realpathSync.native(realRoot);
    const overlappingAlias = join(physicalRoot, "alias");
    symlinkSync(".", overlappingAlias);
    const viaOverlappingAliasAbsolute = readRootedFile(
      overlappingAlias,
      join(overlappingAlias, "plain.txt"),
      limitBytes,
    );
    expect(viaOverlappingAliasAbsolute.kind).toBe("read");
    if (viaOverlappingAliasAbsolute.kind === "read")
      expect(text(viaOverlappingAliasAbsolute.bytes)).toBe("plain-body");
  });

  test("resolves a root containing a symbolic link followed by .. to its physical folder", () => {
    const base = folder("rooted-file-physical-root-");
    const topRoot = join(base, "top", "root");
    const deep = join(topRoot, "deep");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(topRoot, "f.txt"), "IN_ROOT");
    writeFileSync(join(base, "f.txt"), "OUTSIDE");

    const alias = join(base, "alias");
    symlinkSync(deep, alias);

    const physicalViaDotDot = readRootedFile(
      `${alias}/..`,
      "f.txt",
      limitBytes,
    );
    expect(physicalViaDotDot.kind).toBe("read");
    if (physicalViaDotDot.kind === "read")
      expect(text(physicalViaDotDot.bytes)).toBe("IN_ROOT");
  });

  test("refuses directories and FIFOs as not-regular with full Repair messages", async () => {
    const base = folder("rooted-file-not-regular-");
    const root = join(base, "root");
    const realRoot = join(realpathSync.native(base), "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    const fifoPath = join(root, "pipe");
    const madeFifo = await spawnBounded(["mkfifo", fifoPath], {
      boundMilliseconds: 3_000,
    });
    expect(madeFifo.exit).toBe(0);

    expect(readRootedFile(root, "sub", limitBytes)).toEqual({
      kind: "refused",
      path: "sub",
      reason: "not-regular",
      message: `sub is not a regular file. Repair: replace it with a regular file inside ${realRoot}.`,
    });

    expect(readRootedFile(root, "pipe", limitBytes)).toEqual({
      kind: "refused",
      path: "pipe",
      reason: "not-regular",
      message: `pipe is not a regular file. Repair: replace it with a regular file inside ${realRoot}.`,
    });
  }, 10_000);

  test("refuses a file over the byte limit before reading with its full Repair message", () => {
    const base = folder("rooted-file-size-limit-");
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "exact.txt"), "x".repeat(limitBytes));
    writeFileSync(join(root, "big.txt"), "x".repeat(limitBytes + 1));

    const exact = readRootedFile(root, "exact.txt", limitBytes);
    expect(exact.kind).toBe("read");
    if (exact.kind === "read") {
      expect(exact.bytes.byteLength).toBe(limitBytes);
      expect(exact.facts.size).toBe(limitBytes);
    }

    expect(readRootedFile(root, "big.txt", limitBytes)).toEqual({
      kind: "refused",
      path: "big.txt",
      reason: "over-limit",
      message: `big.txt is ${String(limitBytes + 1)} bytes, above the ${String(limitBytes)} byte limit. Repair: reduce the file size to at most ${String(limitBytes)} bytes.`,
    });
  });

  test("refuses a file that grows past the byte limit after open with its full Repair message", () => {
    const base = folder("rooted-file-growth-limit-");
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    const growing = join(root, "growing.txt");
    writeFileSync(growing, "x".repeat(limitBytes));

    expect(
      readRootedFile(root, "growing.txt", limitBytes, {
        afterOpen: () => {
          appendFileSync(growing, "y");
        },
      }),
    ).toEqual({
      kind: "refused",
      path: "growing.txt",
      reason: "over-limit",
      message: `growing.txt exceeded the ${String(limitBytes)} byte limit while reading. Repair: reduce the file size to at most ${String(limitBytes)} bytes.`,
    });
  });

  test("refuses a file replaced between open and verification with its full Repair message", () => {
    const base = folder("rooted-file-swap-file-");
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    const target = join(root, "target.txt");
    const replacement = join(root, "replacement.txt");
    writeFileSync(target, "original");
    writeFileSync(replacement, "swapped");

    expect(
      readRootedFile(root, "target.txt", limitBytes, {
        afterOpen: () => {
          renameSync(replacement, target);
        },
      }),
    ).toEqual({
      kind: "refused",
      path: "target.txt",
      reason: "outside-root",
      message:
        "target.txt changed between open and verification. Repair: retry once nothing is replacing the path.",
    });
  });

  test("refuses a parent folder replaced with a symbolic link between open and verification with its full Repair message", () => {
    const base = folder("rooted-file-swap-parent-");
    const root = join(base, "root");
    const realBase = realpathSync.native(base);
    const realRoot = join(realBase, "root");
    const sub = join(realRoot, "sub");
    const movedSub = join(realBase, "moved-sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "target.txt"), "original");

    expect(
      readRootedFile(root, "sub/target.txt", limitBytes, {
        afterOpen: () => {
          renameSync(sub, movedSub);
          symlinkSync(movedSub, sub);
        },
      }),
    ).toEqual({
      kind: "refused",
      path: "sub/target.txt",
      reason: "linked-folder",
      message: `sub/target.txt parent folder ${sub} changed to a symbolic link. Repair: replace the symbolic link with a real folder inside ${realRoot}.`,
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
