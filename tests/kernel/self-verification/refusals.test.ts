import { describe, expect, test } from "bun:test";
import {
  featurePath,
  featureScenario,
  type OwnCli,
  ownCliFailures,
  type Ran,
} from "./self-verification.ts";
import { recordPath } from "./station-record.ts";

function envelope(data: unknown, exit = 0, extra: object = {}): Ran {
  return {
    exit,
    stdout: JSON.stringify({ message: "said", result: { data, ...extra } }),
    stderr: "",
  };
}

const repair = "mend the example.";
const listed = { command: "moons.list", cause: "SUCCESS_UNCHANGED" };
const shown = { command: "moons.show", cause: "SUCCESS_UNCHANGED" };
const owed = { command: "moons.show", cause: "DOMAIN_MOONS_UNKNOWN_PLANET" };
const reportRecord = {
  example: {
    stations: [
      { ...listed, state: "swept" },
      { ...shown, state: "driven" },
      { ...owed, state: "owed" },
    ],
  },
};
const recorded = {
  example: {
    checks: 3,
    stations: [
      { ...listed, state: "swept" },
      { ...owed, state: "owed" },
    ],
  },
};
const finding = {
  check: "run-json-stderr-empty",
  argv: ["list", "--json"],
  expected: "",
  saw: "moons: listing\n",
};
const foundLine = `example: check run-json-stderr-empty on ["list","--json"] expected "" and saw "moons: listing\\n". Repair: ${repair}`;

function swept(ran: Ran, findings?: Ran): OwnCli {
  return {
    name: "example",
    repair,
    runs: [{ command: "sweep", ran }],
    findings,
  };
}

const sweep = (data: object = {}) =>
  envelope({ checks: 3, swept: [listed], owed: [owed], ...data });

function reported(data: object, findings?: Ran): OwnCli {
  return {
    name: "example",
    repair,
    findings,
    evidence: new Map([
      [
        "show-known-planet",
        { expected: { exitCode: 0 }, observed: { exitCode: 1 } },
      ],
    ]),
    runs: [
      {
        command: "report",
        ran: envelope({
          stations: [
            { ...listed, state: "swept" },
            { ...shown, state: "driven" },
            { ...owed, state: "owed" },
          ],
          unmet: [],
          unconfirmed: [],
          findings: 0,
          ...data,
        }),
      },
    ],
  };
}

