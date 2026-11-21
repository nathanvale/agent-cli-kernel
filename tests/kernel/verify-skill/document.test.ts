import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioOf } from "../../../skills/verify-cli/helper/scenario.ts";
import { repository, skill } from "./harness.ts";

const commands = [
  "ready",
  "probe",
  "sweep",
  "findings",
  "launch",
  "drive",
  "report",
  "cleanup",
  "pending",
  "forensics",
];

function text(path: string): string {
  return readFileSync(join(skill, path), "utf8");
}

function headings(markdown: string, level: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith(`${level} `))
    .map((line) => line.slice(level.length + 1));
}

function featureFiles(): string[] {
  return [...text("features/README.md").matchAll(/\]\(([a-z-]+\.md)\)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("the skill document", () => {
  test("the skill document has pstack's shape", () => {
    const document = text("SKILL.md");
    expect(document).toContain("\nname: verify-cli\n");
    expect(headings(document, "##")).toEqual([
      "Launch",
      "Doctor",
      "Drive",
      "Evidence",
      "Cleanup",
      "Helpers",
    ]);
    expect(featureFiles()).toEqual([
      "help-and-usage.md",
      "read-only-command.md",
      "changing-command.md",
      "approval-without-state.md",
      "check-command.md",
      "forensics.md",
    ]);
    for (const file of featureFiles()) {
      const feature = text(join("features", file));
      expect(headings(feature, "#")).toHaveLength(1);
      expect(headings(feature, "##")).toEqual([
        "Sub-features",
        "How to get to it (user POV)",
        "Driving it with verify-cli",
        "Gotchas",
      ]);
    }
  });

  test("every command the documents show is one the helper declares", () => {
    const shown = [
      "SKILL.md",
      "features/README.md",
      ...featureFiles().map((file) => join("features", file)),
    ].flatMap((path) =>
      [...text(path).matchAll(/(?:verify\.ts|^\| `)\s*([a-z]+)\b/gm)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.filter((word) => !commands.includes(word))).toEqual([]);
  });

  test("every scenario a feature file shows is a valid scenario", () => {
    const blocks = featureFiles().flatMap((file) =>
      [...text(join("features", file)).matchAll(/```json\n([\s\S]*?)```/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect(blocks).toHaveLength(3);
    for (const block of blocks)
      expect(() => scenarioOf(JSON.parse(block))).not.toThrow();
  });

  test("AGENTS.md points agents to the forensics command under Checks", () => {
    const agents = readFileSync(join(repository, "AGENTS.md"), "utf8");
    expect(agents).toContain("skills/verify-cli/verify.ts forensics");
    expect(agents).toContain("skills/verify-cli/features/forensics.md");
  });
});
