import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  environment,
  field,
  helperBound,
  ownedFolder,
  releaseWorlds,
  repository,
  skill,
  watchdog,
  world,
} from "./harness.ts";

afterAll(releaseWorlds);

const allowedPackages =
  /^(?:agent-cli-kernel(?:\/addons\/[a-z]+)?|bun|node:[a-z/]+)$/;

function specifiers(file: string): readonly string[] {
  return [
    ...readFileSync(file, "utf8").matchAll(
      /\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? "");
}

describe("the skill folder is self-contained", () => {
  test("every import in the skill folder names agent-cli-kernel, a runtime module, or a file inside the folder", () => {
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: skill })];
    expect(files.length).toBeGreaterThan(10);
    const outside = files.flatMap((file) =>
      specifiers(join(skill, file))
        .filter((specifier) =>
          specifier.startsWith(".")
            ? relative(
                skill,
                resolve(dirname(join(skill, file)), specifier),
              ).startsWith("..")
            : !allowedPackages.test(specifier),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(outside).toEqual([]);
  });

  test(
    "a copy of the folder runs from anywhere agent-cli-kernel resolves",
    async () => {
      const at = world();
      const elsewhere = ownedFolder("kernel-verify-skill-elsewhere-");
      mkdirSync(join(elsewhere, "node_modules"));
      symlinkSync(
        repository,
        join(elsewhere, "node_modules", "agent-cli-kernel"),
      );
      const copy = join(elsewhere, "tools", "verify-cli");
      cpSync(skill, copy, { recursive: true });
      const ran = await spawnBounded(
        [
          process.execPath,
          "--no-install",
          join(copy, "verify.ts"),
          "pending",
          "--json",
        ],
        { cwd: at.repo, env: environment(at), boundMilliseconds: helperBound },
      );
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(field(JSON.parse(ran.stdout), "result", "causeCode")).toBe(
        "SUCCESS_UNCHANGED",
      );
    },
    watchdog(1),
  );
});
