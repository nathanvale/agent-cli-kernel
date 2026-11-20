import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { changing, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { callerProgramDisclosure } from "agent-cli-kernel/addons/programs";
import {
  causes,
  completedSuccess,
  noInput,
  nothingChanged,
  runArgument,
  stateStations,
  stationWords,
  targetArgument,
} from "./causes.ts";
import { at, readJsonFile } from "./json.ts";
import { failureText, refusalOf, unfinishedChange } from "./outcome.ts";
import type { State } from "./outcome.ts";
import { indexSchema, indexText, repositoryRoot, runPlace } from "./place.ts";
import type { RunRow } from "./place.ts";

const identity = "verify-cli.launch";
const gitLimits = {
  timeoutMilliseconds: 20_000,
  outputLimitBytes: 1_048_576,
  shutdownMilliseconds: 500,
} as const;

export function folderTaken(folder: string): boolean {
  if (!existsSync(folder)) return false;
  if (!statSync(folder).isDirectory()) return true;
  return readdirSync(folder).length > 0;
}

export function workTreeAbove(folder: string): string | undefined {
  let current = folder;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const pinShape = /#([0-9a-f]{40})$/;

export type PinRead =
  | { readonly kind: "pinned"; readonly commit: string }
  | { readonly kind: "unpinned"; readonly reason: string };

export function pinnedCommitOf(root: string): PinRead {
  const path = join(root, "package.json");
  const read = readJsonFile(path);
  if (read.kind === "unreadable")
    return { kind: "unpinned", reason: read.reason };
  if (read.kind === "missing")
    return { kind: "unpinned", reason: `${path} is missing` };
  const pin = at(read.value, "dependencies", "agent-cli-kernel");
  const commit = typeof pin === "string" ? pinShape.exec(pin)?.[1] : undefined;
  return commit === undefined
    ? {
        kind: "unpinned",
        reason: `${path} has no kernel pin: its agent-cli-kernel dependency names no full commit.`,
      }
    : { kind: "pinned", commit };
}

export type GitFacts =
  | {
      readonly kind: "facts";
      readonly headCommit: string | null;
      readonly uncommittedPaths: number | null;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type Ask = (args: readonly string[]) => Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

const noWorkTree = /not a git repository/;

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

export async function gitFacts(
  ask: Ask | null,
  root: string,
): Promise<GitFacts> {
  if (ask === null)
    return { kind: "facts", headCommit: null, uncommittedPaths: null };
  const head = await ask(["-C", root, "rev-parse", "HEAD"]);
  if (head.exitCode !== 0 && noWorkTree.test(head.stderr))
    return { kind: "facts", headCommit: null, uncommittedPaths: null };
  if (head.exitCode !== 0)
    return {
      kind: "failed",
      reason: `git rev-parse HEAD exited ${String(head.exitCode)}: ${firstLine(head.stderr)}`,
    };
  const status = await ask(["-C", root, "status", "--porcelain"]);
  if (status.exitCode !== 0)
    return {
      kind: "failed",
      reason: `git status --porcelain exited ${String(status.exitCode)}: ${firstLine(status.stderr)}`,
    };
  return {
    kind: "facts",
    headCommit: head.stdout.trim(),
    uncommittedPaths: status.stdout.split("\n").filter((line) => line !== "")
      .length,
  };
}

function gitAsk(
  programs: ProgramsCapability,
  git: ParsedPath | null,
): Ask | null {
  if (git === null) return null;
  return async (args) => {
    const ran = await programs.supplied({
      executable: git,
      args: [...args],
      ...gitLimits,
    });
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr };
  };
}

export type LaunchRefused = {
  readonly kind: "refused";
  readonly causeCode:
    | "DOMAIN_VERIFY_TARGET_MISSING"
    | "DOMAIN_VERIFY_RUN_EXISTS"
    | "DOMAIN_VERIFY_RUN_IN_WORK_TREE"
    | "DOMAIN_VERIFY_NO_PIN";
  readonly message: string;
};

export function launchRefusal(
  folder: string,
  target: string,
):
  | LaunchRefused
  | {
      readonly kind: "admitted";
      readonly root: string;
      readonly pinnedCommit: string;
    } {
  if (!existsSync(target))
    return {
      kind: "refused",
      causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
      message: `The target ${target} does not exist.`,
    };
  if (folderTaken(folder))
    return {
      kind: "refused",
      causeCode: "DOMAIN_VERIFY_RUN_EXISTS",
      message: `${folder} is not a new or empty folder.`,
    };
  const tree = workTreeAbove(folder);
  if (tree !== undefined)
    return {
      kind: "refused",
      causeCode: "DOMAIN_VERIFY_RUN_IN_WORK_TREE",
      message: `${folder} is inside the git work tree at ${tree}.`,
    };
  const root = repositoryRoot(target);
  if (root === undefined)
    return {
      kind: "refused",
      causeCode: "DOMAIN_VERIFY_NO_PIN",
      message: `No package.json sits at or above ${target}.`,
    };
  const pin = pinnedCommitOf(root);
  if (pin.kind === "unpinned")
    return {
      kind: "refused",
      causeCode: "DOMAIN_VERIFY_NO_PIN",
      message: pin.reason,
    };
  const pinnedCommit = pin.commit;
  return { kind: "admitted", root, pinnedCommit };
}

const refusalStations = [
  station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
    trigger: "The target's entry file does not exist.",
    repairAction: "Name the target's entry file as it is on disk.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Name the target's entry file as it is on disk.",
      },
    },
    independentObservable: `${identity}:target-missing`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_RUN_EXISTS",
    trigger: "The run's folder exists and is not empty.",
    repairAction:
      "Name a new or empty folder; a run's evidence is never reused.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Name a new or empty folder; a run's evidence is never reused.",
      },
    },
    independentObservable: `${identity}:run-exists`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_RUN_IN_WORK_TREE",
    trigger: "The run's folder is inside a git work tree.",
    repairAction:
      "Name a folder outside every git work tree, such as one under the system's temporary folder.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Name a folder outside every git work tree, such as one under the system's temporary folder.",
      },
    },
    independentObservable: `${identity}:run-in-work-tree`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_NO_PIN",
    trigger: "The target's repository has no kernel pin in its package.json.",
    repairAction:
      "Pin agent-cli-kernel to a full commit in the repository's package.json, then launch again.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Pin agent-cli-kernel to a full commit in the repository's package.json, then launch again.",
      },
    },
    independentObservable: `${identity}:no-pin`,
  }),
  station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_GIT_FAILED",
    trigger:
      "git failed for a reason other than the repository not being a work tree.",
    repairAction: "Repair what the quoted git error names, then launch again.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Repair what the quoted git error names, then launch again.",
      },
    },
    independentObservable: `${identity}:git-failed`,
  }),
] as const;

