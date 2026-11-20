import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { spawnBounded } from "../../support/process.ts";

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const root = resolve(import.meta.dir, "../../..");
const workflow = Bun.YAML.parse(
  await Bun.file(join(root, ".github/workflows/ci.yml")).text(),
) as Workflow;
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (found === undefined) throw new Error(`ci.yml has no job ${name}.`);
  return found;
};

describe("the carried verdict in ci.yml", () => {
  test("only commits-token can mint an OIDC token", () => {
    const minting = Object.entries(workflow.jobs)
      .filter(([, each]) => each.permissions?.["id-token"] !== undefined)
      .map(([name, each]) => [name, each.permissions?.["id-token"]]);

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(minting).toEqual([["commits-token", "write"]]);
  });

  test("commits-token runs only after commits passed, and runs no repository code", () => {
    const token = job("commits-token");

    expect(token.needs).toBe("commits");
    expect(token.if).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    expect(token.permissions).toEqual({ "id-token": "write" });
    expect(token.steps.map((step) => step.uses ?? "run")).toEqual([
      "run",
      "actions/cache/save@v4",
    ]);
  });

  test("commits-cache restores the token with no permissions, no checkout and no repository code", () => {
    const cache = job("commits-cache");

    expect(cache.permissions).toEqual({});
    expect(cache.steps.map((step) => step.uses ?? "run")).toEqual([
      "actions/cache/restore@v4",
      "run",
    ]);
    expect(cache.outputs).toEqual({
      "token-hex": "${{ steps.token.outputs.token-hex }}",
    });
  });

  test("commits-carry reads the token as a string and never restores a cache", () => {
    const carry = job("commits-carry");

    expect(carry.needs).toBe("commits-cache");
    expect(
      carry.steps.some((step) => step.uses?.startsWith("actions/cache")),
    ).toBe(false);
    expect(carry.steps.at(-1)).toMatchObject({
      env: {
        CARRIED_TOKEN_HEX: "${{ needs.commits-cache.outputs.token-hex }}",
      },
      run: "bun --no-install scripts/carried-verdict.ts",
    });
  });

  test("the commits-shard jobs judge from the base and carried head that commits-carry chose", () => {
    const shard = job("commits-shard");

    expect(shard.needs).toBe("commits-carry");
    expect(shard.steps.at(-1)?.env).toEqual({
      BASE: "${{ needs.commits-carry.outputs.base }}",
      CHECK_COMMITS_SINCE: "${{ needs.commits-carry.outputs.since }}",
    });
  });

  test("commits fails unless commits-carry and every commits-shard job passed", () => {
    const commits = job("commits");

    expect(commits.needs).toEqual(["commits-carry", "commits-shard"]);
    expect(commits.steps[0]?.env).toEqual({
      CARRY: "${{ needs.commits-carry.result }}",
      SHARDS: "${{ needs.commits-shard.result }}",
    });
  });

  test("commits runs even when a part failed or was skipped, so it can fail", () => {
    expect(job("commits").if).toMatch(/^always\(\) && /);
  });

  test("the commits gate passes only when commits-carry and the parts both succeeded", async () => {
    const script = job("commits").steps[0]?.run ?? "";
    const exits = [];
    for (const [carry, shards] of [
      ["success", "success"],
      ["failure", "success"],
      ["success", "failure"],
      ["skipped", "success"],
      ["success", "cancelled"],
    ])
      exits.push(
        (
          await spawnBounded(["bash", "-e", "-c", script], {
            env: { PATH: process.env.PATH, CARRY: carry, SHARDS: shards },
          })
        ).exit,
      );

    expect(exits).toEqual([0, 1, 1, 1, 1]);
  });

  test("every job that runs Bun for commits turns off the setup-bun binary cache", () => {
    const uncached = ["commits-carry", "commits-shard"].map(
      (name) =>
        job(name).steps.find((step) =>
          step.uses?.startsWith("oven-sh/setup-bun"),
        )?.with?.["no-cache"],
    );

    expect(uncached).toEqual([true, true]);
  });
});
