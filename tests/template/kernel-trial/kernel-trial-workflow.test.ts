import { describe, expect, test } from "bun:test";
import {
  checkNames,
  jobOf,
  type Step,
  workflowFiles,
  workflowOf,
} from "../../support/workflows.ts";

const headCommit = "${{ github.event.pull_request.head.sha }}";

function pathFiltered(file: string): boolean {
  const { on } = workflowOf(file);
  return ["pull_request", "push"].some((event) => {
    const trigger = Object(on[event]) as object;
    return ["paths", "paths-ignore"].some((filter) =>
      Object.hasOwn(trigger, filter),
    );
  });
}

function stepAt(steps: readonly Step[], found: (step: Step) => boolean) {
  const index = steps.findIndex(found);
  return { index, step: steps[index] };
}

describe("the kernel trial workflow", () => {
  test("runs on every pull request, with no path filter, and on nothing else", () => {
    expect(workflowOf("kernel-trial.yml").on).toEqual({ pull_request: null });
  });

  test("its one check, kernel-trial, shares its name with no job in Hosted check, where the required checks run, so it cannot stand in for one", () => {
    expect([
      checkNames("kernel-trial.yml"),
      checkNames("ci.yml").includes("kernel-trial"),
    ]).toEqual([["kernel-trial"], false]);
  });

  test("checks out the kernel repository at the pull request's head commit and the template beside it, installs the template, then runs its kernel trial on that commit with an empty Bun cache", () => {
    const { steps } = jobOf("kernel-trial.yml", "kernel-trial");
    const checkout = (path: string) =>
      stepAt(
        steps,
        ({ uses, with: given }) =>
          uses === "actions/checkout@v4" && given?.path === path,
      );
    const kernel = checkout("agent-cli-kernel");
    const template = checkout("bun-typescript-template");
    const install = stepAt(
      steps,
      ({ run }) => run === "bun install --frozen-lockfile",
    );
    const trial = stepAt(
      steps,
      ({ run }) => run?.includes("kernel-trial") === true,
    );
    expect([kernel.step?.with, template.step?.with]).toEqual([
      {
        ref: headCommit,
        "fetch-depth": 0,
        path: "agent-cli-kernel",
        "persist-credentials": false,
      },
      {
        repository: "nathanvale/bun-typescript-template",
        path: "bun-typescript-template",
        "persist-credentials": false,
      },
    ]);
    expect([install.step, trial.step]).toMatchObject([
      { "working-directory": "bun-typescript-template" },
      {
        "working-directory": "bun-typescript-template",
        env: {
          COMMIT: headCommit,
          KERNEL: "${{ github.workspace }}/agent-cli-kernel",
          BUN_INSTALL_CACHE_DIR: "${{ runner.temp }}/kernel-trial-bun-cache",
        },
        run: 'bun run kernel-trial "$COMMIT" --kernel "$KERNEL"',
      },
    ]);
    expect([
      kernel.index >= 0 && template.index >= 0,
      Math.max(kernel.index, template.index) < install.index,
      install.index < trial.index,
    ]).toEqual([true, true, true]);
  });
});

describe("the kernel trial's result", () => {
  test("shows red when the trial fails: neither its job nor any of its steps continues on error", () => {
    const job = jobOf("kernel-trial.yml", "kernel-trial");
    expect([
      Object.hasOwn(job, "continue-on-error"),
      job.steps.filter((step) => Object.hasOwn(step, "continue-on-error"))
        .length,
    ]).toEqual([false, 0]);
  });
});

describe("required checks and path filters", () => {
  test("the workflow that runs the required checks is named Hosted check", () => {
    expect(workflowOf("ci.yml").name).toBe("Hosted check");
  });

  test("Hosted check, where the required checks run, has no path filter", () => {
    expect(pathFiltered("ci.yml")).toBe(false);
  });

  test("no workflow that has a path filter names a check as Hosted check does, because a required check that a path filter skips never reports and blocks merging", () => {
    const required = new Set(checkNames("ci.yml"));
    const filtered = workflowFiles().filter(pathFiltered);
    expect(filtered).toContain("linux-nightly.yml");
    const clashes = filtered.flatMap((file) =>
      checkNames(file)
        .filter((name) => required.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(clashes).toEqual([]);
  });
});
