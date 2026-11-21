import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ttyTerminalFor } from "../../../kernel/src/kernel/process-host.ts";
import type { TtyStream } from "../../../kernel/src/kernel/process-host.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { signalGroupIfPresent } from "../../support/signal.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";
import { normalizeRunId } from "./menu-helpers.ts";

const menuCli = join(import.meta.dir, "fixtures/menu-cli.ts");
const folder = ownedFolders();
const ptyBoundMilliseconds = 30_000;
const killedExitBound = 3_000;
const groupGoneCodes = new Set<unknown>(["ESRCH", "EPERM"]);

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (groupGoneCodes.has(Reflect.get(Object(error), "code"))) return false;
    throw error;
  }
}

async function settledWithin<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T | "expired"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), milliseconds);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function waitGroupGone(group: number, milliseconds: number): Promise<boolean> {
  if (!groupAlive(group)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (gone: boolean) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(gone);
    };
    const poll = setInterval(() => {
      if (!groupAlive(group)) finish(true);
    }, 5);
    const timer = setTimeout(() => finish(!groupAlive(group)), milliseconds);
  });
}

async function stopPtyGroup(
  child: Bun.Subprocess,
  label: string,
): Promise<void> {
  signalGroupIfPresent(child.pid, "SIGKILL");
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  const exited = await settledWithin(child.exited, killedExitBound);
  const gone = await waitGroupGone(child.pid, killedExitBound);
  if (exited === "expired" || !gone)
    throw new Error(
      `PTY process group ${String(child.pid)} (${label}) did not exit within ${String(killedExitBound)} ms of SIGKILL.`,
    );
}

function readPidFile(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`Invalid CLI pid in ${pidFile}: ${String(pid)}.`);
  return pid;
}

