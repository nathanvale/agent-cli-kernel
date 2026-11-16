import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { errorCode } from "./io.ts";
import { limits } from "./limits.ts";
import type { DiagnosticsIo } from "./io.ts";

// DIAG-7 to DIAG-11. Location, private exclusive creation, the shared
// allocation lock, pruning and closure confirmation. Everything here is
// synchronous except the bounded wait for the allocation lock.

// A CLI name or run identity used as one path segment: never ".", ".." or a
// separator.
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const lockName = ".allocation-lock";
const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const ownerPattern = /^owner-([1-9][0-9]{0,9})-([0-9a-f]{16})$/;
const residuePattern =
  /^\.allocation-lock\.(?:pending|retiring)-([1-9][0-9]{0,9})-([0-9a-f]{16})-[0-9a-f]{16}$/;
const markerPattern = /^(.+)\.closed-([0-9]+)-([0-9]+)-([0-9]+)$/;
const uid = process.getuid?.() ?? -1;

export type Place = {
  readonly directory: string;
  readonly dev: number;
  readonly ino: number;
};
export type Opened = {
  readonly descriptor: number;
  readonly file: string;
  readonly dev: number;
  readonly ino: number;
};
export type Allocation = Opened | "setup" | "capacity" | "abandoned";

// $XDG_STATE_HOME/<cli>/diagnostics when XDG_STATE_HOME is absolute, else
// $HOME/.local/state/<cli>/diagnostics. Nothing else moves it (DIAG-7).
export function locate(
  environment: Readonly<Record<string, string | undefined>>,
  cli: string,
): string | undefined {
  if (!segment.test(cli)) return undefined;
  const xdg = environment.XDG_STATE_HOME;
  const home = environment.HOME;
  const base =
    xdg && isAbsolute(xdg)
      ? xdg
      : home && isAbsolute(home)
        ? join(home, ".local", "state")
        : undefined;
  return base === undefined
    ? undefined
    : join(normalize(base), cli, "diagnostics");
}

