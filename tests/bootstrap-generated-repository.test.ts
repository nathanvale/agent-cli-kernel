import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapCliFixture,
  invoke,
  requireSuccess,
  runIn,
} from "./support/bootstrap-cli-fixture.ts";

const temporaryRoot = bootstrapCliFixture();

test("domain loading failures preserve help, discovery and unrelated commands", async () => {
  const root = temporaryRoot();
  const destination = join(root, "domains");
  requireSuccess(
    invoke(
      "--profile",
      "scratch",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "generate domain specimen",
  );
  await writeFile(
    join(destination, "src/domains/status.ts"),
    'throw new Error("provider configuration unavailable");\nexport function inspectStatus(): never { throw new Error("unavailable"); }\n',
  );
  for (const args of [
    ["--help", "--json"],
    ["--discover", "--json"],
    ["template", "info", "--json"],
  ]) {
    const result = runIn(
      destination,
      ["run", "--silent", "start", "--", ...args],
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }
  const unavailable = runIn(
    destination,
    ["run", "--silent", "start", "--", "status", "--json"],
    {},
  );
  expect(unavailable.exitCode).toBe(1);
  expect(unavailable.stderr).toBe("");
  expect(JSON.parse(unavailable.stdout)).toMatchObject({
    result: {
      commandIdentity: "example.status",
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      transactionState: "unchanged",
    },
  });
});

test("lint, local rules, formatting and native type errors fail independent read-only checks", async () => {
  const root = temporaryRoot();
  const destination = join(root, "gates");
  requireSuccess(
    invoke(
      "--profile",
      "durable",
      "--starter",
      "simple",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "generate gate specimen",
  );
  requireSuccess(
    runIn(destination, ["install", "--frozen-lockfile"], {}),
    "install gate specimen",
  );
  requireSuccess(
    runIn(destination, ["run", "lint"], {}),
    "positive lint and local rule control",
  );
  const path = join(destination, "src/domains/status.ts");
  const original = await readFile(path, "utf8");
  const mutations = [
    {
      source: original + '\nprocess.stdout.write("forbidden");\n',
      phase: "lint",
      diagnostic: "repository/no-domain-output",
    },
    {
      source: original + "\nexport const unsafe: any = 1;\n",
      phase: "lint",
      diagnostic: "@typescript-eslint/no-explicit-any",
    },
    {
      source: original + "\n\n",
      phase: "format:check",
      diagnostic: "Formatter would have printed",
    },
    {
      source: "export function inspectStatus(): string {\n  return 42;\n}\n",
      phase: "typecheck",
      diagnostic: "TS2322",
    },
  ];
  for (const mutation of mutations) {
    await writeFile(path, mutation.source);
    const result = runIn(destination, ["run", "check"], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      `script "${mutation.phase}" exited with code 1`,
    );
    expect(result.stdout + result.stderr).toContain(mutation.diagnostic);
    expect(await readFile(path, "utf8")).toBe(mutation.source);
  }
}, 120_000);
