// LABELLED PROBE WORKER (test-only). Spawned by
// tests/contract3/state/linux-coordination.probe.test.ts as a real separate
// process. It tries one candidate coordination lock and writes what happened
// to a report file. It decides nothing and is not production code.
//
// argv: <candidate> <mode> <lockFile> <reportFile> [extra]
//   mode "hold": acquire, report, then stay alive until killed. extra:
//     "close-second": open a second descriptor on the file and close it
//       before reporting; "child": spawn a long-lived child, report its pid.
//   mode "try": one non-blocking attempt, report result and elapsed time,
//     release and exit.
//   mode "same-process": acquire, then a second open in this process tries.
import { dlopen, ptr, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";

const [candidate = "", mode = "", file = "", report = "", extra = ""] =
  process.argv.slice(2);
const linux = process.platform === "linux";

type Attempt =
  | "acquired"
  | "busy"
  | `error:${string}`
  | `unsupported:${string}`;
type Handle = { readonly tryLock: () => Attempt; readonly close: () => void };

const libraryPath = linux ? "libc.so.6" : "libSystem.B.dylib";
const locks = dlopen(libraryPath, {
  flock: { args: ["i32", "i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" },
});
// errno is read right after a failed call; both libraries are loaded before
// any lock call so nothing in between can overwrite it.
const errnoLocation: () => unknown = linux
  ? dlopen(libraryPath, { __errno_location: { args: [], returns: "ptr" } })
      .symbols.__errno_location
  : dlopen(libraryPath, { __error: { args: [], returns: "ptr" } }).symbols
      .__error;
function errno(): number {
  const pointer = errnoLocation();
  return typeof pointer === "number" && pointer !== 0
    ? read.i32(pointer, 0)
    : -1;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : String(error);
}
function code(error: unknown): string {
  const value: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof value === "string" ? value : "";
}

const openFlags = constants.O_RDWR | constants.O_CREAT;

function sqlite(path: string): Handle {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 0");
  try {
    // Initialise the file; a second connection while the lock is held
    // cannot, and its lock attempt below reports that.
    db.exec("CREATE TABLE IF NOT EXISTS probe (x INTEGER)");
  } catch {
    // Reported by tryLock.
  }
  return {
    tryLock() {
      try {
        db.exec("BEGIN EXCLUSIVE");
        return "acquired";
      } catch (error) {
        return /busy|locked/i.test(message(error))
          ? "busy"
          : `error:${message(error)}`;
      }
    },
    close: () => db.close(),
  };
}

function flockHandle(path: string): Handle {
  const fd = openSync(path, openFlags, 0o600);
  return {
    tryLock() {
      const LOCK_EX = 2;
      const LOCK_NB = 4;
      const result = locks.symbols.flock(fd, LOCK_EX | LOCK_NB);
      return result === 0 ? "acquired" : errnoResult();
    },
    close: () => closeSync(fd),
  };
}

function errnoResult(): Attempt {
  const value = errno();
  // EAGAIN/EWOULDBLOCK is 11 on Linux and 35 on Darwin; EACCES is 13.
  return value === 11 || value === 35 || value === 13
    ? "busy"
    : `error:errno-${value}`;
}

// struct flock on Linux x86_64 and aarch64: short l_type, short l_whence,
// (pad), off_t l_start, off_t l_len, pid_t l_pid: 32 bytes.
function fcntlHandle(path: string, command: number, name: string): Handle {
  if (!linux)
    return {
      tryLock: () =>
        `unsupported:${name} not called on ${process.platform}: fcntl is variadic and the Darwin arm64 ABI passes variadic arguments on the stack, which a fixed FFI signature cannot express`,
      close: () => {},
    };
  const fd = openSync(path, openFlags, 0o600);
  const lock = new Uint8Array(32);
  const view = new DataView(lock.buffer);
  view.setInt16(0, 1, true); // F_WRLCK
  view.setInt16(2, 0, true); // SEEK_SET
  return {
    tryLock() {
      const result = locks.symbols.fcntl(fd, command, ptr(lock));
      return result === 0 ? "acquired" : errnoResult();
    },
    close: () => closeSync(fd),
  };
}

function exlock(path: string): Handle {
  let fd: number | undefined;
  return {
    tryLock() {
      try {
        fd = openSync(path, openFlags | constants.O_NONBLOCK | 0x20, 0o600);
        return "acquired";
      } catch (error) {
        return code(error) === "EAGAIN" ? "busy" : `error:${code(error)}`;
      }
    },
    close: () => {
      if (fd !== undefined) closeSync(fd);
    },
  };
}

function mkdirHandle(path: string): Handle {
  let made = false;
  return {
    tryLock() {
      try {
        mkdirSync(`${path}.d`);
        made = true;
        return "acquired";
      } catch (error) {
        return code(error) === "EEXIST" ? "busy" : `error:${code(error)}`;
      }
    },
    close: () => {
      if (made) rmdirSync(`${path}.d`);
    },
  };
}

function open(path: string): Handle {
  switch (candidate) {
    case "sqlite":
      return sqlite(path);
    case "flock":
      return flockHandle(path);
    case "ofd":
      return fcntlHandle(path, 37, "F_OFD_SETLK");
    case "fcntl-posix":
      return fcntlHandle(path, 6, "F_SETLK");
    case "o-exlock":
      return exlock(path);
    case "mkdir":
      return mkdirHandle(path);
    default:
      throw new Error(`Unknown candidate ${candidate}.`);
  }
}

function writeReport(value: Readonly<Record<string, unknown>>): void {
  const staged = `${report}.tmp`;
  writeFileSync(staged, JSON.stringify({ pid: process.pid, ...value }));
  renameSync(staged, report);
}

// Handles stay referenced for the life of the process: a collected
// connection or descriptor could release its lock and fake a result.
const retained: Handle[] = [];
function stayAlive(): void {
  setInterval(() => {}, 1_000_000);
}

function hold(): void {
  const handle = open(file);
  retained.push(handle);
  const result = handle.tryLock();
  if (extra === "close-second" && result === "acquired") {
    const second = open(file);
    retained.push(second);
    second.close();
  }
  let child: number | null = null;
  if (extra === "child" && result === "acquired") {
    const spawned = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000000)"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    spawned.unref();
    child = spawned.pid;
  }
  writeReport({ result, child });
  stayAlive();
}

function attempt(): void {
  const handle = open(file);
  const started = performance.now();
  const result = handle.tryLock();
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  handle.close();
  writeReport({ result, elapsedMs });
}

function sameProcess(): void {
  const first = open(file);
  const firstResult = first.tryLock();
  const second = open(file);
  const secondResult = second.tryLock();
  writeReport({ first: firstResult, second: secondResult });
  second.close();
  first.close();
}

try {
  if (mode === "hold") hold();
  else if (mode === "try") attempt();
  else if (mode === "same-process") sameProcess();
  else throw new Error(`Unknown mode ${mode}.`);
} catch (error) {
  writeReport({ result: `error:${message(error)}` });
}
