import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  programDetails,
  programsAddon,
} from "../../../kernel/src/addons/programs/index.ts";
import {
  cleanup,
  envelopeOf,
  exitWithin,
  launch,
  resultOf,
} from "../lifecycle/harness.ts";
import { shell } from "../lifecycle/recording-host.ts";
import { testFolder } from "../../support/test-folder.ts";

const timeout = 30_000;
const inputCli = join(import.meta.dir, "fixtures/input-cli.ts");
const inputLimit = 1_048_576;
const refusal = `A program's input is a Uint8Array of at most ${String(inputLimit)} bytes.`;
const count = '/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " \\n"';

function programs() {
  return programsAddon().attach({
    runId: "input-run",
    commandIdentity: "rc.input",
    summary: "Component test of program input.",
    signal: new AbortController().signal,
  }).capability;
}

async function refused(request: unknown): Promise<unknown> {
  const started: unknown = Reflect.apply(programs().inspect, undefined, [
    request,
  ]);
  return Promise.resolve(started).then(
    () => "started",
    (error: unknown) => (error instanceof Error ? error.message : error),
  );
}

describe("a started program's input (accepted decision, Nathan, 19 November 2026; CMD-14)", () => {
  test(
    "a program reads exactly the input its command supplies, then end of input",
    async () => {
      const supplied = "line one\nsecond ✓ line\n";
      const result = await programs().inspect(
        shell("/bin/cat", { input: new TextEncoder().encode(supplied) }),
      );
      expect(result.stdout).toBe(supplied);
      expect(result.exitCode).toBe(0);
      expect(programDetails(result)?.timedOut).toBe(false);
    },
    timeout,
  );

  test(
    "a program given no input reads nothing",
    async () => {
      const result = await programs().inspect(shell(count));
      expect(result.stdout).toBe("0");
      expect(result.exitCode).toBe(0);
    },
    timeout,
  );

  test(
    "an input of exactly the limit is admitted and read in full",
    async () => {
      const result = await programs().inspect(
        shell(count, { input: new Uint8Array(inputLimit).fill(120) }),
      );
      expect(result.stdout).toBe(String(inputLimit));
      expect(result.exitCode).toBe(0);
    },
    timeout,
  );

  test(
    "an input one byte over the limit is refused and starts no program",
    async () => {
      const dir = testFolder("kernel-input-");
      const started = join(dir, "started");
      try {
        expect(
          await refused(
            shell(`echo started > '${started}'`, {
              input: new Uint8Array(inputLimit + 1),
            }),
          ),
        ).toBe(refusal);
        expect(existsSync(started)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout,
  );

  for (const [name, input] of [
    ["a string", "text"],
    ["a typed array of another width", new Uint16Array(2)],
  ] as const)
    test(
      `an input that is ${name} is refused and starts no program`,
      async () => {
        const dir = testFolder("kernel-input-");
        const started = join(dir, "started");
        try {
          expect(
            await refused({ ...shell(`echo started > '${started}'`), input }),
          ).toBe(refusal);
          expect(existsSync(started)).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      timeout,
    );

  test(
    "a program reads its input as it was when the command asked, not as changed afterwards",
    async () => {
      const input = new Uint8Array(inputLimit).fill(97);
      const pending = programs().inspect(
        shell('/usr/bin/tr -d a | /usr/bin/wc -c | /usr/bin/tr -d " \\n"', {
          input,
        }),
      );
      input.fill(120);
      expect((await pending).stdout).toBe("0");
    },
    timeout,
  );

  test(
    "a program that never reads its input is still stopped by its timeout",
    async () => {
      const result = await programs().inspect(
        shell("exec /bin/sleep 30", {
          input: new Uint8Array(inputLimit),
          timeoutMilliseconds: 300,
          shutdownMilliseconds: 500,
        }),
      );
      const detail = programDetails(result);
      expect(detail?.timedOut).toBe(true);
      expect(result.terminationConfirmed).toBe(true);
    },
    timeout,
  );

  test(
    "a program that exits without reading its input still returns its result",
    async () => {
      const result = await programs().inspect(
        shell("echo done", { input: new Uint8Array(inputLimit) }),
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
      const echoed = await programs().inspect(shell("/bin/cat", { input }));
      expect(echoed.stdout).toBe(secret);
      const kept = await programs().inspect(
        shell("/bin/cat > /dev/null; echo done", { input }),
      );
      expect(kept.stdout).toBe("done\n");
      expect(JSON.stringify(kept)).not.toContain(secret);
      expect(JSON.stringify(programDetails(kept))).not.toContain(secret);
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