function lookup(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

// Owned by this user or root, and writable by no one else unless it is a
// root-owned sticky directory such as /tmp.
function trustedAncestor(info: Stats): boolean {
  return (
    info.isDirectory() &&
    (info.uid === uid || info.uid === 0) &&
    ((info.mode & 0o022) === 0 ||
      (info.uid === 0 && (info.mode & 0o1000) !== 0))
  );
}

function ownPrivate(info: Stats | undefined): boolean {
  return (
    info !== undefined &&
    info.isDirectory() &&
    info.uid === uid &&
    (info.mode & 0o7777) === 0o700
  );
}

// Creates one private directory. Runs started together race to create the
// same tree: a loser's EEXIST is not a failure, and the caller's lstat checks
// then judge whatever is there (owner, kind and exact mode), as for any
// existing directory.
function createPrivate(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  chmodSync(path, 0o700);
}

function trustedChain(real: string): boolean {
  let current = real;
  for (;;) {
    const info = lookup(current);
    if (!info || !trustedAncestor(info)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

// The state root may be reached through the user's own symlinks; it is
// resolved and every real ancestor must be trusted. Below it, `<cli>` and
// `diagnostics` are never followed through a symlink.
function prepareBase(base: string): string | undefined {
  const missing: string[] = [];
  let existing = base;
  while (!lookup(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    missing.unshift(existing.slice(parent.length).replace(/^\/+/, ""));
    existing = parent;
  }
  let real = realpathSync(existing);
  if (!trustedChain(real)) return undefined;
  for (const name of missing) {
    real = join(real, name);
    createPrivate(real);
    const info = lookup(real);
    if (!info || !trustedAncestor(info) || info.uid !== uid) return undefined;
  }
  return real;
}

// DIAG-7, DIAG-8: a private 0700 directory owned by this user. A wider
// existing directory is refused, never written into.
export function prepare(directory: string): Place | undefined {
  try {
    const cliDirectory = dirname(directory);
    const base = prepareBase(dirname(cliDirectory));
    if (base === undefined) return undefined;
    const cli = join(base, cliDirectory.slice(dirname(cliDirectory).length));
    if (!lookup(cli)) createPrivate(cli);
    const cliInfo = lookup(cli);
    if (!cliInfo || !trustedAncestor(cliInfo) || cliInfo.uid !== uid)
      return undefined;
    const target = join(cli, "diagnostics");
    if (!lookup(target)) createPrivate(target);
    const info = lookup(target);
    return info && ownPrivate(info)
      ? { directory: target, dev: info.dev, ino: info.ino }
      : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is another user's live process; only ESRCH proves it is gone.
    return errorCode(error) !== "ESRCH";
  }
}

// Entries listed here may vanish under a concurrent run (another sweeper, or
// a holder releasing): "already gone" is success, never a setup failure.
function entriesOf(directory: string): string[] | undefined {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function removeIfPresent(remove: () => void): void {
  try {
    remove();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function discard(entry: string): void {
  const info = lookup(entry);
  if (!info) return;
  if (!info.isDirectory()) {
    removeIfPresent(() => unlinkSync(entry));
    return;
  }
  for (const name of entriesOf(entry) ?? [])
    removeIfPresent(() => unlinkSync(join(entry, name)));
  removeIfPresent(() => rmdirSync(entry));
}

// Staging and retiring names never hold the shared lock path. Only a
// same-host entry whose process is proven dead is litter.
function sweepResidue(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = residuePattern.exec(name);
    const pid = Number(match?.[1]);
    if (match?.[2] !== host || pid === process.pid || alive(pid)) continue;
    if (lookup(join(directory, name))?.uid === uid)
      discard(join(directory, name));
  }
}

// The lock is a populated directory moved onto, and later off, the shared
// path by one rename each. rename replaces only an empty directory, so a live
// holder is never displaced. A stale lock is emptied only when its one owner
// is proven dead on this host; rmdir then succeeds only while still empty.
// The lock's one owner is proven gone: on this host its pid is not alive; on
// another host (no liveness check is possible) the lock is older than any
// live holder keeps it. An empty lock directory has no owner at all.
function ownerProvenGone(lock: Stats, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  const match =
    entries.length === 1 ? ownerPattern.exec(entries[0] ?? "") : null;
  if (!match) return false;
  const pid = Number(match[1]);
  if (match[2] !== host)
    return Date.now() - lock.mtimeMs > limits.foreignLockStaleMilliseconds;
  return pid !== process.pid && !alive(pid);
}

function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

// rmdir succeeds only while the lock is still empty, so a fresh populated
// lock moved onto the path meanwhile is never removed.
function recoverStale(lock: string): boolean {
  const info = lookup(lock);
  if (!info) return true;
  if (!info.isDirectory() || info.uid !== uid) return false;
  // The holder may release between the failed move and this read.
  const entries = entriesOf(lock);
  if (entries === undefined) return true;
  if (!ownerProvenGone(info, entries)) return false;
  if (entries.some((name) => !unlinkIfPresent(join(lock, name)))) return false;
  try {
    rmdirSync(lock);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function moveOnto(staging: string, lock: string): boolean {
  try {
    renameSync(staging, lock);
    return true;
  } catch {
    return false;
  }
}

function tryLock(directory: string): (() => void) | undefined {
  sweepResidue(directory);
  const lock = join(directory, lockName);
  const suffix = `${process.pid}-${host}-${randomBytes(8).toString("hex")}`;
  const staging = `${lock}.pending-${suffix}`;
  const retiring = `${lock}.retiring-${suffix}`;
  const owner = `owner-${process.pid}-${host}`;
  mkdirSync(staging, { mode: 0o700 });
  closeSync(
    openSync(
      join(staging, owner),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ),
  );
  // The staging directory is removed on every path that does not hold the
  // lock, even when recovery throws, so no run leaves residue behind.
  let held = false;
  try {
    held =
      moveOnto(staging, lock) ||
      (recoverStale(lock) && moveOnto(staging, lock));
  } finally {
    if (!held) discard(staging);
  }
  if (!held) return undefined;
  return () => {
    try {
      renameSync(lock, retiring);
      discard(retiring);
    } catch {
      // A lock that cannot be retired stays visible; its owner is this
      // process, so it becomes recoverable once this process ends.
    }
  };
}

// Bounded wait for the lock. It stops as soon as the run is frozen, so no
// lock I/O continues after the status freeze (DIAG-15).
async function acquire(
  directory: string,
  abandoned: () => boolean,
): Promise<(() => void) | undefined> {
  const attempts = Math.ceil(
    limits.lockWaitMilliseconds / limits.lockRetryMilliseconds,
  );
  for (let attempt = 0; attempt < attempts && !abandoned(); attempt += 1) {
    const release = tryLock(directory);
    if (release) return release;
    await new Promise((resolve) =>
      setTimeout(resolve, limits.lockRetryMilliseconds),
    );
  }
  return undefined;
}

type Entry = {
  readonly path: string;
  readonly info: Stats;
  readonly marker: string | undefined;
  readonly charge: number;
};

function markerFor(file: string, info: Stats): string {
  return `${file}.closed-${info.dev}-${info.ino}-${info.size}`;
}

function classify(directory: string, name: string): Entry | undefined {
  const path = join(directory, name);
  const info = lookup(path);
  if (!info) return undefined;
  const confirmed =
    info.isFile() &&
    info.nlink === 1 &&
    info.uid === uid &&
    ownPrivate(lookup(markerFor(path, info)));
  return {
    path,
    info,
    marker: confirmed ? markerFor(path, info) : undefined,
    // Anything not confirmed closed may still grow to a full run allowance.
    charge: confirmed ? info.size : Math.max(info.size, limits.runBytes),
  };
}

function bookkeeping(directory: string, name: string): boolean {
  if (name === lockName || residuePattern.test(name)) return true;
  const marker = markerPattern.exec(name);
  if (!marker) return false;
  if (!ownPrivate(lookup(join(directory, name)))) return false;
  // An orphaned closure marker is removed; rmdir refuses a populated one.
  if (marker[1] !== undefined && !lookup(join(directory, marker[1])))
    try {
      rmdirSync(join(directory, name));
    } catch {
      // Left for a later prune.
    }
  return true;
}

// DIAG-10: confirmed-closed logs older than seven days go first, then the
// oldest confirmed-closed logs while room is needed. Active, timed-out and
// ambiguous entries are never candidates, whatever their age.
function prune(directory: string, now: number): boolean {
  const entries = readdirSync(directory)
    .filter((name) => !bookkeeping(directory, name))
    .map((name) => classify(directory, name))
    .filter((entry) => entry !== undefined);
  let bytes = entries.reduce((sum, entry) => sum + entry.charge, 0);
  let files = entries.length;
  const room = () =>
    bytes + limits.runBytes <= limits.aggregateBytes &&
    files + 1 <= limits.files;
  const closed = entries
    .filter((entry) => entry.marker !== undefined)
    .sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
  for (const entry of closed) {
    const old = now - entry.info.mtimeMs > limits.pruneAgeMilliseconds;
    if (!old && room()) continue;
    const current = lookup(entry.path);
    if (
      !current ||
      current.dev !== entry.info.dev ||
      current.ino !== entry.info.ino ||
      current.size !== entry.info.size ||
      entry.marker === undefined
    )
      continue;
    unlinkSync(entry.path);
    rmdirSync(entry.marker);
    bytes -= entry.charge;
    files -= 1;
  }
  return room();
}

const createFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK |
  constants.O_APPEND;

// What real open behaviour produced is the destination this unit supports: a
// private regular file of this user, still named by the path, inside the very
// directory that was checked (an ancestor swapped before open is refused).
function custodyHolds(
  held: Stats,
  named: Stats | undefined,
  directory: Stats | undefined,
  place: Place,
): boolean {
  return (
    held.isFile() &&
    held.nlink === 1 &&
    held.uid === uid &&
    (held.mode & 0o7777) === 0o600 &&
    named?.dev === held.dev &&
    named.ino === held.ino &&
    directory?.isDirectory() === true &&
    directory.dev === place.dev &&
    directory.ino === place.ino
  );
}

// The descriptor is the custody: every later write goes to it, nothing is
// reopened by path (DIAG-8).
function open(
  place: Place,
  runId: string,
  io: DiagnosticsIo,
): Opened | "setup" {
  const file = join(place.directory, `${runId}.jsonl`);
  let descriptor: number;
  try {
    descriptor = io.open(file, createFlags, 0o600);
  } catch {
    return "setup";
  }
  try {
    fchmodSync(descriptor, 0o600);
    const held = fstatSync(descriptor);
    if (custodyHolds(held, lookup(file), lookup(place.directory), place))
      return { descriptor, file, dev: held.dev, ino: held.ino };
  } catch {
    // Fall through to refusal.
  }
  try {
    closeSync(descriptor);
  } catch {
    // The refusal stands either way.
  }
  return "setup";
}

export async function allocate(
  place: Place,
  runId: string,
  io: DiagnosticsIo,
  abandoned: () => boolean,
): Promise<Allocation> {
  if (!segment.test(runId)) return "setup";
  let release: (() => void) | undefined;
  try {
    release = await acquire(place.directory, abandoned);
  } catch {
    return "setup";
  }
  if (!release) return abandoned() ? "abandoned" : "capacity";
  try {
    if (abandoned()) return "abandoned";
    if (!prune(place.directory, Date.now())) return "capacity";
    if (abandoned()) return "abandoned";
    return open(place, runId, io);
  } catch {
    return "setup";
  } finally {
    release();
  }
}

// Confirms closure for later pruning: a marker binding the closed file's
// device, inode and size. A replaced or grown file never matches it.
export function confirmClosed(opened: Opened, size: number): void {
  try {
    const current = lookup(opened.file);
    if (
      current?.isFile() === true &&
      current.dev === opened.dev &&
      current.ino === opened.ino &&
      current.size === size
    )
      createPrivate(markerFor(opened.file, current));
  } catch {
    // Unconfirmed closure keeps the log out of the pruning set.
  }
}
