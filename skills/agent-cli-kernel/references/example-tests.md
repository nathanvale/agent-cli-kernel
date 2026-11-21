# Example CLI tests

These are the tests for `moons` from [example](example.md): in-process tests
for each command and station, and real-process tests through `src/cli.ts`.

This document is written from those files, so copy from it freely. Paths are
from the root of your repository.

## `tests/commands.test.ts`

```ts
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInProcess } from "agent-cli-kernel";
import { moonsCli } from "../src/commands.ts";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function moonsIn(home: string, opener: string) {
  const cli = moonsCli(home, opener);
  const run = runInProcess(cli.contract, cli.setup);
  return async (argv: readonly string[]) => {
    const ran = await run(argv);
    if (ran.kind !== "envelope")
      throw new Error(`Expected an envelope, got ${ran.kind}.`);
    return ran.envelope.result;
  };
}

function newHome() {
  const home = mkdtempSync(join(tmpdir(), "moons-"));
  homes.push(home);
  return home;
}

const resultOf = moonsIn(newHome(), "/usr/bin/true");

test("list returns every planet, or only those with enough moons", async () => {
  expect(await resultOf(["list"])).toMatchObject({
    exitCode: 0,
    causeCode: "SUCCESS_UNCHANGED",
    data: { planets: ["venus", "earth", "mars"] },
  });
  expect(await resultOf(["list", "--at-least", "2"])).toMatchObject({
    data: { planets: ["mars"] },
  });
});

test("show returns a known planet's moons", async () => {
  expect(await resultOf(["show", "mars"])).toMatchObject({
    exitCode: 0,
    causeCode: "SUCCESS_UNCHANGED",
    data: { planet: "mars", moons: 2 },
  });
});

test("show refuses a planet it does not know and points at list", async () => {
  expect(await resultOf(["show", "pluto"])).toMatchObject({
    exitCode: 3,
    outcome: "refused",
    causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
    data: null,
    next: { kind: "command", command: "moons.list", args: [] },
  });
});

test("visit writes the planet's page and launches the opener", async () => {
  const home = newHome();
  expect(await moonsIn(home, "/usr/bin/true")(["visit", "mars"])).toMatchObject(
    {
      exitCode: 0,
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      effects: { completed: ["planet.record", "viewer.launch"] },
    },
  );
  expect(readFileSync(join(home, "visits", "mars.txt"), "utf8")).toBe(
    "mars has 2 moons.\n",
  );
});

test("a non-zero opener fails with a handoff and leaves nothing pending, so the next visit runs", async () => {
  const home = newHome();
  const failing = moonsIn(home, "/usr/bin/false");
  expect(await failing(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "failed",
    causeCode: "DOMAIN_MOONS_VISIT_NOT_OPENED",
    transactionState: "completed",
    effects: { completed: ["planet.record", "viewer.launch"] },
    handoff: { owner: "human" },
  });
  expect(await failing(["pending"])).toMatchObject({
    data: { unfinished: [] },
  });
  expect(
    await moonsIn(home, "/usr/bin/true")(["visit", "earth"]),
  ).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
  });
});

test("an unconfirmed page skips the opener, leaves a case pending names by planet, and blocks only that planet", async () => {
  const home = newHome();
  mkdirSync(join(home, "visits"), { recursive: true });
  symlinkSync("/dev/null", join(home, "visits", "earth.txt"));
  const run = moonsIn(home, "/usr/bin/true");
  expect(await run(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "failed",
    causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
    transactionState: "unknown",
    effects: {
      completed: [],
      remaining: ["viewer.launch"],
      uncertain: ["planet.record"],
    },
  });
  expect(await run(["pending"])).toMatchObject({
    data: {
      unfinished: [
        { planet: "earth", effects: ["planet.record", "viewer.launch"] },
      ],
    },
  });
  expect(await run(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "refused",
    causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
  });
  expect(await run(["visit", "mars"])).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
  });
});
```

## `tests/cli.test.ts`

```ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

setDefaultTimeout(30_000);

function invoke(...argv: string[]) {
  const ran = Bun.spawnSync([process.execPath, cli, ...argv], {
    timeout: 20_000,
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

test("show --json writes one envelope to stdout and exits 0", () => {
  const ran = invoke("show", "mars", "--json");
  const envelope: unknown = JSON.parse(ran.stdout);
  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(envelope).toMatchObject({
    contractVersion: "3.0.0",
    result: {
      commandIdentity: "moons.show",
      causeCode: "SUCCESS_UNCHANGED",
      data: { planet: "mars", moons: 2 },
    },
  });
});

test("show without --json prints the message, then the data", () => {
  const ran = invoke("show", "mars");
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout).toBe(
    [
      "mars has 2 moons.",
      "{",
      '  "planet": "mars",',
      '  "moons": 2',
      "}",
      "",
    ].join("\n"),
  );
});

test("a refusal exits with its cause's code and writes one line to stderr", () => {
  const ran = invoke("show", "pluto");
  expect(ran.exitCode).toBe(3);
  expect(ran.stdout).toBe("");
  expect(ran.stderr).toBe(
    "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n",
  );
});

test("list runs through the real entry", () => {
  const ran = invoke("list", "--at-least", "1", "--json");
  const envelope: unknown = JSON.parse(ran.stdout);
  expect(ran.exitCode).toBe(0);
  expect(envelope).toMatchObject({
    result: { data: { planets: ["earth", "mars"] } },
  });
});
```
