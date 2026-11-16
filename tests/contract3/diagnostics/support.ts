// Shared assertions for the T5 process cases. Domain truth comes from the
// diagnostics-disabled or diagnostics-intact twin; the status shape is judged
// by the kernel's own validator (T1), never by the add-on.
import { expect } from "bun:test";
import { diagnostics as kernelValidStatus } from "../../../starters/contract3/src/kernel/validation/diagnostics.ts";
import { canon, get, run, tree } from "./harness.ts";
import type { Launch, Run } from "./harness.ts";

export const machine = ["--json"] as const;

// The status the kernel wrote into the one envelope (LIFE-7 step 1).
export function statusOf(result: Run): unknown {
  return get(result.envelope, "diagnostics");
}

export function expectStatusShape(status: unknown): void {
  expect(kernelValidStatus(status)).toBe(true);
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
