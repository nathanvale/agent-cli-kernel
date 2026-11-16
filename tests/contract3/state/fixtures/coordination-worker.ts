// LABELLED TEST WORKER. Spawned by tests/contract3/state/route.test.ts as a
// real separate process. It takes one coordination lock through a named
// route and writes what happened to a report file (the barrier). It decides
// nothing.
//
// argv: <route> <mode> <lockFile> <reportFile> [option]
//   route  addon           the add-on's own coordination module
//          posix-control   lockf(F_TLOCK): process-owned (negative control)
//          shared-control  test holder; the child gets the locked descriptor
//                          as its stdin (negative control for C4b)
//          cloexec-control test holder with close-on-exec cleared (Linux)
//   mode   hold            acquire, report, stay alive until killed. option
//                          "other-descriptor": open the file again and close
//                          that descriptor first; "child": spawn a
//                          long-lived child and report its pid.
//          try             one attempt; report result, code, elapsed time.
//          same-process    acquire, then a second open in this process
//                          attempts; report the second result.
import { closeSync, constants, openSync, renameSync, writeFileSync } from "node:fs";
import { resolveCoordination } from "../../../../starters/contract3/src/addons/state/coordination.ts";
import {
  attemptLock,
  attemptPosixLock,
  clearCloseOnExec,
} from "../holder.ts";
import type { Attempt } from "../holder.ts";

const [route = "", mode = "", file = "", report = "", option = ""] =
  process.argv.slice(2);

type Outcome = {
  readonly result: "acquired" | "refused" | "error";
  readonly code: string;
  readonly fd: number | null;
};

function viaAddon(path: string): { outcome: Outcome; keep: () => void } {
  const coordination = resolveCoordination();
  if (!coordination.available)
    return {
      outcome: { result: "error", code: coordination.reason, fd: null },
      keep: () => {},
    };
  const attempt = coordination.tryLock(path);
  if (attempt.kind === "held")
    return {
      outcome: { result: "acquired", code: "none", fd: null },
      keep: () => attempt.release,
    };
  return {
    outcome: {
      result: attempt.kind === "busy" ? "refused" : "error",
      code: attempt.kind === "busy" ? "busy" : attempt.code,
      fd: null,
    },
    keep: () => {},
  };
}

function fromTest(attempt: Attempt): { outcome: Outcome; keep: () => void } {
  return attempt.kind === "acquired"
    ? {
        outcome: { result: "acquired", code: "none", fd: attempt.held.fd },
        keep: () => attempt.held.release,
      }
    : { outcome: { result: attempt.kind, code: attempt.code, fd: null }, keep: () => {} };
}

function take(path: string): { outcome: Outcome; keep: () => void } {
  switch (route) {
    case "addon":
      return viaAddon(path);
    case "posix-control":
      return fromTest(attemptPosixLock(path));
    case "shared-control":
    case "cloexec-control":
      return fromTest(attemptLock(path));
    default:
      throw new Error(`Unknown route ${route}.`);
  }
}

function writeReport(value: Readonly<Record<string, unknown>>): void {
  const staged = `${report}.tmp`;
  writeFileSync(staged, JSON.stringify({ pid: process.pid, ...value }));
  renameSync(staged, report);
}

// Everything taken stays referenced for the life of the process, so a
// collected handle can never release a coordination lock and fake a result.
const retained: unknown[] = [];
function stayAlive(): void {
  setInterval(() => {}, 1_000_000);
}

function spawnChild(fd: number | null): number {
  const sharing = route === "shared-control" && fd !== null;
  if (route === "cloexec-control" && (fd === null || !clearCloseOnExec(fd)))
    throw new Error("close-on-exec could not be cleared on this platform");
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000000)"],
    {
      stdin: sharing ? fd : "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();
  return child.pid;
}

function hold(): void {
  const taken = take(file);
  retained.push(taken.keep());
  if (option === "other-descriptor" && taken.outcome.result === "acquired") {
    const second = openSync(
      file,
      constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(second);
  }
  const child =
    option === "child" && taken.outcome.result === "acquired"
      ? spawnChild(taken.outcome.fd)
      : null;
  writeReport({ ...taken.outcome, child });
  stayAlive();
}

function tryOnce(): void {
  const started = performance.now();
  const taken = take(file);
  const elapsedMs = performance.now() - started;
  writeReport({ ...taken.outcome, elapsedMs });
}

function sameProcess(): void {
  const first = take(file);
  retained.push(first.keep());
  const second = take(file);
  retained.push(second.keep());
  writeReport({ first: first.outcome.result, ...second.outcome });
}

try {
  if (mode === "hold") hold();
  else if (mode === "try") tryOnce();
  else if (mode === "same-process") sameProcess();
  else throw new Error(`Unknown mode ${mode}.`);
} catch (error) {
  writeReport({
    result: "error",
    code: error instanceof Error ? error.message : String(error),
    fd: null,
  });
}