async function settleFour<A, B, C, D>(
  runs: readonly [Promise<A>, Promise<B>, Promise<C>, Promise<D>],
): Promise<readonly [A, B, C, D]> {
  const [a, b, c, d] = await Promise.allSettled(runs);
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  if (c.status === "rejected") throw c.reason;
  if (d.status === "rejected") throw d.reason;
  return [a.value, b.value, c.value, d.value];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canonicalAndEchoRestored(sttyOutput: string): {
  readonly canonical: boolean;
  readonly echo: boolean;
} {
  return {
    canonical:
      /(?:^|\s)icanon(?:\s|$)/.test(sttyOutput) &&
      !/(?:^|\s)-icanon(?:\s|$)/.test(sttyOutput),
    echo:
      /(?:^|\s)echo(?:\s|$)/.test(sttyOutput) &&
      !/(?:^|\s)-echo(?:\s|$)/.test(sttyOutput),
  };
}

async function runPtyScenario(options: {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onOutput?: (
    allOutput: string,
    terminal: NonNullable<Bun.Subprocess["terminal"]>,
  ) => void;
  readonly boundMilliseconds?: number;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const bound = options.boundMilliseconds ?? ptyBoundMilliseconds;
  const label = options.argv.join(" ");
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let combined = "";
  let callbackError: unknown;
  let markFailed: (() => void) | undefined;
  const failed = new Promise<"failed">((resolve) => {
    markFailed = () => resolve("failed");
  });
  const spawnOptions = {
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    terminal: {
      cols: 80,
      rows: 24,
      data(
        terminal: NonNullable<Bun.Subprocess["terminal"]>,
        data: Uint8Array,
      ) {
        const copy = new Uint8Array(data);
        chunks.push(copy);
        combined += decoder.decode(copy, { stream: true });
        if (callbackError !== undefined) return;
        try {
          options.onOutput?.(combined, terminal);
        } catch (error) {
          callbackError = error;
          markFailed?.();
        }
      },
    },
  };
  const child = Bun.spawn([...options.argv], spawnOptions);
  try {
    const outcome = await settledWithin(
      Promise.race([child.exited, failed]),
      bound,
    );
    if (outcome === "failed") {
      await stopPtyGroup(child, label);
      throw callbackError;
    }
    if (outcome === "expired") {
      await stopPtyGroup(child, label);
      throw new Error(
        `PTY child ${label} did not exit within ${String(bound)} ms.`,
      );
    }
    const gone = await waitGroupGone(child.pid, killedExitBound);
    if (!gone) await stopPtyGroup(child, label);
    return {
      exitCode: outcome,
      output: new TextDecoder().decode(Buffer.concat(chunks)),
    };
  } finally {
    if (
      (child.exitCode === null && child.signalCode === null) ||
      groupAlive(child.pid)
    )
      await stopPtyGroup(child, label);
    child.terminal?.close();
  }
}

describe("process-host tty terminal input bounds and cancellation", () => {
  function fakeTty() {
    const rawModes: boolean[] = [];
    const writes: string[] = [];
    let pauses = 0;
    let resumes = 0;
    let refs = 0;
    let unrefs = 0;
    const decoder = new TextDecoder();
    class FakeTtyStream extends EventEmitter implements TtyStream {
      setRawMode(mode: boolean) {
        rawModes.push(mode);
      }
      pause() {
        pauses += 1;
      }
      resume() {
        resumes += 1;
      }
      ref() {
        refs += 1;
      }
      unref() {
        unrefs += 1;
      }
    }
    const stream = new FakeTtyStream();
    const terminal = ttyTerminalFor({
      size: () => ({ columns: 80, rows: 24 }),
      openStream: () => stream,
      write: (bytes) => {
        writes.push(decoder.decode(bytes));
      },
    });
    return {
      terminal,
      rawModes,
      writes,
      stats: () => ({
        pauses,
        resumes,
        refs,
        unrefs,
        dataListeners: stream.listenerCount("data"),
      }),
      emit(chunk: string | Buffer) {
        stream.emit("data", chunk);
      },
    };
  }

  test("restores raw mode, cursor, and stream ref state on leave, and is safe to call twice", () => {
    const tty = fakeTty();
    tty.terminal.enter();
    tty.terminal.enter();
    expect(tty.rawModes).toEqual([true]);
    expect(tty.writes).toEqual(["\x1b[?25l"]);
    expect(tty.stats().refs).toBe(1);

    tty.terminal.leave();
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.writes).toEqual(["\x1b[?25l", "\x1b[?25h"]);
    expect(tty.stats().pauses).toBe(1);
    expect(tty.stats().unrefs).toBe(1);

    tty.terminal.leave();
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.writes).toEqual(["\x1b[?25l", "\x1b[?25h"]);
  });

  test("caps queued terminal input with backpressure and resumes once drained", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    const iterable = tty.terminal.keys(controller.signal);
    const iterator = iterable[Symbol.asyncIterator]();
    expect(tty.stats().resumes).toBe(1);
    const pausesBefore = tty.stats().pauses;
    for (let index = 0; index < 120; index += 1) {
      tty.emit(`k${String(index)}`);
    }
    expect(tty.stats().pauses).toBeGreaterThan(pausesBefore);

    const received: string[] = [];
    const decoder = new TextDecoder();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) received.push(decoder.decode(first.value));
    expect(tty.stats().resumes).toBe(2);

    while (received.length < 64) {
      const item = await iterator.next();
      if (item.done) break;
      received.push(decoder.decode(item.value));
    }
    expect(received).toHaveLength(64);
    expect(received[0]).toBe("k0");
    expect(received[63]).toBe("k63");

    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  test("accepts and resumes after a single chunk larger than the byte cap on an empty queue", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    const iterable = tty.terminal.keys(controller.signal);
    const iterator = iterable[Symbol.asyncIterator]();
    expect(tty.stats().resumes).toBe(1);

    tty.emit(Buffer.alloc(70_000, 0x61));
    expect(tty.stats().pauses).toBe(1);

    const firstOutcome = await Promise.race([
      iterator.next(),
      Promise.resolve().then(() => "stalled" as const),
    ]);
    expect(firstOutcome).not.toBe("stalled");
    if (firstOutcome === "stalled") return;
    expect(firstOutcome.done).toBe(false);
    if (!firstOutcome.done) expect(firstOutcome.value.byteLength).toBe(65_536);
    expect(tty.stats().resumes).toBe(2);

    tty.emit("ok");
    const secondOutcome = await Promise.race([
      iterator.next(),
      Promise.resolve().then(() => "stalled" as const),
    ]);
    expect(secondOutcome).not.toBe("stalled");
    if (secondOutcome === "stalled") return;
    expect(secondOutcome.done).toBe(false);
    if (!secondOutcome.done)
      expect(new TextDecoder().decode(secondOutcome.value)).toBe("ok");

    controller.abort();
  });

  test("does not deliver queued keys after abort or iterator cancel", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    const iterable = tty.terminal.keys(controller.signal);
    const iterator = iterable[Symbol.asyncIterator]();
    tty.emit("a");
    tty.emit("b");
    controller.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(tty.stats().dataListeners).toBe(0);

    const secondController = new AbortController();
    const secondIterable = tty.terminal.keys(secondController.signal);
    const secondIterator = secondIterable[Symbol.asyncIterator]();
    tty.emit("x");
    await secondIterator.return?.();
    expect(await secondIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("menu real-process PTY proofs", () => {
  const timeout = processWatchdog(8);

  test(
    "pick and Esc cancel work in a real PTY and restore canonical mode and echo",
    async () => {
      let sentPick = false;
      const picked = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" menu; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output, terminal) {
          if (!sentPick && output.includes("Open what?")) {
            sentPick = true;
            terminal.write("\x1b[B\r");
          }
        },
      });
      expect(picked.exitCode).toBe(0);
      expect(picked.output).toContain("Opened beta.");
      expect(picked.output).toContain("\x1b[?25h");
      const pickAfter = picked.output.split("RC=0")[1] ?? "";
      expect(canonicalAndEchoRestored(pickAfter)).toEqual({
        canonical: true,
        echo: true,
      });

      let sentDefault = false;
      const pickedDefault = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}"; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output, terminal) {
          if (!sentDefault && output.includes("Open what?")) {
            sentDefault = true;
            terminal.write("\r");
          }
        },
      });
      expect(pickedDefault.exitCode).toBe(0);
      expect(pickedDefault.output).toContain("Opened alpha.");
      expect(pickedDefault.output).toContain("\x1b[?25h");
      const defaultAfter = pickedDefault.output.split("RC=0")[1] ?? "";
      expect(canonicalAndEchoRestored(defaultAfter)).toEqual({
        canonical: true,
        echo: true,
      });

      let sentEsc = false;
      const cancelled = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" menu; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output, terminal) {
          if (!sentEsc && output.includes("Open what?")) {
            sentEsc = true;
            terminal.write("\x1b");
          }
        },
      });
      expect(cancelled.exitCode).toBe(3);
      expect(cancelled.output).toContain("Nothing was opened.");
      expect(cancelled.output).toContain("DOMAIN_DOORWAY_NOTHING_CHOSEN");
      expect(cancelled.output).toContain("\x1b[?25h");
      const escAfter = cancelled.output.split("RC=3")[1] ?? "";
      expect(canonicalAndEchoRestored(escAfter)).toEqual({
        canonical: true,
        echo: true,
      });
    },
    timeout,
  );

  test(
    "Ctrl-C at the menu restores the terminal, exits 130, and prints no envelope",
    async () => {
      let sentInterrupt = false;
      const ran = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" menu; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output, terminal) {
          if (!sentInterrupt && output.includes("Open what?")) {
            sentInterrupt = true;
            terminal.write("\x03");
          }
        },
      });
      expect(ran.exitCode).toBe(130);
      expect(ran.output).not.toContain("contractVersion");
      expect(ran.output).not.toContain("Nothing was opened.");
      expect(ran.output).not.toContain("DOMAIN_DOORWAY_");
      expect(ran.output).toContain("\x1b[?25h");
      const after = ran.output.split("RC=130")[1] ?? "";
      expect(canonicalAndEchoRestored(after)).toEqual({
        canonical: true,
        echo: true,
      });
    },
    timeout,
  );

  test(
    "SIGTERM with the menu open restores the terminal, exits 143, and prints no envelope",
    async () => {
      const work = folder("menu-sigterm-");
      const pidFile = join(work, "cli.pid");
      let sentTerm = false;
      const ran = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" menu; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        env: { ...process.env, MENU_CLI_PID_FILE: pidFile },
        onOutput(output) {
          if (!sentTerm && output.includes("Open what?")) {
            sentTerm = true;
            process.kill(readPidFile(pidFile), "SIGTERM");
          }
        },
      });
      expect(ran.exitCode).toBe(143);
      expect(ran.output).not.toContain("contractVersion");
      expect(ran.output).toContain("\x1b[?25h");
      const after = ran.output.split("RC=143")[1] ?? "";
      expect(canonicalAndEchoRestored(after)).toEqual({
        canonical: true,
        echo: true,
      });
    },
    timeout,
  );

  test(
    "--deadline-ms with the menu open restores the terminal and exits 3 with DOMAIN_DEADLINE_UNCHANGED",
    async () => {
      const ran = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" menu --deadline-ms 300; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
      });
      expect(ran.exitCode).toBe(3);
      expect(ran.output).toContain("DOMAIN_DEADLINE_UNCHANGED");
      expect(ran.output).toContain("\x1b[?25h");
      const after = ran.output.split("RC=3")[1] ?? "";
      expect(canonicalAndEchoRestored(after)).toEqual({
        canonical: true,
        echo: true,
      });
    },
    timeout,
  );

  test(
    "uncaught crash with the menu open restores the terminal through killNow and exits 1",
    async () => {
      const work = folder("menu-crash-");
      const pidFile = join(work, "cli.pid");
      let sentCrash = false;
      const ran = await runPtyScenario({
        argv: [
          "/bin/sh",
          "-c",
          `"${process.execPath}" "${menuCli}" crash; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        env: { ...process.env, MENU_CLI_PID_FILE: pidFile },
        onOutput(output) {
          if (!sentCrash && output.includes("Open what?")) {
            sentCrash = true;
            process.kill(readPidFile(pidFile), "SIGUSR1");
          }
        },
      });
      expect(ran.exitCode).toBe(1);
      expect(ran.output).not.toContain("contractVersion");
      expect(ran.output).toContain("\x1b[?25h");
      const after = ran.output.split("RC=1")[1] ?? "";
      expect(canonicalAndEchoRestored(after)).toEqual({
        canonical: true,
        echo: true,
      });
    },
    timeout,
  );

  test(
    "two picks in one command work in a real PTY with a fresh filter for the second pick",
    async () => {
      let sentFirst = false;
      let sentSecond = false;
      const ran = await runPtyScenario({
        argv: [process.execPath, menuCli, "two-step"],
        onOutput(output, terminal) {
          if (!sentFirst && output.includes("Step one?")) {
            sentFirst = true;
            terminal.write("lin\r");
          }
          if (!sentSecond && output.includes("Step two on linux?")) {
            sentSecond = true;
            terminal.write("\r");
          }
        },
      });
      expect(ran.exitCode).toBe(0);
      expect(ran.output).toContain("Opened linux:repo-one.");
    },
    timeout,
  );

  test(
    "not-interactive refusal is byte-identical for piped agents and --json in a PTY",
    async () => {
      const [pipedHuman, pipedJson, ptyJson, stdoutPiped] = await settleFour([
        spawnBounded([process.execPath, menuCli, "menu"]),
        spawnBounded([process.execPath, menuCli, "menu", "--json"]),
        runPtyScenario({
          argv: [process.execPath, menuCli, "menu", "--json"],
        }),
        runPtyScenario({
          argv: [
            "/bin/sh",
            "-c",
            `out=$("${process.execPath}" "${menuCli}" menu); rc=$?; printf '%s' "$out"; exit $rc`,
          ],
        }),
      ]);

      expect(pipedHuman.exit).toBe(3);
      expect(pipedHuman.stdout).toBe("");
      expect(pipedHuman.stderr).toBe(
        "doorway: A terminal is required to show the menu. [DOMAIN_DOORWAY_NEEDS_TERMINAL]\n",
      );

      expect(stdoutPiped.exitCode).toBe(3);
      expect(stdoutPiped.output).toContain("DOMAIN_DOORWAY_NEEDS_TERMINAL");
      expect(stdoutPiped.output).not.toContain("Open what?");

      expect(pipedJson.exit).toBe(3);
      expect(pipedJson.stderr).toBe("");
      expect(ptyJson.exitCode).toBe(3);
      expect(normalizeRunId(pipedJson.stdout.trim())).toBe(
        normalizeRunId(ptyJson.output.trim()),
      );
    },
    timeout,
  );

  test(
    "stops and confirms the whole PTY process group when onOutput throws",
    async () => {
      const work = folder("menu-pty-cleanup-");
      const pidFile = join(work, "child.pid");
      let childPid = 0;
      let caught = "";
      try {
        await runPtyScenario({
          argv: [
            "/bin/sh",
            "-c",
            `sleep 30 & pid=$!; printf '%d' "$pid" > "${pidFile}.tmp"; mv "${pidFile}.tmp" "${pidFile}"; printf 'READY\n'; wait "$pid"`,
          ],
          onOutput(output) {
            if (output.includes("READY")) {
              childPid = readPidFile(pidFile);
              throw new Error("stop-pty-group");
            }
          },
        });
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }
      expect(caught).toBe("stop-pty-group");
      expect(childPid).toBeGreaterThan(0);
      expect(pidAlive(childPid)).toBe(false);
    },
    timeout,
  );
});
