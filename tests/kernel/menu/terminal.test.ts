import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ttyTerminalFor } from "../../../kernel/src/kernel/process-host.ts";
import type { TtyStream } from "../../../kernel/src/kernel/process-host.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";
import { normalizeRunId } from "./menu-helpers.ts";

const menuCli = join(import.meta.dir, "fixtures/menu-cli.ts");
const folder = ownedFolders();

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
  readonly onOutput?: (
    allOutput: string,
    terminal: NonNullable<Bun.Subprocess["terminal"]>,
  ) => void;
  readonly boundMilliseconds?: number;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const bound = options.boundMilliseconds ?? 15_000;
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let combined = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const child = Bun.spawn([...options.argv], {
    terminal: {
      cols: 80,
      rows: 24,
      data(terminal, data) {
        const copy = new Uint8Array(data);
        chunks.push(copy);
        combined += decoder.decode(copy, { stream: true });
        options.onOutput?.(combined, terminal);
      },
    },
  });
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), bound);
  });
  try {
    const outcome = await Promise.race([child.exited, expired]);
    if (outcome === "expired") {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(
        `PTY child ${options.argv.join(" ")} did not exit within ${String(bound)} ms.`,
      );
    }
    return {
      exitCode: outcome,
      output: new TextDecoder().decode(Buffer.concat(chunks)),
    };
  } finally {
    clearTimeout(timer);
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
          `"${process.execPath}" "${menuCli}" menu <&0 & pid=$!; printf '%d' "$pid" > "${pidFile}"; wait "$pid"; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output) {
          if (!sentTerm && output.includes("Open what?")) {
            sentTerm = true;
            const pid = Number(readFileSync(pidFile, "utf8").trim());
            process.kill(pid, "SIGTERM");
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
          `"${process.execPath}" "${menuCli}" crash <&0 & pid=$!; printf '%d' "$pid" > "${pidFile}"; wait "$pid"; rc=$?; printf '\nRC=%d\n' "$rc"; stty -a; exit $rc`,
        ],
        onOutput(output) {
          if (!sentCrash && output.includes("Open what?")) {
            sentCrash = true;
            const pid = Number(readFileSync(pidFile, "utf8").trim());
            process.kill(pid, "SIGUSR1");
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
      const [pipedHuman, pipedJson, ptyJson, stdoutPiped] = await Promise.all([
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
});
