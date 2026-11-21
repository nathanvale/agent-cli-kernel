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
  readBytesNoFollow,
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
    expect(caseA?.leaseFilePresent).toBe(true);
    expect(caseA?.nextAction).toContain("report command (ifNoResult)");
    expect(inspected.report.nextAction).toContain(
      "report command (ifNoResult)",
    );
    expect(inspected.report.summary).toContain("Next:");
    expect(caseA?.problems.some((p) => p.includes("mid-line"))).toBe(true);

    const caseB = inspected.report.cases.find((c) => c.operationId === opB);
    expect(caseB?.folder).toBe("settled");
    expect(caseB?.status).toBe("closed");
    expect(caseB?.closure.state).toBe("valid");
    expect(caseB?.closure.journalRevisionMatches).toBe(true);
    expect(caseB?.nextAction).toBeNull();
    expect(caseB?.problems).toEqual([]);
  });

  test("flags non-private state subfolders and records the kernel rejects", () => {
    const modeRoot = createStateTree("contract3.state.2");
    for (const sub of ["operations", "coordination", "staging"] as const) {
      chmodSync(join(modeRoot, sub), 0o777);
      const checked = inspectStateRoot(modeRoot);
      expect(checked.ok).toBe(true);
      if (checked.ok) {
        expect(checked.report.status).toBe("issues");
        expect(
          checked.report.problems.some((p) =>
            p.includes(`${sub}/ permissions/ownership failed private check`),
          ),
        ).toBe(true);
      }
      chmodSync(join(modeRoot, sub), 0o700);
    }
    const restored = inspectStateRoot(modeRoot);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.report.status).toBe("clean");

    const badRoot = createStateTree("contract3.state.2");
    const opBadClosure = "op-0000000000000000000000000000000c";
    const opBadClosureDir = join(badRoot, "operations", opBadClosure);
    mkdirSync(opBadClosureDir, { mode: 0o700 });
    const goodIntent = (id: string) =>
      encodeC3s1("intent", {
        operationId: id,
        commandIdentity: "notes.save",
        runId: `run-${id}`,
        effects: ["note.write"],
        scope: { resources: [], invariants: [], unknown: false, keys: ["k1"] },
        revisions: {},
        owner: { lease: "owner.lease", pid: 4242, startedAt: 1000 },
        coordination: [],
        approval: null,
        closes: null,
      });
    const intentC = goodIntent(opBadClosure);
    const eventsC = encodeC3s1("effect-started", { effect: "note.write" });
    const revC = `r-${createHash("sha256").update(intentC).update("\n").update(eventsC).digest("hex")}`;
    writeFileSync(join(opBadClosureDir, "intent"), intentC);
    writeFileSync(join(opBadClosureDir, "events"), eventsC);
    writeFileSync(
      join(opBadClosureDir, "closure"),
      encodeC3s1("closure", {
        operationId: opBadClosure,
        closureId: "c-missing-run",
        disposition: "completed",
        reason: "verified",
        evidence: [],
        journalRevision: revC,
        qualification: "linux-7-btrfs",
      }),
    );

    const opBadEvent = "op-0000000000000000000000000000000d";
    const opBadEventDir = join(badRoot, "operations", opBadEvent);
    mkdirSync(opBadEventDir, { mode: 0o700 });
    writeFileSync(join(opBadEventDir, "intent"), goodIntent(opBadEvent));
    writeFileSync(
      join(opBadEventDir, "events"),
      encodeC3s1("unknown-kind", { note: "bad" }),
    );

    const opBadIntent = "op-0000000000000000000000000000000e";
    const opBadIntentDir = join(badRoot, "operations", opBadIntent);
    mkdirSync(opBadIntentDir, { mode: 0o700 });
    writeFileSync(
      join(opBadIntentDir, "intent"),
      encodeC3s1("intent", { operationId: opBadIntent }),
    );
    writeFileSync(join(opBadIntentDir, "events"), new Uint8Array(0));

    const badInspected = inspectStateRoot(badRoot);
    expect(badInspected.ok).toBe(true);
    if (!badInspected.ok) return;
    const cCase = badInspected.report.cases.find(
      (c) => c.operationId === opBadClosure,
    );
    expect(cCase?.closure.state).toBe("damaged");
    expect(cCase?.status).toBe("unresolved");
    expect(cCase?.problems).toContain("closure record is damaged");
    expect(
      badInspected.report.cases.find((c) => c.operationId === opBadEvent)
        ?.status,
    ).toBe("corrupt");
    expect(
      badInspected.report.cases.find((c) => c.operationId === opBadIntent)
        ?.status,
    ).toBe("corrupt");
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
    expect(inspected.report.trustedAncestors).toBe(true);
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

    const unclosedDir = ownedFolder("forensics-diag-unclosed-");
    chmodSync(unclosedDir, 0o700);
    writeFileSync(
      join(unclosedDir, "orphan.jsonl"),
      `${JSON.stringify({ event: "started" })}\n`,
    );
    const unclosedChecked = inspectDiagnosticsFolder(unclosedDir);
    expect(unclosedChecked.ok).toBe(true);
    if (unclosedChecked.ok) {
      expect(unclosedChecked.report.status).toBe("issues");
      expect(unclosedChecked.report.summary).toContain("(1 unclosed)");
      expect(
        unclosedChecked.report.problems.some((p) =>
          p.includes("orphan.jsonl: no closed marker"),
        ),
      ).toBe(true);
    }

    const boundedDir = ownedFolder("forensics-diag-lines-");
    chmodSync(boundedDir, 0o700);
    const exactLines = Array.from(
      { length: forensicsLimits.maxDiagnosticsLines },
      () => JSON.stringify({ event: "tick" }),
    ).join("\n");
    const exactFile = join(boundedDir, "exact.jsonl");
    writeFileSync(exactFile, `${exactLines}\n`);
    const exactStats = lstatSync(exactFile);
    const exactMarker = join(
      boundedDir,
      `exact.jsonl.closed-${String(exactStats.dev)}-${String(exactStats.ino)}-${String(exactStats.size)}`,
    );
    mkdirSync(exactMarker, { mode: 0o700 });
    const exactChecked = inspectDiagnosticsFolder(boundedDir);
    expect(exactChecked.ok).toBe(true);
    if (!exactChecked.ok) return;
    expect(exactChecked.report.files[0]?.linesTruncated).toBe(false);
    expect(exactChecked.report.truncated).toBe(false);
    expect(exactChecked.report.status).toBe("clean");
    expect(exactChecked.report.summary).toContain("(0 unclosed)");

    writeFileSync(
      exactFile,
      `${exactLines}\n${JSON.stringify({ event: "over" })}\n`,
    );
    const overChecked = inspectDiagnosticsFolder(boundedDir);
    expect(overChecked.ok).toBe(true);
    if (!overChecked.ok) return;
    expect(overChecked.report.files[0]?.linesTruncated).toBe(true);
    expect(overChecked.report.truncated).toBe(true);
    expect(overChecked.report.status).toBe("issues");
  });

  test("decodes approval consumed markers, valid and expired grants, prototype keys, and malformed entries", () => {
    const dir = ownedFolder("forensics-approval-");
    const key = "a".repeat(64);
    const validGrantBase = {
      format: "contract3.approval-grant",
      version: 1,
      preview: "preview-hash",
      authority: "operator",
      resource: "note-1",
      resourceRevision: "rev-1",
      effects: ["note.write"],
    };
    writeFileSync(
      join(dir, `${key}.consumed`),
      JSON.stringify({ kind: "approval", runId: "run-1", consumedAt: 1000 }),
    );
    writeFileSync(
      join(dir, "grant-valid.json"),
      JSON.stringify({
        ...validGrantBase,
        operation: "op-2",
        expiresAt: 5000,
      }),
    );
    writeFileSync(
      join(dir, "grant-expired.json"),
      JSON.stringify({
        ...validGrantBase,
        operation: "op-3",
        expiresAt: 1000,
      }),
    );
    writeFileSync(
      join(dir, "grant-missing-fields.json"),
      JSON.stringify({
        format: "contract3.approval-grant",
        version: 1,
        operation: "op-shallow",
        expiresAt: 5000,
      }),
    );
    writeFileSync(
      join(dir, "grant-extra-key.json"),
      JSON.stringify({
        ...validGrantBase,
        operation: "op-extra",
        expiresAt: 5000,
        unexpected: true,
      }),
    );
    writeFileSync(
      join(dir, "grant-dup-effects.json"),
      JSON.stringify({
        ...validGrantBase,
        operation: "op-dup",
        effects: ["note.write", "note.write"],
        expiresAt: 5000,
      }),
    );
    writeFileSync(
      join(dir, "proto-key.json"),
      JSON.stringify({
        format: "toString",
        version: 1,
        operation: "op-4",
        expiresAt: 5000,
      }),
    );
    writeFileSync(join(dir, "broken.json"), "{not-json");

    const inspected = inspectApprovalFolder(dir, 2000);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.report.status).toBe("issues");
    expect(
      inspected.report.entries.find((e) => e.file === `${key}.consumed`),
    ).toMatchObject({ kind: "consumed", keyHash: key, operation: "run-1" });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-valid.json"),
    ).toMatchObject({ kind: "grant", expired: false, problems: [] });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-expired.json"),
    ).toMatchObject({ kind: "grant", expired: true });
    expect(
      inspected.report.entries.find(
        (e) => e.file === "grant-missing-fields.json",
      ),
    ).toMatchObject({
      kind: "malformed",
      problems: ["unrecognised or malformed approval JSON record"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-extra-key.json"),
    ).toMatchObject({
      kind: "malformed",
      problems: ["unrecognised or malformed approval JSON record"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-dup-effects.json"),
    ).toMatchObject({
      kind: "malformed",
      problems: ["unrecognised or malformed approval JSON record"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "proto-key.json"),
    ).toMatchObject({
      kind: "malformed",
      problems: ["unrecognised or malformed approval JSON record"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "broken.json")?.kind,
    ).toBe("malformed");
  });

  test("enforces usage refusals (exit 2), missing or symlinked target refusals (exit 3), and bounded directory scans", () => {
    const missing = ownedFolder("forensics-missing-");
    const absent = join(missing, "does-not-exist");

    const badKind = runForensics(["unknown", absent], missing, "verify.ts");
    expect(badKind.exit).toBe(2);
    expect(badKind.writes[0]?.stream).toBe("stderr");
    expect(badKind.writes[0]?.text).toContain(
      "forensics requires a target kind",
    );

    const missingKind = runForensics([], missing, "verify.ts");
    expect(missingKind.exit).toBe(2);
    expect(missingKind.writes[0]?.text).toContain(
      "forensics requires a target kind",
    );

    const extraArgs = runForensics(
      ["state", absent, "extra"],
      missing,
      "verify.ts",
    );
    expect(extraArgs.exit).toBe(2);
    expect(extraArgs.writes[0]?.text).toContain(
      "forensics requires a target kind",
    );

    const badOption = runForensics(
      ["state", absent, "--nope"],
      missing,
      "verify.ts",
    );
    expect(badOption.exit).toBe(2);
    expect(badOption.writes[0]?.stream).toBe("stderr");
    expect(badOption.writes[0]?.text).toContain("Unknown option --nope");

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
    expect(parsed(missingOut.writes[0]?.text ?? "")).toEqual({
      schema: forensicsSchema,
      ok: false,
      kind: "unreadable",
      message: `State root ${absent} does not exist.`,
      repair: "Pass an existing, readable directory for that forensic target.",
    });

    const realDir = join(missing, "real");
    const linkDir = join(missing, "link");
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkDir);
    expect(inspectRunFolder(linkDir)).toEqual({
      ok: false,
      reason: `Run folder ${linkDir} is not a real directory.`,
    });
    const linkRun = runForensics(
      ["run", linkDir, "--json"],
      missing,
      "verify.ts",
    );
    expect(linkRun.exit).toBe(3);
    expect(parsed(linkRun.writes[0]?.text ?? "")).toEqual({
      schema: forensicsSchema,
      ok: false,
      kind: "unreadable",
      message: `Run folder ${linkDir} is not a real directory.`,
      repair: "Pass an existing, readable directory for that forensic target.",
    });

    const regularFile = join(realDir, "sample.txt");
    writeFileSync(regularFile, "a".repeat(64));
    const exactBytes = readBytesNoFollow(regularFile, 64);
    expect(exactBytes.kind).toBe("read");
    const overBytes = readBytesNoFollow(regularFile, 63);
    expect(overBytes).toEqual({
      kind: "unreadable",
      reason: `${regularFile} is 64 bytes, over 63`,
    });

    const linkedFile = join(realDir, "sample.link");
    symlinkSync(regularFile, linkedFile);
    expect(readBytesNoFollow(linkedFile)).toEqual({
      kind: "unreadable",
      reason: `${linkedFile} is a symbolic link`,
    });

    const runWithLinkedIndex = ownedFolder("forensics-linked-index-");
    mkdirSync(join(runWithLinkedIndex, "evidence"), { mode: 0o700 });
    symlinkSync(
      regularFile,
      join(runWithLinkedIndex, "evidence", "index.jsonl"),
    );
    const linkedRunReport = inspectRunFolder(runWithLinkedIndex);
    expect(linkedRunReport.ok).toBe(true);
    if (linkedRunReport.ok) {
      expect(
        linkedRunReport.report.problems.some((problem) =>
          problem.includes("is a symbolic link"),
        ),
      ).toBe(true);
    }

    if (process.getuid?.() !== 0) {
      const locked = join(missing, "locked");
      mkdirSync(locked, { mode: 0o000 });
      try {
        expect(
          runForensics(["run", locked, "--json"], missing, "verify.ts").exit,
        ).toBe(3);
        expect(
          runForensics(["state", locked, "--json"], missing, "verify.ts").exit,
        ).toBe(3);
        expect(
          runForensics(["diagnostics", locked, "--json"], missing, "verify.ts")
            .exit,
        ).toBe(3);
        expect(
          runForensics(["approval", locked, "--json"], missing, "verify.ts")
            .exit,
        ).toBe(3);
      } finally {
        chmodSync(locked, 0o700);
      }
    }

    const crowded = ownedFolder("forensics-crowded-");
    for (let index = 0; index < forensicsLimits.maxEntries; index += 1)
      writeFileSync(
        join(crowded, `${String(index).padStart(4, "0")}.txt`),
        "x",
      );
    const exact = inspectApprovalFolder(crowded);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.report.truncated).toBe(false);
    expect(exact.report.entries).toHaveLength(forensicsLimits.maxEntries);

    writeFileSync(
      join(
        crowded,
        `${String(forensicsLimits.maxEntries).padStart(4, "0")}.txt`,
      ),
      "x",
    );
    const bounded = inspectApprovalFolder(crowded);
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.report.truncated).toBe(true);
    expect(bounded.report.entries).toHaveLength(forensicsLimits.maxEntries);

    const payloadOverhead = Buffer.byteLength(
      JSON.stringify({ note: "", format: 1, kind: "effect-started" }),
    );
    const exactPayload = encodeC3s1("effect-started", {
      note: "x".repeat(forensicsLimits.maxPayloadBytes - payloadOverhead),
    });
    const exactParsed = parseC3s1Records(exactPayload);
    expect(exactParsed.ok).toBe(true);
    if (exactParsed.ok) {
      expect(exactParsed.records).toHaveLength(1);
      expect(exactParsed.tornTail).toBe(false);
    }

    const oversized = encodeC3s1("effect-started", {
      note: "x".repeat(forensicsLimits.maxPayloadBytes - payloadOverhead + 1),
    });
    const overParsed = parseC3s1Records(oversized);
    expect(overParsed.ok).toBe(true);
    if (overParsed.ok) {
      expect(overParsed.records).toEqual([]);
      expect(overParsed.tornTail).toBe(true);
    }

    const corruptBody = concatBytes(
      new TextEncoder().encode("not-a-header\n"),
      encodeC3s1("completion", { settledAt: 1 }),
    );
    const corruptParsed = parseC3s1Records(corruptBody);
    expect(corruptParsed.ok).toBe(false);
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
      expect(readyWithoutKernel.stderr).toContain("RAW FAIL kernel-import");

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
    watchdog(0, 6),
  );
});
