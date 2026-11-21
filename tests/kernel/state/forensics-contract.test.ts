import { afterAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
  parseRecords,
  recordStartsMidLine,
} from "../../../kernel/src/addons/state/framing.ts";
import { layout, readCase } from "../../../kernel/src/addons/state/store.ts";
import {
  inspectStateRoot,
  parseC3s1Records,
} from "../../../skills/verify-cli/forensics.ts";
import { closeArgs, framed, makeWorld } from "./harness.ts";

const world = makeWorld({ qualification: "fixture" });
afterAll(() => world.dispose());
const apply = (name: string) => ["apply", name, "--content", "x", "--json"];

type CaseSummary =
  | { readonly status: string }
  | {
      readonly status: string;
      readonly revision: string | null;
      readonly eventKinds: readonly string[];
      readonly tornTail: boolean;
      readonly recordHiddenInTornTail: boolean;
      readonly closure: "absent" | "damaged" | "unreadable" | "valid";
      readonly commandIdentity: string | null;
      readonly runId: string | null;
      readonly effects: readonly string[];
      readonly ownerPid: number | null;
    };

function kernelView(id: string): CaseSummary {
  const read = readCase(layout(world.root), id);
  if (typeof read === "string") return { status: read };
  return {
    status: read.status,
    revision: read.revision,
    eventKinds: read.events.map((event) => event.kind),
    tornTail: read.tornTail,
    recordHiddenInTornTail: read.recordHiddenInTornTail,
    closure: read.closure
      ? "valid"
      : read.closureDamaged
        ? "damaged"
        : "absent",
    commandIdentity: read.intent.commandIdentity,
    runId: read.intent.runId,
    effects: read.intent.effects,
    ownerPid: read.intent.owner.pid,
  };
}

function forensicView(id: string): CaseSummary {
  const inspected = inspectStateRoot(world.root);
  if (!inspected.ok) throw new Error(inspected.reason);
  const found = inspected.report.cases.filter(
    (entry) => entry.operationId === id,
  );
  expect(found.length).toBe(1);
  const entry = found[0];
  if (!entry || entry.status === "corrupt") return { status: "corrupt" };
  return {
    status: entry.status,
    revision: entry.revision,
    eventKinds: entry.eventKinds,
    tornTail: entry.tornTail,
    recordHiddenInTornTail: entry.recordHiddenInTornTail,
    closure: entry.closure.state,
    commandIdentity: entry.commandIdentity,
    runId: entry.runId,
    effects: entry.effects,
    ownerPid: entry.ownerPid,
  };
}

function mutateBytes(
  original: Uint8Array,
  extra: Uint8Array,
  next: (bound: number) => number,
): Uint8Array {
  let bytes = original.slice();
  for (let step = next(3) + 1; step > 0; step -= 1) {
    const offset = next(bytes.length + 1);
    const kind = next(6);
    if (kind === 0) bytes = bytes.slice(0, offset);
    else if (kind === 1 && offset < bytes.length) bytes[offset] = next(256);
    else if (kind === 2)
      bytes = Uint8Array.from([
        ...bytes.slice(0, offset),
        ...extra,
        ...bytes.slice(offset),
      ]);
    else if (kind === 3)
      bytes = Uint8Array.from([
        ...bytes.slice(0, offset),
        10,
        ...bytes.slice(offset),
      ]);
    else if (kind === 4)
      bytes = Uint8Array.from([...bytes, ...original.slice(0, offset)]);
    else
      bytes = Uint8Array.from([
        ...bytes.slice(0, offset),
        ...Array.from({ length: next(40) }, () => next(256)),
      ]);
  }
  return bytes;
}

function existingFolder(id: string): string {
  for (const candidate of [
    join(world.root, "operations", id),
    join(world.root, "settled", id),
  ]) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

test("forensics and the kernel reader agree on every case the kernel wrote", async () => {
  await world.run(apply("done"));
  await world.killAt(apply("lost"), "effect");
  await world.killAt(apply("closed"), "effect");
  await world.killAt(apply("torn"), "effect");
  await world.killAt(apply("hidden"), "effect");
  const byNote = new Map(
    world
      .cases()
      .map((entry) => [JSON.stringify(entry.intent.scope), entry.id]),
  );
  const idOf = (note: string) =>
    [...byNote].find(([scope]) => scope.includes(`note:${note}"`))?.[1] ?? "";
  const closedId = idOf("closed");
  expect(
    (await world.run(closeArgs(closedId, await world.revision(closedId)))).exit,
  ).toBe(0);
  const tornEvents = join(world.root, "operations", idOf("torn"), "events");
  truncateSync(tornEvents, statSync(tornEvents).size - 9);
  appendFileSync(
    join(world.root, "operations", idOf("hidden"), "events"),
    `C3S1 torn${framed("completion", { completed: [] })}`,
  );
  const ids = world.cases().map((entry) => entry.id);
  expect(ids.length).toBeGreaterThanOrEqual(5);
  for (const id of ids)
    expect({ id, ...forensicView(id) }).toEqual({ id, ...kernelView(id) });
  const statuses = ids.map((id) => kernelView(id).status).sort();
  expect(new Set(statuses)).toEqual(
    new Set(["closed", "completed", "unresolved"]),
  );
}, 120_000);

test("both framing parsers agree on 3000 damaged copies of a real events file", () => {
  const sample = world
    .cases()
    .find((entry) => entry.events.records.length >= 3);
  if (!sample) throw new Error("no completed case to sample");
  const folder = existingFolder(sample.id);
  const original = new Uint8Array(readFileSync(join(folder, "events")));
  const extra = new TextEncoder().encode(
    framed("effect-confirmed", { effect: "note.write" }),
  );
  let seed = 0x2f6e2b1;
  const next = (bound: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % bound;
  };
  const disagreements: string[] = [];
  for (let round = 0; round < 3000; round += 1) {
    const bytes = mutateBytes(original, extra, next);
    const kernel = parseRecords(bytes);
    const forensic = parseC3s1Records(bytes);
    const k = kernel.ok
      ? {
          ok: true,
          torn: kernel.tornTail,
          hidden: kernel.tornTail && recordStartsMidLine(bytes),
          records: JSON.stringify(kernel.records),
        }
      : { ok: false };
    const f = forensic.ok
      ? {
          ok: true,
          torn: forensic.tornTail,
          hidden: forensic.recordHiddenInTornTail,
          records: JSON.stringify(forensic.records),
        }
      : { ok: false };
    if (JSON.stringify(k) !== JSON.stringify(f))
      disagreements.push(`round ${String(round)}`);
  }
  expect(disagreements).toEqual([]);
}, 120_000);
