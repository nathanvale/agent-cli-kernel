import { mock } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

export type FsEvent = {
  readonly seq: number;
  readonly at: number;
  readonly op: string;
  readonly path: string;
  readonly to?: string;
  readonly stack: string;
};

export type FsTrace = {
  readonly orig: typeof fs;
  readonly events: readonly FsEvent[];
  readonly seq: () => number;
  readonly stalls: Map<string, () => Promise<void>>;
};

const orig: typeof fs = { ...fs };
const origP: typeof fsp = { ...fsp };
const events: FsEvent[] = [];
const fdPath = new Map<number, string>();
const stalls = new Map<string, () => Promise<void>>();
let sequence = 0;

function pathText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return fdPath.get(value) ?? `fd:${value}`;
  if (value instanceof URL) return value.href;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function record(op: string, path: unknown, to?: unknown): void {
  sequence += 1;
  events.push({
    seq: sequence,
    at: performance.now(),
    op,
    path: pathText(path),
    ...(to === undefined ? {} : { to: pathText(to) }),
    stack: new Error().stack ?? "",
  });
}

function pathExists(path: fs.PathLike): boolean {
  try {
    orig.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function createsFile(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & orig.constants.O_CREAT) !== 0;
  return typeof flags === "string" && /[wa]/.test(flags);
}

function truncatesFile(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & orig.constants.O_TRUNC) !== 0;
  return typeof flags === "string" && flags.includes("w");
}

function wrapSyncMove(
  name: "renameSync" | "linkSync" | "symlinkSync" | "copyFileSync",
): (...args: never[]) => unknown {
  const fn = orig[name];
  return (...args: never[]) => {
    const out: unknown = Reflect.apply(fn, orig, args);
    if (name === "renameSync") record("rename", args[0], args[1]);
    else record(name.replace("Sync", ""), args[1], args[0]);
    return out;
  };
}

function wrapSyncRemove(
  name: "rmSync" | "unlinkSync" | "rmdirSync",
): (...args: never[]) => unknown {
  const fn = orig[name];
  return (...args: never[]) => {
    const first: unknown = args[0];
    const had =
      typeof first === "string" ||
      first instanceof URL ||
      Buffer.isBuffer(first)
        ? pathExists(first)
        : false;
    const out: unknown = Reflect.apply(fn, orig, args);
    if (had) record("remove", first);
    return out;
  };
}

const wrappedFs: Record<string, unknown> = {
  ...orig,
  mkdirSync(
    path: fs.PathLike,
    options?: fs.MakeDirectoryOptions | fs.Mode | null,
  ) {
    const had = pathExists(path);
    const out = orig.mkdirSync(path, options);
    if (!had) record("mkdir", path);
    return out;
  },
  openSync(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) {
    const had = pathExists(path);
    const fd = orig.openSync(path, flags, mode);
    fdPath.set(fd, pathText(path));
    if (createsFile(flags) && !had) record("create", path);
    else if (truncatesFile(flags) && had) record("truncate", path);
    return fd;
  },
  closeSync(fd: number) {
    fdPath.delete(fd);
    return orig.closeSync(fd);
  },
  writeSync(fd: number, ...rest: unknown[]) {
    const out: unknown = Reflect.apply(orig.writeSync, orig, [fd, ...rest]);
    record("write", fd);
    return out;
  },
  writeFileSync(...args: Parameters<typeof orig.writeFileSync>) {
    orig.writeFileSync(...args);
    record("writeFile", args[0]);
  },
  appendFileSync(...args: Parameters<typeof orig.appendFileSync>) {
    orig.appendFileSync(...args);
    record("appendFile", args[0]);
  },
  truncateSync(...args: Parameters<typeof orig.truncateSync>) {
    orig.truncateSync(...args);
    record("truncate", args[0]);
  },
  renameSync: wrapSyncMove("renameSync"),
  linkSync: wrapSyncMove("linkSync"),
  symlinkSync: wrapSyncMove("symlinkSync"),
  copyFileSync: wrapSyncMove("copyFileSync"),
  rmSync: wrapSyncRemove("rmSync"),
  unlinkSync: wrapSyncRemove("unlinkSync"),
  rmdirSync: wrapSyncRemove("rmdirSync"),
};
wrappedFs.default = wrappedFs;
void mock.module("node:fs", () => wrappedFs);

async function stallOpen(path: string): Promise<void> {
  for (const [prefix, wait] of stalls)
    if (path.startsWith(prefix)) await wait();
}

function wrapHandleMethod(
  handle: fsp.FileHandle,
  name: "writeFile" | "write" | "appendFile" | "truncate",
  path: fs.PathLike,
): void {
  const original: unknown = Reflect.get(handle, name);
  if (typeof original !== "function") return;
  Reflect.set(handle, name, async (...args: unknown[]) => {
    const out: unknown = await Reflect.apply(original, handle, args);
    record("write", path);
    return out;
  });
}

function wrapAsyncPath(
  name: "writeFile" | "appendFile" | "mkdir" | "rm" | "unlink",
): (...args: never[]) => Promise<unknown> {
  const fn = origP[name];
  return async (...args: never[]) => {
    const first: unknown = args[0];
    const had =
      typeof first === "string" ||
      first instanceof URL ||
      Buffer.isBuffer(first)
        ? pathExists(first)
        : false;
    const out: unknown = await Reflect.apply(fn, origP, args);
    const shouldRecord =
      name === "mkdir" ? !had : name === "rm" || name === "unlink" ? had : true;
    if (shouldRecord)
      record(name === "rm" || name === "unlink" ? "remove" : name, first);
    return out;
  };
}

function wrapAsyncMove(
  name: "rename" | "link",
): (...args: never[]) => Promise<unknown> {
  const fn = origP[name];
  return async (...args: never[]) => {
    const out: unknown = await Reflect.apply(fn, origP, args);
    if (name === "rename") record("rename", args[0], args[1]);
    else record("link", args[1], args[0]);
    return out;
  };
}

const wrappedFsp: Record<string, unknown> = {
  ...origP,
  async open(
    path: fs.PathLike,
    flags?: string | number,
    mode?: fs.Mode,
  ): Promise<fsp.FileHandle> {
    if (createsFile(flags)) await stallOpen(pathText(path));
    const had = pathExists(path);
    const handle = await origP.open(path, flags, mode);
    if (createsFile(flags) && !had) record("create", path);
    else if (truncatesFile(flags) && had) record("truncate", path);
    for (const method of [
      "writeFile",
      "write",
      "appendFile",
      "truncate",
    ] as const)
      wrapHandleMethod(handle, method, path);
    return handle;
  },
  writeFile: wrapAsyncPath("writeFile"),
  appendFile: wrapAsyncPath("appendFile"),
  mkdir: wrapAsyncPath("mkdir"),
  rm: wrapAsyncPath("rm"),
  unlink: wrapAsyncPath("unlink"),
  rename: wrapAsyncMove("rename"),
  link: wrapAsyncMove("link"),
};
wrappedFsp.default = wrappedFsp;
void mock.module("node:fs/promises", () => wrappedFsp);

const traceKey = Symbol.for("agent-cli-kernel.state-class-detector.fs-trace");
const trace: FsTrace = Object.freeze({
  orig,
  events,
  seq: () => sequence,
  stalls,
});
Reflect.set(globalThis, traceKey, trace);

export function getFsTrace(): FsTrace {
  const found: unknown = Reflect.get(globalThis, traceKey);
  if (typeof found !== "object" || found === null)
    throw new Error("Run with --preload trace-fs-preload.ts.");
  return trace;
}
