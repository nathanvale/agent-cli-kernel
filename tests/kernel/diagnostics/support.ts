import { expect } from "bun:test";
import { nodeIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import { createDiagnostics } from "../../../kernel/src/addons/diagnostics/run.ts";
import { canon, get, run, tree } from "./harness.ts";
import type { Launch, Run, Tree } from "./harness.ts";

export const machine = ["--json"] as const;
export const fixtureChildBound = 20_000;

export function attachedIn(where: Tree) {
  const runId = crypto.randomUUID();
  const attached = createDiagnostics(
    { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
    nodeIo,
  ).attach({
    runId,
    commandIdentity: "dxs.read",
    summary: "In-process run.",
    signal: new AbortController().signal,
  });
  return { runId, attached };
}

export function statusOf(result: Run): unknown {
  return get(result.envelope, "diagnostics");
}

const factNames = [
  "closed",
  "countsComplete",
  "droppedRecords",
  "file",
  "sinkFailure",
  "truncatedRecords",
  "unflushedRecords",
];
const failures = ["capacity", "setup", "write", "flush-timeout", "close"];

function factHolds(name: string, value: unknown): boolean {
  switch (name) {
    case "file":
      return (
        value === null || (typeof value === "string" && value.startsWith("/"))
      );
    case "sinkFailure":
      return (
        value === null ||
        (typeof value === "string" && failures.includes(value))
      );
    case "droppedRecords":
    case "unflushedRecords":
    case "truncatedRecords":
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      );
    case "countsComplete":
    case "closed":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function factsHold(value: unknown, names: readonly string[]): void {
  for (const name of names)
    expect([name, factHolds(name, get(value, name))]).toEqual([name, true]);
}

export function expectAvailable(status: unknown): void {
  expect(get(status, "status")).toBe("available");
  expect(Object.keys(status ?? {}).sort()).toEqual(
    ["status", ...factNames].sort(),
  );
  factsHold(status, factNames);
  expect(
    get(status, "sinkFailure") === "flush-timeout" &&
      get(status, "closed") === true,
  ).toBe(false);
}

export function expectUnavailable(
  status: unknown,
  reason: "status-invalid" | "status-unavailable",
): void {
  expect(get(status, "status")).toBe("unavailable");
  expect(Object.keys(status ?? {}).sort()).toEqual([
    "reason",
    "status",
    "trusted",
  ]);
  expect(get(status, "reason")).toBe(reason);
  const trusted = get(status, "trusted");
  const names = Object.keys(trusted ?? {});
  expect(names).toContain("file");
  expect(names).toContain("closed");
  expect(names.every((name) => factNames.includes(name))).toBe(true);
  factsHold(trusted, names);
}

export function expectSuccess(result: Run, commandIdentity = "dxs.read"): void {
  expect(result.signal).toBeNull();
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(get(result.envelope, "result", "outcome")).toBe("success");
  expect(get(result.envelope, "result", "commandIdentity")).toBe(
    commandIdentity,
  );
  expect(get(result.envelope, "result", "causeCode")).toBe("SUCCESS_UNCHANGED");
}

async function disabledTwin(
  launch: Pick<Launch, "argv" | "script" | "env">,
): Promise<Run> {
  return run({ ...launch, tree: tree(), bare: true });
}

export async function expectTwinEqual(
  result: Run,
  launch: Pick<Launch, "argv" | "script" | "env">,
): Promise<void> {
  const twin = await disabledTwin(launch);
  expect(twin.exit).toBe(0);
  expect(canon(result.envelope)).toBe(canon(twin.envelope));
  expect(result.exit).toBe(twin.exit);
  expect(result.stderr).toBe(twin.stderr);
}
