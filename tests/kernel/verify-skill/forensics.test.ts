import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  forensicsLimits,
  forensicsSchema,
  inspectApprovalFolder,
  inspectDiagnosticsFolder,
  inspectRunFolder,
  inspectStateRoot,
  parseC3s1Records,
  runForensics,
} from "../../../skills/verify-cli/forensics.ts";
import {
  ownedFolder,
  parsed,
  readOnlyScenario,
  releaseWorlds,
  runFolder,
  scenarioFile,
  skill,
  viaKernelFreeCheck,
  watchdog,
  world,
} from "./harness.ts";

afterAll(releaseWorlds);

function encodeC3s1(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify({ ...payload, format: 1, kind }),
  );
  const hash = createHash("sha256")
    .update(`${kind}\n`)
    .update(body)
    .digest("hex");
  const header = `C3S1 ${kind} ${String(body.byteLength).padStart(10, "0")} ${hash}\n`;
  const out = new Uint8Array(header.length + body.byteLength + 1);
  out.set(new TextEncoder().encode(header), 0);
  out.set(body, header.length);
  out[out.length - 1] = 10;
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createStateTree(journal: "contract3.state" | "contract3.state.2") {
  const root = ownedFolder("forensics-state-");
  chmodSync(root, 0o700);
  mkdirSync(join(root, "coordination"), { mode: 0o700 });
  mkdirSync(join(root, "operations"), { mode: 0o700 });
  mkdirSync(join(root, "staging"), { mode: 0o700 });
  if (journal === "contract3.state.2")
    mkdirSync(join(root, "settled"), { mode: 0o700 });
  writeFileSync(join(root, "format"), encodeC3s1("format", { journal }));
  return root;
}

