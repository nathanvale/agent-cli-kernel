// Q01.d: the state add-on's test seams and internals are not host-reachable.
// A host-like probe under starters/contract3/src/handlers is linted with the
// repository configuration: importing fixture.ts or install.ts (statically
// or dynamically) is an error; importing index.ts is not.
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { caseTest } from "./harness.ts";

const root = resolve(import.meta.dir, "../../..");
const eslint = new ESLint({ cwd: root });
let probes = "";
beforeAll(async () => {
  const handlers = resolve(root, "starters/contract3/src/handlers");
  await mkdir(handlers, { recursive: true });
  probes = await mkdtemp(`${handlers}/state-seam-probes-`);
  await writeFile(`${probes}/host.ts`, "export {};\n");
});
afterAll(async () => {
  await rm(probes, { recursive: true, force: true });
});

async function banned(source: string): Promise<boolean> {
  const [result] = await eslint.lintText(source, {
    filePath: `${probes}/host.ts`,
  });
  return (result?.messages ?? []).some(
    (message) =>
      message.ruleId === "no-restricted-imports" ||
      (message.ruleId === "no-restricted-syntax" &&
        message.message.includes("state add-on")),
  );
}

caseTest("Q01.d-host-cannot-import-test-seams", async () => {
  const state = "../../addons/state";
  expect(
    await banned(
      `import { stateAddonWithTestSeams } from "${state}/fixture.ts";\nvoid stateAddonWithTestSeams;\n`,
    ),
  ).toBe(true);
  expect(
    await banned(
      `import { install } from "${state}/install.ts";\nvoid install;\n`,
    ),
  ).toBe(true);
  expect(
    await banned(
      `import { resolveQualification } from "${state}/qualification.ts";\nvoid resolveQualification;\n`,
    ),
  ).toBe(true);
  expect(
    await banned(`export const load = () => import("${state}/fixture.ts");\n`),
  ).toBe(true);
  expect(
    await banned(
      `import { stateAddon } from "${state}/index.ts";\nvoid stateAddon;\n`,
    ),
  ).toBe(false);
});
