// T2 programs add-on process cases (P05 to P10). Starts, stdin reads and
// survivors come from the fixture ledger and the OS process table.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { callerProgramDisclosure } from "../../../starters/contract3/src/addons/programs/index.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import { assertEnvelope, receipt } from "../lifecycle/checks.ts";
import { sliceCases } from "../lifecycle/coverage.ts";
import {
  alive,
  cleanup,
  goneWithin,
  launch,
  listing,
  n,
  processGroup,
  readLedger,
  text,
} from "../lifecycle/harness.ts";
import type { Case, Observed } from "../lifecycle/harness.ts";

const timeout = 60_000;
const tolerance = 200;
const startupAllowance = 600;

function pidAfter(ledger: readonly string[], prefix: string) {
  const line = ledger.find((entry) => entry.startsWith(`${prefix} `));
  return line ? Number(line.split(" ")[1]) : undefined;
}
function data(result: Record<string, unknown>) {
  if (!record(result.data)) throw new Error("Expected program data.");
  return result.data;
}
function kill(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
async function launchCase(entry: Case, extra: object = {}) {
  return launch({
    argv: entry.argv,
    state: entry.state,
    scenario: entry.scenario,
    stdin: entry.stdin,
    ...extra,
  });
}

const probeScript = `#!/bin/sh
bytes=$(/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " ")
echo "child-stdin-bytes $bytes" >> "$FX_LEDGER"
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000 >&2
`;

async function isolation(entry: Case) {
  let argv = entry.argv;
  let observed: Observed | undefined;
  const launched = await (async () => {
    if (!argv.includes("<probe-script>")) return launchCase(entry);
    const holder = await launch({ argv: ["--help"] });
    const done = await holder.done;
    const script = join(done.dir, "probe.sh");
    await writeFile(script, probeScript);
    await chmod(script, 0o755);
    argv = argv.map((arg) => (arg === "<probe-script>" ? script : arg));
    observed = done;
    return launch({ argv, stdin: entry.stdin });
  })();
  const result = await launched.done;
  receipt(entry, result);
  try {
    const { result: wire } = assertEnvelope(entry, result);
    expect(
      text(result.stdout).includes(String(entry.expect.markerAbsent)),
    ).toBe(false);
    expect(result.ledger).toContain("child-stdin-bytes 0");
    expect(data(wire).markerSeen).toBe(true);
  } finally {
    await cleanup(result);
    if (observed) await cleanup(observed);
  }
}

const checks: Record<string, (entry: Case) => Promise<void>> = {
  P05: isolation,
  async P06(entry) {
    const launched = await launchCase(entry);
    let peak = 0;
    const sampling = (async () => {
      for (;;) {
        const sample = Bun.spawnSync([
          "/bin/ps",
          "-o",
          "rss=",
          "-p",
          String(launched.pid),
        ]);
        const rss = Number(sample.stdout.toString().trim());
        if (!rss) return;
        peak = Math.max(peak, rss);
        await Bun.sleep(20);
      }
    })();
    const observed = await launched.done;
    await sampling;
    receipt(entry, observed, { peakRssKilobytes: peak });
    try {
      const { result } = assertEnvelope(entry, observed);
      const captured = data(result);
      const limit = Number(entry.expect.capturedAtMost);
      expect(Number(captured.stdoutBytes)).toBeLessThanOrEqual(limit);
      expect(Number(captured.stderrBytes)).toBeLessThanOrEqual(limit);
      expect(captured.stdoutTruncated).toBe(true);
      expect(captured.stderrTruncated).toBe(true);
      expect(peak / 1024).toBeLessThanOrEqual(
        Number(entry.expect.maxRssMegabytes),
      );
      expect(await listing(join(observed.dir, "work"))).toEqual([]);
      expect(await listing(join(observed.dir, "tmp"))).toEqual([]);
    } finally {
      await cleanup(observed);
    }
  },
  async P07(entry) {
    const sentinel = Bun.spawn(["/bin/sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const launched = await launchCase(entry);
    await launched.barrier("grandchild");
    const cliGroup = processGroup(launched.pid);
    const observed = await launched.done;
    receipt(entry, observed, { cliGroup });
    const grandchild = pidAfter(observed.ledger, "grandchild");
    try {
      const { result } = assertEnvelope(entry, observed);
      const childGroup = pidAfter(observed.ledger, "child-pgid");
      expect(childGroup).toBeNumber();
      expect(cliGroup).toBeNumber();
      expect(childGroup).not.toBe(cliGroup);
      expect(grandchild).toBeNumber();
      expect(await goneWithin(grandchild ?? 0, 1000)).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      const detail = data(result);
      expect(detail.attempts).toEqual(entry.expect.attempts);
      expect(detail.timedOut).toBe(true);
      expect(detail.terminationConfirmed).toBe(true);
    } finally {
      sentinel.kill("SIGKILL");
      kill(grandchild);
      await cleanup(observed);
    }
  },
  async P08(entry) {
    const id = entry.id;
    const launched = await launchCase(entry, {
      scenario: entry.scenario,
    });
    let sent = 0;
    if (id === "P08.first-signal" || id === "P08.repeated-signal") {
      await launched.barrier("child-started");
      sent = launched.signal("SIGTERM");
      if (id === "P08.repeated-signal") {
        await launched.barrier("child-term-received");
        sent = launched.signal("SIGINT");
      }
    }
    const observed = await launched.done;
    receipt(entry, observed);
    const child = pidAfter(observed.ledger, "child-started");
    try {
      expect(child).toBeNumber();
      if (entry.expect.causeCode !== undefined) {
        assertEnvelope(entry, observed);
        if (entry.argv.includes("--deadline-ms")) {
          const deadline = Number(
            entry.argv[entry.argv.indexOf("--deadline-ms") + 1],
          );
          const emitted =
            (observed.firstStdoutAt ?? Infinity) - observed.spawnedAt;
          expect(emitted - deadline).toBeLessThanOrEqual(
            500 + startupAllowance + tolerance,
          );
        }
      } else {
        expect(observed.signal).toBeNull();
        expect(observed.code).toBe(n(entry.expect.exit));
        expect(observed.stdout.byteLength).toBe(0);
        expect(observed.stderr.byteLength).toBe(0);
        const bound =
          typeof entry.expect.withinMilliseconds === "number"
            ? entry.expect.withinMilliseconds
            : typeof entry.expect.withinMillisecondsOfSecond === "number"
              ? entry.expect.withinMillisecondsOfSecond
              : undefined;
        if (bound !== undefined)
          expect(observed.exitedAt - sent).toBeLessThanOrEqual(
            bound + tolerance,
          );
        if (typeof entry.expect.emergencyWrites === "number")
          expect(
            observed.ledger.filter((line) => line.startsWith("emergency"))
              .length,
          ).toBe(entry.expect.emergencyWrites);
      }
      // The owned TERM-ignoring child is gone: a forced kill was attempted.
      expect(await goneWithin(child ?? 0, 300)).toBe(true);
    } finally {
      kill(child);
      await cleanup(observed);
    }
  },
  async P09(entry) {
    if (entry.id === "P09.parent-sigkill") {
      const launched = await launchCase(entry);
      await launched.barrier("child-started");
      launched.signal("SIGKILL");
      const observed = await launched.done;
      receipt(entry, observed);
      const child = pidAfter(observed.ledger, "child-started");
      try {
        expect(observed.signal).toBe("SIGKILL");
        expect(observed.stdout.byteLength).toBe(0);
        // Excluded guarantee: the owned child survives the CLI's SIGKILL.
        await Bun.sleep(300);
        expect(alive(child ?? 0)).toBe(true);
      } finally {
        kill(child);
        await cleanup(observed);
      }
      return;
    }
    const launched = await launchCase(entry);
    const observed = await launched.done;
    const escaped = pidAfter(readLedger(launched.ledgerPath), "escaped");
    receipt(entry, observed, { escapedAlive: alive(escaped ?? 0) });
    try {
      assertEnvelope(entry, observed);
      expect(escaped).toBeNumber();
      // The escaped descendant is a survivor, recorded, never called cleaned.
      expect(alive(escaped ?? 0)).toBe(true);
    } finally {
      kill(escaped);
      await cleanup(observed);
    }
  },
  async P10(entry) {
    const launched = await launchCase(entry);
    const observed = await launched.done;
    receipt(entry, observed);
    try {
      const { result } = assertEnvelope(entry, observed);
      const command = data(result).command;
      expect(record(command)).toBe(true);
      if (!record(command)) return;
      expect(Object.keys(command).sort()).toEqual([
        "commandIdentity",
        "effectClass",
        "route",
        "summary",
      ]);
      expect(String(command.summary)).toContain(callerProgramDisclosure);
      expect(String(command.summary).toLowerCase()).toContain(
        "supplied by the caller",
      );
    } finally {
      await cleanup(observed);
    }
  },
};

describe("T2 programs add-on process cases", () => {
  for (const entry of sliceCases("programs"))
    test(
      entry.id,
      async () => {
        const check = checks[entry.family];
        if (!check) throw new Error(`No check for ${entry.family}.`);
        await check(entry);
      },
      timeout,
    );
});

describe("ProgramResult reports truncation (supporting C6, not a frozen case)", () => {
  for (const [mode, truncated] of [
    ["capture", true],
    ["timeout", false],
  ] as const)
    test(
      `P06s.output-truncated-${String(truncated)}`,
      async () => {
        const launched = await launch({
          argv: ["program", "--mode", mode, "--json"],
        });
        const observed = await launched.done;
        try {
          expect(observed.code).toBe(0);
          const envelope: unknown = JSON.parse(text(observed.stdout));
          const result = record(envelope) ? envelope.result : undefined;
          const fields = record(result) ? data(result) : {};
          expect(fields.outputTruncated).toBe(truncated);
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});