describe("kernel-free forensics in-process", () => {
  test("decodes clean C3S1 records, torn tails, and records hidden mid-line in torn tails", () => {
    const first = encodeC3s1("effect-started", { effect: "note.write" });
    const clean = parseC3s1Records(first);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.records).toHaveLength(1);
    expect(clean.tornTail).toBe(false);
    expect(clean.tornOffset).toBeNull();
    expect(clean.recordHiddenInTornTail).toBe(false);

    const partial = new TextEncoder().encode("C3S1 completion 0000000099");
    const torn = parseC3s1Records(concatBytes(first, partial));
    expect(torn.ok).toBe(true);
    if (!torn.ok) return;
    expect(torn.tornTail).toBe(true);
    expect(torn.tornOffset).toBe(first.byteLength);
    expect(torn.recordHiddenInTornTail).toBe(false);

    const hidden = encodeC3s1("delegate-admitted", {
      effect: "note.write",
      boot: "boot-1",
    });
    const tornWithHidden = parseC3s1Records(
      concatBytes(first, new TextEncoder().encode("torn-bytes"), hidden),
    );
    expect(tornWithHidden.ok).toBe(true);
    if (!tornWithHidden.ok) return;
    expect(tornWithHidden.tornTail).toBe(true);
    expect(tornWithHidden.recordHiddenInTornTail).toBe(true);
  });

  test("decodes a v2 state journal with torn tails, hidden mid-line records, delegate boot ids, staging residue, and closures", () => {
    const root = createStateTree("contract3.state.2");
    writeFileSync(join(root, "coordination", "admission.lock"), "");
    writeFileSync(join(root, "staging", "format-leftover"), "partial");

    const opA = "op-0000000000000000000000000000000a";
    const opADir = join(root, "operations", opA);
    mkdirSync(opADir, { mode: 0o700 });
    const intentA = encodeC3s1("intent", {
      operationId: opA,
      commandIdentity: "notes.save",
      runId: "run-a",
      effects: ["note.write"],
      scope: { resources: [], invariants: [], unknown: false, keys: ["k1"] },
      revisions: {},
      owner: { lease: "owner.lease", pid: 4242, startedAt: 1000 },
      coordination: [],
      approval: null,
      closes: null,
    });
    const delegateEvent = encodeC3s1("delegate-admitted", {
      effect: "note.write",
      boot: "boot-alpha",
    });
    const hiddenEvent = encodeC3s1("effect-confirmed", {
      effect: "note.write",
    });
    writeFileSync(join(opADir, "intent"), intentA);
    writeFileSync(
      join(opADir, "events"),
      concatBytes(delegateEvent, new TextEncoder().encode("torn"), hiddenEvent),
    );
    writeFileSync(join(opADir, "owner.lease"), "");

    const opB = "op-0000000000000000000000000000000b";
    const opBDir = join(root, "settled", opB);
    mkdirSync(opBDir, { mode: 0o700 });
    const intentB = encodeC3s1("intent", {
      operationId: opB,
      commandIdentity: "notes.save",
      runId: "run-b",
      effects: ["note.write"],
      scope: { resources: [], invariants: [], unknown: false, keys: ["k2"] },
      revisions: {},
      owner: { lease: "owner.lease", pid: 4243, startedAt: 1001 },
      coordination: [],
      approval: null,
      closes: null,
    });
    const eventsB = encodeC3s1("completion", { settledAt: 2000 });
    const revisionB = `r-${createHash("sha256").update(intentB).update("\n").update(eventsB).digest("hex")}`;
    writeFileSync(join(opBDir, "intent"), intentB);
    writeFileSync(join(opBDir, "events"), eventsB);
    writeFileSync(
      join(opBDir, "closure"),
      encodeC3s1("closure", {
        operationId: opB,
        closureId: "c-1",
        disposition: "completed",
        reason: "verified",
        evidence: [],
        journalRevision: revisionB,
        qualification: "linux-7-btrfs",
        recoveryRunId: "rec-1",
      }),
    );

    const inspected = inspectStateRoot(root);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.report.journal).toBe("contract3.state.2");
    expect(inspected.report.coordinationLocks).toEqual(["admission.lock"]);
    expect(inspected.report.stagingEntries).toEqual(["format-leftover"]);
    expect(inspected.report.status).toBe("issues");

    const caseA = inspected.report.cases.find((c) => c.operationId === opA);
    expect(caseA?.status).toBe("unresolved");
    expect(caseA?.delegateBoots).toEqual(["boot-alpha"]);
    expect(caseA?.tornTail).toBe(true);
    expect(caseA?.recordHiddenInTornTail).toBe(true);
    expect(caseA?.leasePresent).toBe(true);
    expect(caseA?.problems.some((p) => p.includes("mid-line"))).toBe(true);

    const caseB = inspected.report.cases.find((c) => c.operationId === opB);
    expect(caseB?.folder).toBe("settled");
    expect(caseB?.status).toBe("closed");
    expect(caseB?.closure.state).toBe("valid");
    expect(caseB?.closure.journalRevisionMatches).toBe(true);
    expect(caseB?.problems).toEqual([]);
  });

  test("decodes diagnostics custody locks, residue, markers, and JSONL summaries", () => {
    const dir = ownedFolder("forensics-diag-");
    chmodSync(dir, 0o700);
    const lockDir = join(dir, ".allocation-lock");
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, "owner-9876-0123456789abcdef"), "");
    mkdirSync(
      join(
        dir,
        ".allocation-lock.pending-1234-0123456789abcdef-fedcba9876543210",
      ),
      { mode: 0o700 },
    );

    const runFile = join(dir, "run-1.jsonl");
    writeFileSync(
      runFile,
      [
        JSON.stringify({ event: "started", facts: { token: "[REDACTED]" } }),
        JSON.stringify({ event: "finished", note: "[truncated: depth]" }),
      ].join("\n") + "\n",
    );
    const stats = lstatSync(runFile);
    mkdirSync(
      join(
        dir,
        `run-1.jsonl.closed-${String(stats.dev)}-${String(stats.ino)}-${String(stats.size)}`,
      ),
      { mode: 0o700 },
    );
    mkdirSync(join(dir, "ghost.jsonl.closed-1-2-3"), { mode: 0o700 });

    const inspected = inspectDiagnosticsFolder(dir);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.report.lock.present).toBe(true);
    expect(inspected.report.lock.ownerPid).toBe(9876);
    expect(inspected.report.lock.ownerHost).toBe("0123456789abcdef");
    expect(inspected.report.residue).toHaveLength(1);
    expect(inspected.report.residue[0]?.kind).toBe("pending");
    expect(inspected.report.orphanMarkers).toEqual([
      "ghost.jsonl.closed-1-2-3",
    ]);
    expect(inspected.report.files).toHaveLength(1);
    expect(inspected.report.files[0]).toMatchObject({
      file: "run-1.jsonl",
      lines: 2,
      redactedLines: 1,
      truncatedLines: 1,
      invalidJsonLines: 0,
      lastEvent: "finished",
      closedMarker: "matched",
    });
  });

  test("decodes approval consumed markers, valid and expired grants, and malformed entries", () => {
    const dir = ownedFolder("forensics-approval-");
    const key = "a".repeat(64);
    writeFileSync(
      join(dir, `${key}.consumed`),
      JSON.stringify({ operation: "op-1" }),
    );
    writeFileSync(
      join(dir, "grant-valid.json"),
      JSON.stringify({
        format: "contract3.approval-grant",
        version: 1,
        operation: "op-2",
        expiresAt: 5000,
      }),
    );
    writeFileSync(
      join(dir, "grant-expired.json"),
      JSON.stringify({
        format: "contract3.approval-grant",
        version: 1,
        operation: "op-3",
        expiresAt: 1000,
      }),
    );
    writeFileSync(join(dir, "broken.json"), "{not-json");

    const inspected = inspectApprovalFolder(dir, 2000);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.report.status).toBe("issues");
    expect(
      inspected.report.entries.find((e) => e.file === `${key}.consumed`),
    ).toMatchObject({ kind: "consumed", keyHash: key, operation: "op-1" });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-valid.json"),
    ).toMatchObject({ kind: "grant", expired: false, problems: [] });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-expired.json"),
    ).toMatchObject({ kind: "grant", expired: true });
    expect(
      inspected.report.entries.find((e) => e.file === "broken.json")?.kind,
    ).toBe("malformed");
  });

  test("enforces usage refusals (exit 2), missing or symlinked target refusals (exit 3), and bounded directory scans", () => {
    const missing = ownedFolder("forensics-missing-");
    const absent = join(missing, "does-not-exist");

    const badKind = runForensics(["unknown", absent], missing, "verify.ts");
    expect(badKind.exit).toBe(2);

    const badOption = runForensics(
      ["state", absent, "--nope"],
      missing,
      "verify.ts",
    );
    expect(badOption.exit).toBe(2);

    const help = runForensics(["--help"], missing, "verify.ts");
    expect(help.exit).toBe(0);
    expect(help.writes[0]?.text).toContain(
      "forensics <run|state|diagnostics|approval>",
    );

    const missingOut = runForensics(
      ["state", absent, "--json"],
      missing,
      "verify.ts",
    );
    expect(missingOut.exit).toBe(3);
    expect(parsed(missingOut.writes[0]?.text ?? "")).toMatchObject({
      schema: forensicsSchema,
      ok: false,
      kind: "unreadable",
    });

    const realDir = join(missing, "real");
    const linkDir = join(missing, "link");
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkDir);
    expect(inspectRunFolder(linkDir).ok).toBe(false);

    const crowded = ownedFolder("forensics-crowded-");
    for (let index = 0; index <= forensicsLimits.maxEntries; index += 1)
      writeFileSync(
        join(crowded, `${String(index).padStart(4, "0")}.txt`),
        "x",
      );
    const bounded = inspectApprovalFolder(crowded);
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.report.truncated).toBe(true);
    expect(bounded.report.entries).toHaveLength(forensicsLimits.maxEntries);
  });
});

