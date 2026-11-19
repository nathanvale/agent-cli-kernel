import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ownedFolders, write } from "../../support/fixture-files.ts";

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

const repository = join(import.meta.dir, "../../..");
const folder = ownedFolders();
const head = "a".repeat(40);
const earlier = "b".repeat(40);

async function commitsSteps(): Promise<Step[]> {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(repository, ".github/workflows/ci.yml")).text(),
  ) as { jobs: { commits: { steps: Step[] } } };
  return workflow.jobs.commits.steps;
}

async function checkStep(verdict: string | undefined, exit = 0) {
  const step = (await commitsSteps()).find(({ id }) => id === "check");
  if (step?.run === undefined)
    throw new Error("The commits job has no step with id check.");
  const root = folder("commits-verdict-");
  const calls = join(root, "calls");
  write(
    root,
    "tools/bun",
    `printf '%s|%s\\n' "$CHECK_COMMITS_SINCE" "$*" >> '${calls}'\nexit ${exit}\n`,
  );
  chmodSync(join(root, "tools/bun"), 0o755);
  const file = join(root, "verdict");
  if (verdict !== undefined) writeFileSync(file, `${verdict}\n`);
  const ran = Bun.spawnSync(["bash", "-e", "-c", step.run], {
    env: {
      PATH: `${join(root, "tools")}${delimiter}${process.env.PATH ?? ""}`,
      BASE: "origin/main",
      HEAD_SHA: head,
      VERDICT: file,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exit: ran.exitCode,
    stdout: ran.stdout.toString(),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    verdict: existsSync(file) ? readFileSync(file, "utf8") : undefined,
  };
}

describe("the CI commits job's verdict", () => {
  test("carries the last all-GREEN head forward only when it is a commit other than the head", async () => {
    const fresh = await checkStep(undefined);
    expect(fresh.calls).toBe("|run check:commits origin/main\n");
    expect(fresh.verdict).toBe(`${head}\n`);

    const carried = await checkStep(earlier);
    expect(carried.calls).toBe(`${earlier}|run check:commits origin/main\n`);
    expect(carried.stdout).toContain(
      "Carried forward: bbbbbbb, the last all-GREEN head of this pull request.",
    );
    expect(carried.verdict).toBe(`${head}\n`);

    for (const rerun of [head, "not a commit", earlier.toUpperCase()])
      expect((await checkStep(rerun)).calls).toBe(
        "|run check:commits origin/main\n",
      );
  });

  test("keeps the earlier verdict and fails the step when a commit is red", async () => {
    const red = await checkStep(earlier, 1);
    expect(red.exit).not.toBe(0);
    expect(red.calls).toBe(`${earlier}|run check:commits origin/main\n`);
    expect(red.verdict).toBe(`${earlier}\n`);
  });

  test("is restored before the check and saved after it, under a key of the pull request, its base and the checker's files", async () => {
    const steps = await commitsSteps();
    const at = (found: (step: Step) => boolean) => steps.findIndex(found);
    const restore =
      steps[
        at(({ uses }) => uses?.startsWith("actions/cache/restore@") === true)
      ];
    const save =
      steps[at(({ uses }) => uses?.startsWith("actions/cache/save@") === true)];
    const key = steps.find(({ id }) => id === "verdict");
    const check = steps.find(({ id }) => id === "check");

    expect(
      at(({ uses }) => uses?.startsWith("actions/cache/restore@") === true),
    ).toBeLessThan(at(({ id }) => id === "check"));
    expect(at(({ id }) => id === "check")).toBeLessThan(
      at(({ uses }) => uses?.startsWith("actions/cache/save@") === true),
    );
    expect(save?.if).toBeUndefined();
    expect(save?.with?.key).toBe(restore?.with?.key);
    expect(restore?.with?.key).toBe(
      "${{ steps.verdict.outputs.key }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(restore?.with?.["restore-keys"]).toBe(
      "${{ steps.verdict.outputs.key }}-",
    );
    expect(key?.env).toEqual({
      NUMBER: "${{ github.event.pull_request.number }}",
      BASE_REF: "${{ github.base_ref }}",
      CHECKER:
        "${{ hashFiles('.github/workflows/ci.yml', 'scripts/**', 'package.json', 'bun.lock', 'repository.json') }}",
    });
    expect(key?.run).toBe(
      'echo "key=commits-verdict-$NUMBER-$BASE_REF-$CHECKER" >> "$GITHUB_OUTPUT"',
    );
    expect(check?.env).toEqual({
      BASE: "origin/${{ github.base_ref }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      VERDICT: "${{ runner.temp }}/verdict",
    });
  });
});
