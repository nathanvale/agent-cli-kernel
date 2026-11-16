// Shared assertions for the T5 process cases. Domain truth comes from the
// diagnostics-disabled twin. The status is judged here, from DIAG-2 and
// DIAG-3 as written, never by the kernel's validator or the add-on.
import { expect } from "bun:test";
import { canon, get, run, tree } from "./harness.ts";
import type { Launch, Run } from "./harness.ts";

export const machine = ["--json"] as const;

// The status the kernel wrote into the one envelope (LIFE-7 step 1).
export function statusOf(result: Run): unknown {
  return get(result.envelope, "diagnostics");
}

// DIAG-2's fields and what each may hold.
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

// The add-on's available status: exactly DIAG-2's keys, each well formed.
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

// The add-on's own unavailable status: DIAG-3's keys, and a non-empty trusted
// subset (the add-on always knows its file, closure and completeness), so it
// is never the kernel's `trusted: {}` replacement.
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

// The same argv and script on the diagnostics-disabled CLI in a fresh tree.
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
