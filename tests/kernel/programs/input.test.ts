import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  callerProgramDisclosure,
  programDetails,
  programsAddon,
} from "../../../kernel/src/addons/programs/index.ts";
import type { ProgramRequest } from "../../../kernel/src/kernel/index.ts";
import {
  cleanup,
  envelopeOf,
  exitWithin,
  launch,
  requireTools,
  resultOf,
} from "../lifecycle/harness.ts";
import {
  killMarked,
  markedPids,
  shell,
  until,
} from "../lifecycle/recording-host.ts";

const timeout = 30_000;
const inputCli = join(import.meta.dir, "fixtures/input-cli.ts");
const limitOracle = 1_048_576;
const notBytesOracle = "A program's input must be a Uint8Array.";
const overLimitOracle = `A program's input is at most ${String(limitOracle)} bytes.`;
const countBytes = '/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " \\n"';
const routes = ["inspect", "supplied"] as const;
type Route = (typeof routes)[number];

const attachedNow: { readonly killNow: () => void }[] = [];
const markers: string[] = [];
beforeAll(requireTools);
afterEach(() => {
  for (const attached of attachedNow.splice(0)) attached.killNow();
  for (const marker of markers.splice(0)) killMarked(marker);
});

function programs() {
  const attached = programsAddon().attach({
    runId: "input-run",
    commandIdentity: "rc.input",
    summary: `Component test of program input. ${callerProgramDisclosure}`,
    signal: new AbortController().signal,
  });
  attachedNow.push(attached);
  return attached.capability;
}

function sh(
  script: string,
  overrides: Partial<Omit<ProgramRequest, "executable" | "args">> = {},
): ProgramRequest {
  return shell(script, {
    timeoutMilliseconds: 10_000,
    shutdownMilliseconds: 1_000,
    ...overrides,
  });
}

function markedSleep(): { readonly marker: string; readonly script: string } {
  const marker = `FX-INPUT-MARKER-${crypto.randomUUID()}`;
  markers.push(marker);
  return {
    marker,
    script: `: ${marker}; echo started >> /dev/null; /bin/sleep 5`,
  };
}

async function refused(route: Route, request: unknown): Promise<unknown> {
  const capability = programs();
  const started: unknown = Reflect.apply(capability[route], capability, [
    request,
  ]);
  return Promise.resolve(started).then(
    () => "started",
    (error: unknown) => (error instanceof Error ? error.message : error),
  );
}

