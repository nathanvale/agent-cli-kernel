import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import {
  checkEntry,
  helperEntry,
  parsed,
  repository,
  skill,
} from "./harness.ts";

const eslint = new ESLint({ cwd: repository });

async function ruleIds(filePath: string, extra: string): Promise<string[]> {
  const source = `${readFileSync(filePath, "utf8")}\n${extra}\n`;
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).map((message) => String(message.ruleId));
}

describe("the lint on the skill folder", () => {
  test("the consumer lint covers the helper", async () => {
    expect(await ruleIds(helperEntry, "")).toEqual([]);
    expect(await ruleIds(helperEntry, 'void Bun.spawn(["true"]);')).toContain(
      "no-restricted-properties",
    );
    expect(
      await ruleIds(
        join(skill, "helper", "place.ts"),
        'process.stdout.write("x");',
      ),
    ).toContain("repository/no-domain-output");
  }, 60_000);

  test("the kernel-free check may start its children and write its streams, and nothing more", async () => {
    expect(await ruleIds(checkEntry, "")).toEqual([]);
    expect(
      await ruleIds(
        checkEntry,
        "const made = { stateAddon: 1 }.stateAddon;\nvoid made;",
      ),
    ).toContain("no-restricted-properties");
  }, 60_000);

  for (const [shape, line] of [
    ["a static import", 'import "agent-cli-kernel";'],
    ["a dynamic import", 'void import("agent-cli-kernel/addons/programs");'],
    ["a re-export", 'export { command } from "agent-cli-kernel";'],
    ["an export of everything", 'export * from "agent-cli-kernel";'],
  ] as const) {
    test(`the kernel-free check may not import the kernel: ${shape}`, async () => {
      expect(await ruleIds(checkEntry, line)).toContain(
        "kernel-free/no-kernel-import",
      );
    }, 60_000);

    test(`the forensic command may not import the kernel: ${shape}`, async () => {
      expect(await ruleIds(join(skill, "forensics.ts"), line)).toContain(
        "kernel-free/no-kernel-import",
      );
    }, 60_000);
  }

  test("the forensic command passes lint cleanly", async () => {
    expect(await ruleIds(join(skill, "forensics.ts"), "")).toEqual([]);
  }, 60_000);

  test("the lint's recorded hits hold no file under the skill folder", () => {
    const recorded = parsed(
      readFileSync(join(repository, "eslint-suppressions.json"), "utf8"),
    );
    expect(typeof recorded).toBe("object");
    const paths =
      typeof recorded === "object" && recorded !== null
        ? Object.keys(recorded)
        : [];
    expect(paths.filter((path) => path.startsWith("skills/"))).toEqual([]);
  });
});
