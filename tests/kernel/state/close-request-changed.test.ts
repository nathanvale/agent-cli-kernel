import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  at,
  closeArgs,
  readFramed,
  json,
  makeWorld,
  str,
  supportingTest,
} from "./harness.ts";
import type { Json, World } from "./harness.ts";

const apply = (name: string) => ["apply", name, "--content", "v1", "--json"];

function caseFolder(world: World, id: string): string | undefined {
  for (const folder of ["operations", "settled"]) {
    const path = join(world.root, folder, id);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function caseBytes(world: World, id: string): Readonly<Record<string, string>> {
  const folder = caseFolder(world, id);
  if (!folder) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(folder).sort())
    out[name] = createHash("sha256")
      .update(readFileSync(join(folder, name)))
      .digest("hex");
  return out;
}

function closurePayload(world: World, id: string): Json | undefined {
  const folder = caseFolder(world, id);
  if (!folder || !existsSync(join(folder, "closure"))) return undefined;
  const [record] = readFramed(readFileSync(join(folder, "closure"))).records;
  return record ? json(record.payload) : undefined;
}

supportingTest(
  "CR01.close-request-changed-while-observer-held: a closure decides, publishes and records against the one case it leased and observed, even when the caller changes its request object while the observer is held",
  async () => {
    const world = makeWorld({ qualification: "fixture" });
    try {
      await world.killAt(apply("a"), "effect");
      await world.killAt(apply("b"), "effect");
      const byNote = (name: string) =>
        world
          .operations()
          .find((entry) =>
            str(at(entry.intent, "facts", "path")).endsWith(`/${name}`),
          )?.id ?? "";
      const leased = byNote("a");
      const other = byNote("b");
      expect(leased).not.toBe("");
      expect(other).not.toBe("");
      const leasedRevision = await world.revision(leased);
      const otherBefore = caseBytes(world, other);

      const closing = world.start(closeArgs(leased, leasedRevision), {
        SX_FAULT: "close-request-changed",
        SX_CHANGED_OPERATION: other,
        SX_BARRIER: "observer",
      });
      await closing.reached("observer");
      closing.release("observer");
      const run = await closing.done;

      const onLeased = closurePayload(world, leased);
      const onOther = closurePayload(world, other);
      const recorded = onLeased ?? onOther;
      const recovery = world
        .cases()
        .find((entry) => entry.intent.commandIdentity === "sx.close");
      expect({
        causeCode: run.result.causeCode,
        closureDestination:
          onLeased !== undefined
            ? leased
            : onOther !== undefined
              ? other
              : "none",
        recordedOperationId: recorded && at(recorded, "operationId"),
        recordedRevision: recorded && at(recorded, "journalRevision"),
        recoveryCloses: recovery && at(recovery.intent, "closes"),
        otherCaseBytes: caseBytes(world, other),
      }).toEqual({
        causeCode: "SUCCESS_COMPLETED",
        closureDestination: leased,
        recordedOperationId: leased,
        recordedRevision: leasedRevision,
        recoveryCloses: leased,
        otherCaseBytes: otherBefore,
      });
    } finally {
      world.dispose();
    }
  },
);