export function launchCommand(state: State, git: () => ParsedPath | null) {
  return changing({
    identity,
    route: ["launch"],
    summary: `Make a verification run in a new folder and bind it to one target: a scratch folder, an evidence folder with its index, and the helper's state. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [runArgument, targetArgument] },
    capabilities: { programs: true, diagnostics: true },
    effectClass: "repository-local",
    effects: ["run.create"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_VERIFY_RUN_HELD",
    unresolvedCaseCause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger: "The run's folders and its index exist, bound to the target.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Run ready with the target, then drive a scenario file in this run.",
          },
        },
        independentObservable: `${identity}:launched`,
      }),
      ...refusalStations,
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const place = runPlace(input.run);
      const checked = launchRefusal(input.run, input.target);
      if (checked.kind === "refused")
        return context.result(
          { commandIdentity: identity, causeCode: checked.causeCode },
          { message: checked.message, data: null, effects: nothingChanged },
        );
      const facts = await gitFacts(
        gitAsk(context.programs, git()),
        checked.root,
      );
      if (facts.kind === "failed")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_GIT_FAILED" },
          { message: facts.reason, data: null, effects: nothingChanged },
        );
      const row: RunRow = {
        schema: indexSchema,
        row: "run",
        repository: checked.root,
        target: relative(checked.root, input.target),
        pinnedCommit: checked.pinnedCommit,
        bun: Bun.version,
        platform: `${process.platform} ${process.arch}`,
        headCommit: facts.headCommit,
        uncommittedPaths: facts.uncommittedPaths,
      };
      const content = indexText([row]);
      let failure = "";
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, target: input.target },
        },
        async (transaction) => {
          await transaction.record(
            "run.create",
            async () => {
              try {
                await mkdir(place.scratch, { recursive: true });
                await mkdir(place.evidence, { recursive: true });
                await writeFile(place.index, content, { flag: "wx" });
              } catch (error) {
                failure = failureText(error);
                throw error;
              }
            },
            async () =>
              existsSync(place.scratch) &&
              (await readFile(place.index, "utf8")) === content,
          );
        },
      );
      const refused = refusalOf(outcome, input.run);
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: nothingChanged },
        );
      if (outcome.proof.transactionState !== "completed") {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Launch failed before it made anything: ${failure}`,
          `The run at ${input.run} may be half made: ${failure}`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Launched a run at ${input.run} for ${row.target} in ${row.repository}.`,
          data: { ...row },
          transaction: outcome.proof,
        },
      );
    },
  });
}