describe("kernel-free forensics through verify.ts", () => {
  test(
    "inspects a real verification run without mutating evidence hashes and still works when agent-cli-kernel is absent",
    async () => {
      const at = world();
      const run = runFolder(at, "forensics-live");
      const scenario = scenarioFile(at, readOnlyScenario);

      expect(
        (await viaKernelFreeCheck(at, ["launch", run, at.example])).exit,
      ).toBe(0);
      expect(
        (await viaKernelFreeCheck(at, ["drive", run, scenario])).exit,
      ).toBe(0);

      const indexBefore = readFileSync(
        join(run, "evidence", "index.jsonl"),
        "utf8",
      );

      const live = await viaKernelFreeCheck(at, [
        "forensics",
        "run",
        run,
        "--json",
      ]);
      expect({ exit: live.exit, stderr: live.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const report = parsed(live.stdout);
      expect(report).toMatchObject({
        schema: forensicsSchema,
        target: "run",
        status: "clean",
        scratchPresent: true,
      });

      const indexAfter = readFileSync(
        join(run, "evidence", "index.jsonl"),
        "utf8",
      );
      expect(indexAfter).toBe(indexBefore);
      expect((await viaKernelFreeCheck(at, ["report", run])).exit).toBe(0);

      const nowhere = ownedFolder("forensics-no-kernel-");
      const carried = join(nowhere, "verify-cli");
      cpSync(skill, carried, { recursive: true });
      const carriedEntry = join(carried, "verify.ts");

      const readyWithoutKernel = await viaKernelFreeCheck(
        at,
        ["ready", at.example],
        { entry: carriedEntry },
      );
      expect(readyWithoutKernel.exit).toBe(70);

      const forensicsWithoutKernel = await viaKernelFreeCheck(
        at,
        ["forensics", "run", run, "--json"],
        { entry: carriedEntry },
      );
      expect({
        exit: forensicsWithoutKernel.exit,
        stderr: forensicsWithoutKernel.stderr,
      }).toEqual({ exit: 0, stderr: "" });
      expect(parsed(forensicsWithoutKernel.stdout)).toMatchObject({
        schema: forensicsSchema,
        target: "run",
        status: "clean",
      });
    },
    watchdog(0, 5),
  );
});
