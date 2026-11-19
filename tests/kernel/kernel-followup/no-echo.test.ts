import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { humanOneLine, materialiseKf, oneEnvelope, runKf } from "./harness.ts";
import type { KfRun } from "./harness.ts";

// Accepted decision "Nine open questions answered", item 6 (ND8-4): the
// kernel never echoes an argument value in a refusal it makes itself; the
// host owns redaction of its own prose. DIAG-12, WIRE-3, WIRE-7, LIFE-2,
// LIFE-9 step 2 ("a bounded constant message, no copied bad payload").
// Built to reading (a) of N10a: the fixed messages name nothing. Every
// caller value carries a test-owned marker; no byte of stdout or stderr may
// carry it, in machine or human mode. Expected values come from
// expectations.md (KF10).
let entry = "";
beforeAll(async () => {
  entry = await materialiseKf();
});
afterAll(async () => {
  await rm(join(dirname(entry), "../../../.."), {
    recursive: true,
    force: true,
  });
});

const marker = "KF10MARK";
const carriers = (...runs: readonly KfRun[]) =>
  runs
    .flatMap((run) => [run.stdout, run.stderr])
    .filter((text) => text.includes(marker));
async function bothModes(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  const machine = await runKf(entry, "show", ["--json", ...argv], env);
  const human = await runKf(entry, "show", argv, env);
  return { machine, human };
}
function expectRefusal(
  { machine, human }: { readonly machine: KfRun; readonly human: KfRun },
  commandIdentity: string,
  causeCode: string,
  exit: number,
) {
  expect({ exit: machine.exit, one: oneEnvelope(machine) }).toEqual({
    exit,
    one: true,
  });
  expect(machine.result).toMatchObject({
    commandIdentity,
    causeCode,
    data: null,
  });
  expect({ exit: human.exit, oneLine: humanOneLine(human) }).toEqual({
    exit,
    oneLine: true,
  });
  expect(carriers(machine, human)).toEqual([]);
}

const usage = "USAGE_INVALID_INVOCATION";
const refusals: readonly (readonly [
  readonly string[],
  string,
  string,
  number,
  Readonly<Record<string, string>>?,
])[] = [
  [[marker], "kf.dispatch", "USAGE_UNKNOWN_COMMAND", 2],
  [["show", `--tokn=${marker}`], "kf.show", usage, 2],
  [["show", `--${marker}`], "kf.show", usage, 2],
  [["show", "--title", `${marker}xxxxxxxxxx`], "kf.show", usage, 2],
  [["show", "--mode", marker], "kf.show", usage, 2],
  [["show", "--count", marker], "kf.show", usage, 2],
  [["show", "--count", "99999"], "kf.show", usage, 2],
  [["show", `${marker}1`], "kf.show", usage, 2],
  [["show", "abc", marker], "kf.show", usage, 2],
  [["show", `--flag=${marker}`], "kf.show", usage, 2],
  [["show", "--title"], "kf.show", usage, 2],
  [["show", `-${marker}`], "kf.show", usage, 2],
  [["show", "--title", marker, "--count"], "kf.show", usage, 2],
  [["show", "--title", marker, "--title", marker], "kf.show", usage, 2],
  [["show", "--title", marker, "--count", "99999"], "kf.show", usage, 2],
  [["show", "--title", marker, "--mode", "c"], "kf.show", usage, 2],
  [["show", "--title", marker, "--flag", `--${marker}`], "kf.show", usage, 2],
  [["pair", marker, "--both"], "kf.pair", usage, 2],
  [["pair", marker, "--left", "--right"], "kf.pair", usage, 2],
  [["show", "--deadline-ms", marker], "kf.dispatch", usage, 2],
  [["show", "--deadline-ms", "-5"], "kf.dispatch", usage, 2],
  [
    ["--discover-command", `kf.${marker}`],
    "kf.command-discovery",
    "USAGE_UNKNOWN_COMMAND",
    2,
  ],
  [["--help", "--discover-command", marker], "kf.dispatch", usage, 2],
  [
    ["show", "--title", marker, "--deadline-ms", "50"],
    "kf.show",
    "DOMAIN_DEADLINE_BEFORE_START",
    3,
    { KF_CHECK_BLOCK: "200" },
  ],
];

describe("KF10.a no-argument-value-in-kernel-refusals", () => {
  for (const [argv, identity, causeCode, exit, env] of refusals)
    test(
      argv.some((token) => token.includes(marker))
        ? `KF10.a ${argv.join(" ")}: ${causeCode} carries no argument value`
        : `KF10.a ${argv.join(" ")}: refused ${causeCode}, exit ${exit} (no marker in argv, so no echo to detect)`,
      async () => {
        expectRefusal(await bothModes(argv, env), identity, causeCode, exit);
      },
      processWatchdog(2),
    );
  test(
    "KF10.a twin: a handler's own message carries the value, and the scan sees it",
    async () => {
      const { machine, human } = await bothModes(["show", "--title", marker]);
      expect({ machine: machine.exit, human: human.exit }).toEqual({
        machine: 0,
        human: 0,
      });
      expect(machine.envelope?.message).toBe(`Shown ${marker}.`);
      expect(carriers(machine, human)).toEqual([machine.stdout, human.stdout]);
    },
    processWatchdog(2),
  );
});

describe("KF10.b remaining-kernel-refusals-carry-no-argument", () => {
  test(
    "KF10.b approval denial: DOMAIN_AUTHORITY_REQUIRED carries no argument value",
    async () => {
      const store = join(dirname(entry), "grants-kf10");
      await mkdir(store);
      const runs = await bothModes(["show", "--title", marker], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: store,
      });
      expectRefusal(runs, "kf.show", "DOMAIN_AUTHORITY_REQUIRED", 3);
      expect(runs.machine.ledger).toContain("check-start");
    },
    processWatchdog(2),
  );
  test(
    "KF10.b approval attach fault: INTERNAL_PREPARATION carries no argument value",
    async () => {
      const runs = await bothModes(["show", "--title", marker], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: "relative/grants",
      });
      expectRefusal(runs, "kf.show", "INTERNAL_PREPARATION", 1);
    },
    processWatchdog(2),
  );
  test(
    "KF10.b fallback: a handler that throws after reading the value gets a fallback without it",
    async () => {
      const runs = await bothModes(["change", "--title", marker]);
      expectRefusal(runs, "kf.change", "INTERNAL_RESULT_UNKNOWN", 1);
      expect(runs.machine.ledger).toContain("handler-entered");
    },
    processWatchdog(2),
  );
});
