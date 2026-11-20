import { join } from "node:path";
import { command, station } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { callerProgramDisclosure } from "agent-cli-kernel/addons/programs";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  targetArgument,
  unchangedSuccess,
} from "./causes.ts";
import { at, readJsonFile } from "./json.ts";
import {
  discoveryProbe,
  probeResult,
  probeArgvs,
  repositoryRoot,
  usageProbe,
} from "./place.ts";
import { envelopeOf, ownCommands, targetDrive } from "./target.ts";
import type { Drive, Listed, Ran } from "./target.ts";

const readyIdentity = "verify-cli.ready";
const probeIdentity = "verify-cli.probe";
const quoteLimit = 300;
const usageLine =
  /^[^\n]+ \[(USAGE_UNKNOWN_COMMAND|USAGE_INVALID_INVOCATION)\]\n$/;

export function quotedLine(stderr: string): string {
  const lines = stderr.split("\n");
  const line =
    lines.find((entry) => entry.startsWith("error: ")) ??
    lines.find((entry) => entry.trim() !== "") ??
    "";
  return line.slice(0, quoteLimit);
}

export type ToolchainPin =
  | { readonly kind: "none" }
  | { readonly kind: "pinned"; readonly version: string }
  | { readonly kind: "unreadable"; readonly reason: string };

export function toolchainBun(root: string | undefined): ToolchainPin {
  if (root === undefined) return { kind: "none" };
  const read = readJsonFile(join(root, "package.json"));
  if (read.kind === "unreadable")
    return { kind: "unreadable", reason: read.reason };
  const manager =
    read.kind === "read" ? at(read.value, "packageManager") : null;
  return typeof manager === "string" && manager.startsWith("bun@")
    ? { kind: "pinned", version: manager.slice("bun@".length) }
    : { kind: "none" };
}

export type Readiness =
  | { readonly kind: "not-started"; readonly message: string }
  | {
      readonly kind: "judged";
      readonly failed: readonly string[];
      readonly contractVersion: string | null;
      readonly commands: readonly Listed[];
    };

export function readiness(
  usage: Ran,
  discovery: Ran,
  pinnedBun: ToolchainPin,
  runningBun: string,
): Readiness {
  const envelope = envelopeOf(discovery.stdout);
  const usageAnswered = usageLine.test(usage.stderr);
  if (!usageAnswered && envelope === null)
    return {
      kind: "not-started",
      message: `The target did not start: its usage probe exited ${String(usage.exitCode)}, and its discovery probe wrote no envelope. Its first error: ${quotedLine(usage.stderr)}`,
    };
  const commands = ownCommands(envelope).own;
  const checks: readonly [string, boolean][] = [
    [
      "bun-matches-toolchain-pin",
      pinnedBun.kind === "none" ||
        (pinnedBun.kind === "pinned" && pinnedBun.version === runningBun),
    ],
    ["usage-probe-exit", usage.exitCode === 2],
    ["usage-probe-stdout-empty", usage.stdout === ""],
    ["usage-probe-one-stderr-line", usageAnswered],
    ["discovery-exit", discovery.exitCode === 0],
    ["discovery-stderr-empty", discovery.stderr === ""],
    [
      "discovery-one-envelope",
      envelope !== null && at(envelope, "result", "exitCode") === 0,
    ],
    ["discovery-has-host-command", commands.length > 0],
  ];
  const version = at(envelope, "contractVersion");
  return {
    kind: "judged",
    failed: checks.filter(([, held]) => !held).map(([id]) => id),
    contractVersion: typeof version === "string" ? version : null,
    commands,
  };
}

const readinessCheckCount = 8;

async function probesOf(drive: Drive): Promise<{ usage: Ran; discovery: Ran }> {
  return {
    usage: await drive(usageProbe),
    discovery: await drive(discoveryProbe),
  };
}

export function readyCommand(bun: () => ParsedPath) {
  return command({
    identity: readyIdentity,
    route: ["ready"],
    summary: `Check that the target starts and answers a usage refusal and discovery as the kernel promises. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [targetArgument] },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: readyIdentity,
        causeCode: unchangedSuccess,
        trigger: "Every readiness check passed.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Launch a run for this target, or sweep it.",
          },
        },
        independentObservable: `${readyIdentity}:ready`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: readyIdentity,
        causeCode: "DOMAIN_VERIFY_TARGET_START",
        trigger:
          "The target answered neither probe: no usage refusal line and no discovery envelope.",
        repairAction:
          "Read the quoted error line, repair the target or its installed kernel, then run ready again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Run the target's entry file with Bun yourself to see the whole error.",
          },
        },
        independentObservable: `${readyIdentity}:not-started`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: readyIdentity,
        causeCode: "DOMAIN_VERIFY_FINDINGS",
        trigger: "The target started, and a readiness check failed.",
        repairAction:
          "Repair each check the message names, in the target or its installed kernel, then run ready again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the failed checks; drive nothing until ready passes.",
          },
        },
        independentObservable: `${readyIdentity}:findings`,
      }),
    ],
    run: async (input, context) => {
      const { usage, discovery } = await probesOf(
        targetDrive(context.programs, bun(), input.target),
      );
      const judged = readiness(
        usage,
        discovery,
        toolchainBun(repositoryRoot(input.target)),
        Bun.version,
      );
      if (judged.kind === "not-started")
        return context.result(
          {
            commandIdentity: readyIdentity,
            causeCode: "DOMAIN_VERIFY_TARGET_START",
          },
          { message: judged.message, data: null, effects: nothingChanged },
        );
      if (judged.failed.length > 0)
        return context.result(
          {
            commandIdentity: readyIdentity,
            causeCode: "DOMAIN_VERIFY_FINDINGS",
          },
          {
            message: `${String(judged.failed.length)} of ${String(readinessCheckCount)} readiness checks failed: ${judged.failed.join(", ")}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      return context.result(
        { commandIdentity: readyIdentity, causeCode: unchangedSuccess },
        {
          message: `The target is ready: ${String(readinessCheckCount)} readiness checks passed.`,
          data: {
            contractVersion: judged.contractVersion,
            commands: judged.commands.map((entry) => ({
              commandIdentity: entry.identity,
              effectClass: entry.effectClass,
            })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}

export function probeCommand(bun: () => ParsedPath) {
  return command({
    identity: probeIdentity,
    route: ["probe"],
    summary: `Run the target's usage and discovery probes and report what the helper observed, without judging it. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [targetArgument] },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: probeIdentity,
        causeCode: unchangedSuccess,
        trigger: "Both probes ran and their observations are listed.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${probeIdentity}:observed`,
      }),
    ],
    run: async (input, context) => {
      const drive = targetDrive(context.programs, bun(), input.target);
      const probes = [];
      for (const argv of probeArgvs)
        probes.push(probeResult(argv, await drive(argv)));
      return context.result(
        { commandIdentity: probeIdentity, causeCode: unchangedSuccess },
        {
          message: `${String(probes.length)} probes observed.`,
          data: { probes },
          effects: nothingChanged,
        },
      );
    },
  });
}
