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

function sweepResidue(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = residuePattern.exec(name);
    const pid = Number(match?.[1]);
    if (match?.[2] !== host || pid === process.pid || alive(pid)) continue;
    if (lookup(join(directory, name))?.uid === uid)
      discard(join(directory, name));
  }
}

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

function removeStaleLock(lock: string): boolean {
  const info = lookup(lock);
  if (!info) return true;
  if (!info.isDirectory() || info.uid !== uid) return false;
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

// rename replaces only an empty directory, so a live holder is never
// displaced.
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
  let held = false;
  try {
    held =
      moveOnto(staging, lock) ||
      (removeStaleLock(lock) && moveOnto(staging, lock));
  } finally {
    if (!held) discard(staging);
  }
  if (!held) return undefined;
  return () => {
    try {
      renameSync(lock, retiring);
      discard(retiring);
    } catch {
      return;
    }
  };
}

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
    charge: confirmed ? info.size : Math.max(info.size, limits.runBytes),
  };
}

function bookkeeping(directory: string, name: string): boolean {
  if (name === lockName || residuePattern.test(name)) return true;
  const marker = markerPattern.exec(name);
  if (!marker) return false;
  if (!ownPrivate(lookup(join(directory, name)))) return false;
  if (marker[1] !== undefined && !lookup(join(directory, marker[1])))
    try {
      rmdirSync(join(directory, name));
    } catch {
      return true;
    }
  return true;
}

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
  const held = heldInCustody(descriptor, file, place);
  if (held) return held;
  closeIfPossible(descriptor);
  return "setup";
}

function heldInCustody(
  descriptor: number,
  file: string,
  place: Place,
): Opened | undefined {
  try {
    fchmodSync(descriptor, 0o600);
    const held = fstatSync(descriptor);
    return custodyHolds(held, lookup(file), lookup(place.directory), place)
      ? { descriptor, file, dev: held.dev, ino: held.ino }
      : undefined;
  } catch {
    return undefined;
  }
}

export function closeIfPossible(descriptor: number): boolean {
  try {
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
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
    return;
  }
}
