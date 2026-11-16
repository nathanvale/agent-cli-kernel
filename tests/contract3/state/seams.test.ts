// Q01.d to Q01.f: lint controls on what host source can reach. A host-like
// probe under starters/contract3/src/handlers, and existing add-on and kernel
// files given probe text, are linted with the repository configuration.
// - Q01.d: importing fixture.ts or install.ts (statically or dynamically) is
//   an error; importing index.ts is not.
// - Q01.e: the other spellings that loaded the fixture (delta review F1).
// - Q01.f: bun:ffi only in the state add-on's linux-flock.ts.
import { afterAll, beforeAll, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { caseTest } from "./harness.ts";

const root = resolve(import.meta.dir, "../../..");
const source = resolve(root, "starters/contract3/src");
const handlers = resolve(source, "handlers");
const eslint = new ESLint({ cwd: root });
let probes = "";
// F3: remove the handlers folder too when this file created it.
let createdHandlers = false;
beforeAll(async () => {
  createdHandlers = !existsSync(handlers);
  await mkdir(handlers, { recursive: true });
  probes = await mkdtemp(`${handlers}/state-seam-probes-`);
  await writeFile(`${probes}/host.ts`, "export {};\n");
});
afterAll(async () => {
  await rm(probes, { recursive: true, force: true });
  if (createdHandlers) await rmdir(handlers);
});

type Rule = "state" | "kernel" | "ffi";
const wording: Record<Rule, string> = {
  state: "state add-on",
  kernel: "Code outside the kernel",
  ffi: "bun:ffi",
};

async function messages(
  text: string,
  filePath: string,
): Promise<readonly { ruleId: string | null; message: string }[]> {
  const [result] = await eslint.lintText(text, { filePath });
  return result?.messages ?? [];
}

// True when lint reports the named ban for this text at this path.
async function banned(
  text: string,
  rule: Rule = "state",
  filePath = `${probes}/host.ts`,
): Promise<boolean> {
  return (await messages(text, filePath)).some(
    (message) =>
      (message.ruleId === "no-restricted-imports" ||
        message.ruleId === "no-restricted-syntax") &&
      message.message.includes(wording[rule]),
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

// The six spellings of the delta review (F1), each of which loaded the
// fixture at run time, plus Bun's import.meta.require; the same for the
// kernel's internals.
caseTest("Q01.e-host-cannot-reach-seams-by-other-spellings", async () => {
  const spellings = (target: string, sibling: string): string[] => [
    `const target = "${target}";\nexport const load = () => import(target);\n`,
    `export const load = () => import(\`${target}\`);\n`,
    `import { createRequire } from "node:module";\nexport const load = () => createRequire(import.meta.url)("${target}");\n`,
    `export const load = () => import.meta.require("${target}");\n`,
    `export { stateAddonWithTestSeams } from "${target.replace("/addons/", "/addons//")}";\n`,
    `export { stateAddonWithTestSeams } from "${target.replace("/addons/", "/addons/./")}";\n`,
    `export { stateAddonWithTestSeams } from "${sibling}";\n`,
  ];
  const programs = resolve(source, "addons/programs/index.ts");
  const state = spellings(
    "../../addons/state/fixture.ts",
    "../state/fixture.ts",
  );
  // The diagnostics builder's report (coordinator, 16 November 2026): the
  // internal implementation by a sibling folder's relative path; and the
  // standards review's F1: the same with a leading "./".
  state.push(
    `import { install } from "../state/install.ts";\nvoid install;\n`,
    `export { stateAddonWithTestSeams } from "./../state/fixture.ts";\n`,
    `import { install } from "./../state/install.ts";\nvoid install;\n`,
    `export const load = () => import("./../state/fixture.ts");\n`,
  );
  for (const [index, text] of state.entries())
    expect({
      index,
      banned: await banned(text, "state", index >= 6 ? programs : undefined),
    }).toEqual({ index, banned: true });
  // The diagnostics folder has its own logging override (merge of 820c5a1);
  // the sibling spellings stay banned there too.
  const diagnostics = resolve(source, "addons/diagnostics/index.ts");
  for (const [index, text] of state.slice(6).entries())
    expect({
      index,
      banned: await banned(text, "state", diagnostics),
    }).toEqual({ index, banned: true });
  const kernelTexts = [
    `const target = "../../kernel/state-seam.ts";\nexport const load = () => import(target);\n`,
    "export const load = () => import(`../../kernel/state-seam.ts`);\n",
    `export * from "../../kernel//state-seam.ts";\n`,
    `export * from "../../kernel/./state-seam.ts";\n`,
  ];
  for (const [index, text] of kernelTexts.entries()) {
    expect({ index, banned: await banned(text, "kernel") }).toEqual({
      index,
      banned: true,
    });
  }
  expect(
    await banned(
      `import { stateAddon } from "../../addons/state/index.ts";\nvoid stateAddon;\n`,
    ),
  ).toBe(false);
});

// The Linux coordination route's foreign call (Nathan, 16 November 2026,
// 14:22): bun:ffi is allowed in linux-flock.ts and banned everywhere else
// in contract source, statically and dynamically.
caseTest("Q01.f-foreign-call-confined-to-linux-route", async () => {
  const route = resolve(source, "addons/state/linux-flock.ts");
  const elsewhere = [
    `${probes}/host.ts`,
    resolve(source, "addons/state/coordination.ts"),
    resolve(source, "addons/state/install.ts"),
    resolve(source, "addons/programs/index.ts"),
    resolve(source, "addons/diagnostics/index.ts"),
    resolve(source, "kernel/index.ts"),
  ];
  const statically = `import { dlopen } from "bun:ffi";\nvoid dlopen;\n`;
  const dynamically = `export const load = () => import("bun:ffi");\n`;
  for (const filePath of elsewhere) {
    expect({
      filePath,
      banned: await banned(statically, "ffi", filePath),
    }).toEqual({ filePath, banned: true });
    expect({
      filePath,
      banned: await banned(dynamically, "ffi", filePath),
    }).toEqual({ filePath, banned: true });
  }
  // The carve-out stays narrow (standards review F3): the route file is
  // linted (not ignored), only the bun:ffi ban lifts there, and every other
  // host rule still applies to it.
  expect(await eslint.isPathIgnored(route)).toBe(false);
  expect(await banned(statically, "ffi", route)).toBe(false);
  expect(
    (
      await messages(
        `import { spawn } from "node:child_process";\nvoid spawn;\n`,
        route,
      )
    ).some((message) => message.ruleId === "no-restricted-imports"),
  ).toBe(true);
  expect(
    await banned(
      `export * from "../../kernel/state-seam.ts";\n`,
      "kernel",
      route,
    ),
  ).toBe(true);
  expect(
    await banned(
      `export const load = () => import("./../state/fixture.ts");\n`,
      "state",
      route,
    ),
  ).toBe(true);
  const [committed] = await eslint.lintFiles([route]);
  expect(committed?.errorCount).toBe(0);
});