describe("self-verification refuses what verify-cli reports, each with a repair", () => {
  test("a clean sweep and a clean report pass", () => {
    expect(ownCliFailures(swept(sweep()), recorded)).toEqual([]);
    expect(ownCliFailures(reported({}), reportRecord)).toEqual([]);
  });

  test("a station the record does not list is refused, owed or swept", () => {
    const extra = { command: "moons.find", cause: "SUCCESS_UNCHANGED" };
    expect(
      ownCliFailures(
        swept(
          sweep({
            swept: [listed, extra],
            owed: [owed, { ...extra, cause: "X" }],
          }),
        ),
        recorded,
      ),
    ).toEqual([
      `example: moons.find SUCCESS_UNCHANGED is swept and ${recordPath} does not list it. Repair: if the station is new on purpose, add it to "example" with state "swept".`,
      `example: moons.find X is owed and ${recordPath} does not list it. Repair: drive it with a --json step in a scenario; if no scenario can reach it yet, add it to "example" with state "owed".`,
    ]);
  });

  test("a recorded station the run no longer reaches is refused", () => {
    expect(ownCliFailures(swept(sweep({ swept: [] })), recorded)).toEqual([
      `example: ${recordPath} lists moons.list SUCCESS_UNCHANGED as swept, and the run reached no such station. Repair: restore the command or station; if it was removed on purpose, remove the entry from "example".`,
    ]);
  });

  test("a station whose state differs from the record is refused", () => {
    expect(
      ownCliFailures(
        swept(sweep({ swept: [], owed: [owed, listed] })),
        recorded,
      ),
    ).toEqual([
      `example: moons.list SUCCESS_UNCHANGED is owed, and ${recordPath} lists it as swept. Repair: restore what made it swept; if the change is on purpose, set its state to "owed".`,
    ]);
  });

  test("a sweep whose check count differs from the record is refused", () => {
    expect(ownCliFailures(swept(sweep({ checks: 2 })), recorded)).toEqual([
      `example: the sweep ran 2 checks, and ${recordPath} says 3. Repair: if a command, input or station changed on purpose, set "checks" to 2; otherwise find the check that changed.`,
    ]);
  });

  test("a CLI the record does not name, or a station it lists twice, is refused", () => {
    expect(ownCliFailures(swept(sweep()), {})[0]).toBe(
      `example: ${recordPath} holds no "stations" list of { command, cause, state } entries for this CLI, each state one of swept, driven, owed. Repair: give "example" the stations its self-verification run reaches.`,
    );
    const twice = {
      example: {
        stations: [...recorded.example.stations, { ...owed, state: "owed" }],
      },
    };
    expect(ownCliFailures(swept(sweep()), twice)).toEqual([
      `example: ${recordPath} lists moons.show DOMAIN_MOONS_UNKNOWN_PLANET twice. Repair: keep one entry for it.`,
    ]);
  });

  test("a sweep with findings is refused, each failed check quoted with what it saw", () => {
    const failed = envelope(null, 3, { causeCode: "DOMAIN_VERIFY_FINDINGS" });
    expect(
      ownCliFailures(
        swept(failed, envelope({ findings: [finding] })),
        recorded,
      ),
    ).toEqual([
      `example: bun skills/verify-cli/verify.ts sweep exited 3: said Repair: ${repair}`,
      foundLine,
    ]);
  });

  test("a sweep that ran no check is refused", () => {
    expect(ownCliFailures(swept(sweep({ checks: 0 })), recorded)).toEqual([
      `example: the sweep ran no check. Repair: a sweep that checks nothing proves nothing; ${repair}`,
    ]);
  });

  test("a run verify-cli cannot trust is refused with its RAW FAIL lines", () => {
    expect(
      ownCliFailures(
        swept({
          exit: 70,
          stdout: "",
          stderr: "verify-cli: RAW FAIL kernel-entry: broke. Repair: mend.\n",
        }),
        recorded,
      ),
    ).toEqual([
      "example: bun skills/verify-cli/verify.ts sweep exited 70, so its run cannot be trusted: verify-cli: RAW FAIL kernel-entry: broke. Repair: mend. Repair: follow each RAW FAIL line's repair, then run this test again.",
    ]);
  });

  test("a report with findings, an unmet step, an unconfirmed end, or nothing driven is refused", () => {
    expect(
      ownCliFailures(
        reported(
          {
            findings: 2,
            unmet: [{ step: "show-known-planet", unmet: ["exitCode"] }],
            unconfirmed: ["show-known-planet"],
            stations: [{ ...owed, state: "owed" }],
          },
          envelope({ findings: [finding, finding] }),
        ),
        reportRecord,
      ),
    ).toEqual([
      `example: the sweep found 2 failed checks, each listed here; stations are compared with ${recordPath} once the sweep is clean. Repair: ${repair}`,
      `example: step show-known-planet is unmet at exitCode: expected {"exitCode":0}, observed {"exitCode":1}. Repair: make the target do what the step expects. Change the scenario in ${featurePath} only when the example's documented output changed on purpose; ${repair}`,
      "example: step show-known-planet's process end was not confirmed. Repair: make the target exit on its own within the step's limit.",
      `example: the scenario drove no station. Repair: give ${featurePath}'s scenario a met --json step.`,
      foundLine,
      foundLine,
    ]);
  });

  test("a sweep or a report missing a field it must hold is refused, never read as empty", () => {
    const missing = (command: string, name: string, kind: string) =>
      `example: bun skills/verify-cli/verify.ts ${command}'s result holds no ${name} ${kind}. Repair: run bun skills/verify-cli/verify.ts ${command} --json by hand and repair verify-cli's output; a missing ${name} never reads as empty.`;
    expect(
      ownCliFailures(
        swept(envelope({ checks: 3, swept: [listed] })),
        recorded,
      )[0],
    ).toBe(missing("sweep", "owed", "list"));
    const report = reported({});
    expect(
      ownCliFailures(
        {
          ...report,
          runs: [
            {
              command: "report",
              ran: envelope({
                stations: reportRecord.example.stations,
              }),
            },
          ],
        },
        reportRecord,
      ),
    ).toEqual([
      missing("report", "findings", "number"),
      missing("report", "unmet", "list"),
      missing("report", "unconfirmed", "list"),
    ]);
  });

  test("a failed drive still lets the report's own failures through", () => {
    const report = reported({ findings: 1 });
    expect(
      ownCliFailures(
        {
          ...report,
          runs: [{ command: "drive", ran: envelope(null, 3) }, ...report.runs],
        },
        reportRecord,
      ),
    ).toEqual([
      `example: bun skills/verify-cli/verify.ts drive exited 3: said Repair: ${repair}`,
      `example: the sweep found 1 failed check, each listed here; stations are compared with ${recordPath} once the sweep is clean. Repair: ${repair}`,
    ]);
  });

  test("the read-only feature file must show exactly one scenario", () => {
    expect(() => featureScenario("no block")).toThrow(
      `${featurePath} shows 0 scenario blocks. Repair: keep exactly one json block there, the scenario self-verification drives.`,
    );
  });
});