describe("a started program's input (accepted decision, Nathan, 19 November 2026; CMD-14)", () => {
  for (const route of routes) {
    test(
      `${route}: a program reads exactly the input its command supplies, then end of input`,
      async () => {
        const supplied = "line one\nsecond ✓ line\n";
        const result = await programs()[route](
          sh("/bin/cat", { input: new TextEncoder().encode(supplied) }),
        );
        expect(result.stdout).toBe(supplied);
        expect(result.exitCode).toBe(0);
        expect(programDetails(result)?.timedOut).toBe(false);
      },
      timeout,
    );

    test(
      `${route}: an input one byte over the limit is refused and starts no program`,
      async () => {
        const { marker, script } = markedSleep();
        expect(
          await refused(
            route,
            sh(script, { input: new Uint8Array(limitOracle + 1) }),
          ),
        ).toBe(overLimitOracle);
        expect(markedPids(marker)).toEqual([]);
      },
      timeout,
    );

    for (const [name, input] of [
      ["a string", "text"],
      ["a typed array of another width", new Uint16Array(2)],
    ] as const)
      test(
        `${route}: an input that is ${name} is refused and starts no program`,
        async () => {
          const { marker, script } = markedSleep();
          expect(await refused(route, { ...sh(script), input })).toBe(
            notBytesOracle,
          );
          expect(markedPids(marker)).toEqual([]);
        },
        timeout,
      );
  }

  test(
    "control: an admitted request with the marked script is seen as a process",
    async () => {
      const { marker, script } = markedSleep();
      const pending = programs()
        .inspect(sh(script, { input: new Uint8Array(1) }))
        .then(
          () => "returned",
          () => "rejected",
        );
      expect(await until(() => markedPids(marker).length > 0)).toBe(true);
      killMarked(marker);
      expect(await pending).toBe("returned");
    },
    timeout,
  );

  test(
    "a program given no input reads nothing",
    async () => {
      const result = await programs().inspect(sh(countBytes));
      expect(result.stdout).toBe("0");
      expect(result.exitCode).toBe(0);
    },
    timeout,
  );

  test(
    "an input of exactly the limit is admitted and read in full",
    async () => {
      const result = await programs().inspect(
        sh(countBytes, { input: new Uint8Array(limitOracle).fill(120) }),
      );
      expect(result.stdout).toBe(String(limitOracle));
      expect(result.exitCode).toBe(0);
    },
    timeout,
  );

  test(
    "a program that never reads its input is still stopped by its timeout",
    async () => {
      const result = await programs().inspect(
        sh("/bin/sleep 20", {
          input: new Uint8Array(limitOracle),
          timeoutMilliseconds: 300,
          shutdownMilliseconds: 500,
        }),
      );
      expect(programDetails(result)?.timedOut).toBe(true);
      expect(result.terminationConfirmed).toBe(true);
    },
    timeout,
  );

  test(
    "a program that exits without reading its input still returns its result",
    async () => {
      const result = await programs().inspect(
        sh("echo done", { input: new Uint8Array(limitOracle) }),
      );
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
      expect(programDetails(result)?.timedOut).toBe(false);
    },
    timeout,
  );

  test(
    "the input reaches the result only through what the program writes",
    async () => {
      const secret = "FX-INPUT-SECRET-MARKER";
      const input = new TextEncoder().encode(secret);
      const echoed = await programs().inspect(sh("/bin/cat", { input }));
      expect(echoed.stdout).toBe(secret);
      const kept = await programs().inspect(
        sh("/bin/cat > /dev/null; echo done", { input }),
      );
      expect(kept.stdout).toBe("done\n");
      expect(JSON.stringify(kept)).not.toContain(secret);
      expect(JSON.stringify(programDetails(kept))).not.toContain(secret);
    },
    timeout,
  );

  test(
    "a program reads its input as it was when the command asked, not as changed afterwards",
    async () => {
      const input = new Uint8Array(limitOracle).fill(97);
      const pending = programs().inspect(
        sh('/usr/bin/tr -cd a | /usr/bin/wc -c | /usr/bin/tr -d " \\n"', {
          input,
        }),
      );
      input.fill(120);
      expect((await pending).stdout).toBe(String(limitOracle));
    },
    timeout,
  );

  test(
    "a program reads the input that was checked, not a buffer grown after the check",
    async () => {
      const buffer = new ArrayBuffer(8, { maxByteLength: limitOracle + 1 });
      const input = new Uint8Array(buffer).fill(97);
      const base = sh(countBytes);
      let reads = 0;
      const request: ProgramRequest = {
        ...base,
        input,
        get args() {
          reads += 1;
          if (reads > 2) buffer.resize(limitOracle + 1);
          return base.args;
        },
      };
      const result = await programs().inspect(request);
      expect(buffer.byteLength).toBe(limitOracle + 1);
      expect(result.stdout).toBe("8");
    },
    timeout,
  );
});

describe("a started program's input through the production entry", () => {
  for (const [route, expected] of [
    ["feed", "from-command\n"],
    ["drain", "0"],
  ] as const)
    test(
      `${route}: the program reads ${JSON.stringify(expected)} while the command line tool's own stdin is held open with bytes`,
      async () => {
        const observed = await exitWithin(
          await launch({
            argv: [route, "--json"],
            script: inputCli,
            stdin: "held-open",
          }),
        );
        try {
          const result = resultOf(envelopeOf(observed.stdout));
          expect(observed.stderr.byteLength).toBe(0);
          expect(observed.code).toBe(0);
          expect(result).toMatchObject({
            commandIdentity: `pi.${route}`,
            causeCode: "SUCCESS_UNCHANGED",
            data: { stdout: expected, exitCode: 0 },
          });
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});
