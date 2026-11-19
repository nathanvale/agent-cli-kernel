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
const programInputCli = join(import.meta.dir, "fixtures/program-input-cli.ts");
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
    "an input whose own byteLength is shadowed is judged by its real length",
    async () => {
      const { marker, script } = markedSleep();
      const input = Object.defineProperty(
        new Uint8Array(limitOracle + 1),
        "byteLength",
        { value: 0 },
      );
      expect(await refused("inspect", sh(script, { input }))).toBe(
        overLimitOracle,
      );
      expect(markedPids(marker)).toEqual([]);
    },
    timeout,
  );

  test(
    "an object that only inherits Uint8Array.prototype is refused",
    async () => {
      const { marker, script } = markedSleep();
      const input: unknown = Object.create(Uint8Array.prototype);
      expect(await refused("inspect", { ...sh(script), input })).toBe(
        notBytesOracle,
      );
      expect(markedPids(marker)).toEqual([]);
    },
    timeout,
  );
});

type Admission = { admitted: number; release: () => void };

function domainRoute(admission: Admission) {
  const attached = programsAddon().attach({
    runId: "input-run",
    commandIdentity: "rc.input",
    summary: "Component test of program input.",
    signal: new AbortController().signal,
  });
  attachedNow.push(attached);
  const effect = {
    runId: "input-run",
    effect: "e.input",
    admitStart: (
      _run: string,
      _effect: string,
      start: () => Promise<unknown>,
    ) => {
      admission.admitted += 1;
      return new Promise<void>((resolve) => {
        admission.release = resolve;
      }).then(start);
    },
  };
  const handle: unknown = Reflect.apply(
    attached.capability.domain,
    attached.capability,
    [effect],
  );
  return (request: unknown): Promise<unknown> => {
    const start: unknown = Reflect.get(Object(handle), "start");
    return typeof start === "function"
      ? Promise.resolve(Reflect.apply(start, handle, [request]))
      : Promise.reject(new Error("No domain start."));
  };
}

describe("a started program's input on the domain route", () => {
  test(
    "an admitted domain program reads the bytes checked before admission, though the caller changed them while admission was pending",
    async () => {
      const admission: Admission = { admitted: 0, release: () => undefined };
      const input = new TextEncoder().encode("checked");
      const pending = domainRoute(admission)(sh("/bin/cat", { input }));
      expect(admission.admitted).toBe(1);
      input.fill(120);
      admission.release();
      const result = await pending;
      expect(Reflect.get(Object(result), "stdout")).toBe("checked");
    },
    timeout,
  );

  test(
    "a domain request over the limit is refused before admission and starts no program",
    async () => {
      const admission: Admission = { admitted: 0, release: () => undefined };
      const { marker, script } = markedSleep();
      const outcome = await domainRoute(admission)(
        sh(script, { input: new Uint8Array(limitOracle + 1) }),
      ).then(
        () => "started",
        (error: unknown) => (error instanceof Error ? error.message : error),
      );
      expect(outcome).toBe(overLimitOracle);
      expect(admission.admitted).toBe(0);
      expect(markedPids(marker)).toEqual([]);
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
            script: programInputCli,
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
