import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  watch,
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
  repository,
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

function waitForFile(directory: string, file: string): Promise<void> {
  if (existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, () => {
      if (!existsSync(file)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for ${file}`));
    }, 15_000);
    if (existsSync(file)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
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
    expect(caseA?.nextAction).toContain("ifNoResult");
    expect(caseA?.nextAction).toContain("operation and its scope");
    expect(caseA?.nextAction).toContain("check the affected resource by hand");
    expect(caseA?.nextAction).toContain(
      "only if the CLI offers a close command on a host qualified for it",
    );
    expect(caseA?.nextAction).toContain("otherwise the case stays unresolved");
    expect(caseA?.nextAction).not.toContain("live locks");
    expect(inspected.report.nextAction).toBe(caseA?.nextAction ?? null);
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
      expect(unclosedChecked.report.status).toBe("unknown");
      expect(unclosedChecked.report.problems).toEqual([]);
      expect(unclosedChecked.report.files[0]?.closedMarker).toBe("absent");
      expect(unclosedChecked.report.summary).toContain(
        "(1 unclosed: may still be running or may have crashed before closing; allocation lock is released on open)",
      );
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

  test("rejects diagnostics closed markers that are not owned 0700 directories", () => {
    const setupFile = (prefix: string) => {
      const dir = ownedFolder(prefix);
      chmodSync(dir, 0o700);
      const file = join(dir, "run.jsonl");
      writeFileSync(file, `${JSON.stringify({ event: "finished" })}\n`);
      const stats = lstatSync(file);
      const marker = join(
        dir,
        `run.jsonl.closed-${String(stats.dev)}-${String(stats.ino)}-${String(stats.size)}`,
      );
      return { dir, marker };
    };

    const fileMarkerCase = setupFile("forensics-diag-file-marker-");
    writeFileSync(fileMarkerCase.marker, "");
    const fileMarkerReport = inspectDiagnosticsFolder(fileMarkerCase.dir);
    expect(fileMarkerReport.ok).toBe(true);
    if (fileMarkerReport.ok) {
      expect(fileMarkerReport.report.status).toBe("issues");
      expect(fileMarkerReport.report.files[0]?.closedMarker).toBe("mismatched");
    }

    const modeMarkerCase = setupFile("forensics-diag-mode-marker-");
    mkdirSync(modeMarkerCase.marker, { mode: 0o755 });
    chmodSync(modeMarkerCase.marker, 0o755);
    const modeMarkerReport = inspectDiagnosticsFolder(modeMarkerCase.dir);
    expect(modeMarkerReport.ok).toBe(true);
    if (modeMarkerReport.ok) {
      expect(modeMarkerReport.report.status).toBe("issues");
      expect(modeMarkerReport.report.files[0]?.closedMarker).toBe("mismatched");
    }

    const linkMarkerCase = setupFile("forensics-diag-link-marker-");
    const targetDir = ownedFolder("forensics-diag-link-target-");
    chmodSync(targetDir, 0o700);
    symlinkSync(targetDir, linkMarkerCase.marker);
    const linkMarkerReport = inspectDiagnosticsFolder(linkMarkerCase.dir);
    expect(linkMarkerReport.ok).toBe(true);
    if (linkMarkerReport.ok) {
      expect(linkMarkerReport.report.status).toBe("issues");
      expect(linkMarkerReport.report.files[0]?.closedMarker).toBe("mismatched");
    }

    const validMarkerCase = setupFile("forensics-diag-valid-marker-");
    mkdirSync(validMarkerCase.marker, { mode: 0o700 });
    chmodSync(validMarkerCase.marker, 0o700);
    const validMarkerReport = inspectDiagnosticsFolder(validMarkerCase.dir);
    expect(validMarkerReport.ok).toBe(true);
    if (validMarkerReport.ok) {
      expect(validMarkerReport.report.status).toBe("clean");
      expect(validMarkerReport.report.files[0]?.closedMarker).toBe("matched");
    }

    const noUidProbe = Bun.spawnSync(
      [
        process.execPath,
        "--no-install",
        "-e",
        'Reflect.deleteProperty(process, "getuid"); const { inspectDiagnosticsFolder } = await import(process.argv[1]); console.log(JSON.stringify(inspectDiagnosticsFolder(process.argv[2])));',
        join(skill, "forensics.ts"),
        validMarkerCase.dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(noUidProbe.exitCode).toBe(0);
    expect(parsed(noUidProbe.stdout.toString())).toMatchObject({
      ok: true,
      report: {
        status: "issues",
        files: [{ closedMarker: "mismatched" }],
      },
    });
  });

  test("reports unknown for a live open diagnostics run, clean after finish, and issues beside a real problem", async () => {
    const xdgRoot = ownedFolder("forensics-diag-live-");
    const barrierDir = ownedFolder("forensics-diag-barrier-");
    const readyFile = join(barrierDir, "ready");
    const goFile = join(barrierDir, "go");
    const diagDir = join(xdgRoot, "dxs", "diagnostics");
    const specimen = join(
      repository,
      "tests",
      "kernel",
      "diagnostics",
      "fixtures",
      "specimen-cli.ts",
    );
    const child = Bun.spawn(
      [process.execPath, "--no-install", specimen, "read", "--json"],
      {
        cwd: repository,
        env: {
          ...process.env,
          XDG_STATE_HOME: xdgRoot,
          DXS_SCRIPT: JSON.stringify({
            records: 1,
            hold: { after: 1, ready: readyFile, go: goFile },
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await waitForFile(barrierDir, readyFile);
      const liveCli = runForensics(
        ["diagnostics", diagDir, "--json"],
        repository,
        "verify.ts",
      );
      expect(liveCli.exit).toBe(0);
      expect(parsed(liveCli.writes[0]?.text ?? "")).toMatchObject({
        target: "diagnostics",
        status: "unknown",
        problems: [],
        files: [{ closedMarker: "absent" }],
      });
      const liveReport = inspectDiagnosticsFolder(diagDir);
      expect(liveReport.ok).toBe(true);
      if (liveReport.ok) {
        expect(liveReport.report.status).toBe("unknown");
        expect(liveReport.report.problems).toEqual([]);
        expect(liveReport.report.summary).toContain(
          "(1 unclosed: may still be running or may have crashed before closing; allocation lock is released on open)",
        );
      }
    } finally {
      writeFileSync(goFile, "go");
      await child.exited;
    }

    const finishedReport = inspectDiagnosticsFolder(diagDir);
    expect(finishedReport.ok).toBe(true);
    if (finishedReport.ok) {
      expect(finishedReport.report.status).toBe("clean");
      expect(finishedReport.report.problems).toEqual([]);
      expect(finishedReport.report.files[0]?.closedMarker).toBe("matched");
      expect(finishedReport.report.summary).toContain("(0 unclosed)");
    }

    const mixedDir = ownedFolder("forensics-diag-mixed-");
    chmodSync(mixedDir, 0o700);
    writeFileSync(
      join(mixedDir, "open.jsonl"),
      `${JSON.stringify({ event: "started" })}\n`,
    );
    mkdirSync(join(mixedDir, "ghost.jsonl.closed-1-2-3"), { mode: 0o700 });
    const mixedReport = inspectDiagnosticsFolder(mixedDir);
    expect(mixedReport.ok).toBe(true);
    if (mixedReport.ok) {
      expect(mixedReport.report.status).toBe("issues");
      expect(mixedReport.report.files[0]?.closedMarker).toBe("absent");
      expect(mixedReport.report.orphanMarkers).toEqual([
        "ghost.jsonl.closed-1-2-3",
      ]);
    }
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

  test("refuses approval records the kernel rejects (hard links, invalid UTF-8, size bound)", () => {
    const dir = ownedFolder("forensics-approval-admit-");
    const sibling = ownedFolder("forensics-approval-outside-");
    const validGrant = JSON.stringify({
      format: "contract3.approval-grant",
      version: 1,
      operation: "op-admit",
      preview: "preview-hash",
      authority: "operator",
      resource: "note-1",
      resourceRevision: "rev-1",
      effects: ["note.write"],
      expiresAt: 5000,
    });
    const externalSource = join(sibling, "source.json");
    writeFileSync(externalSource, validGrant);
    linkSync(externalSource, join(dir, "grant-hardlink.json"));

    const authorityField = '"authority":"operator"';
    const authorityAt = validGrant.indexOf(authorityField);
    expect(authorityAt).toBeGreaterThan(-1);
    const splitAt = authorityAt + '"authority":"oper'.length;
    const prefix = new TextEncoder().encode(validGrant.slice(0, splitAt));
    const suffix = new TextEncoder().encode(validGrant.slice(splitAt));
    writeFileSync(
      join(dir, "grant-bad-utf8.json"),
      concatBytes(prefix, Uint8Array.from([0xff]), suffix),
    );

    const exactPad = 16 * 1024 - Buffer.byteLength(validGrant);
    writeFileSync(
      join(dir, "grant-exact-limit.json"),
      `${validGrant}${" ".repeat(exactPad)}`,
    );
    writeFileSync(
      join(dir, "grant-over-limit.json"),
      `${validGrant}${" ".repeat(exactPad + 1)}`,
    );

    const inspected = inspectApprovalFolder(dir, 2000);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.report.status).toBe("issues");
    expect(
      inspected.report.entries.find((e) => e.file === "grant-hardlink.json"),
    ).toMatchObject({
      kind: "malformed",
      problems: ["approval record has multiple hard links"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-bad-utf8.json"),
    ).toMatchObject({
      kind: "malformed",
      problems: ["unrecognised or malformed approval JSON record"],
    });
    expect(
      inspected.report.entries.find((e) => e.file === "grant-exact-limit.json"),
    ).toMatchObject({
      kind: "grant",
      expired: false,
      problems: [],
    });
    const over = inspected.report.entries.find(
      (e) => e.file === "grant-over-limit.json",
    );
    expect(over?.kind).toBe("malformed");
    expect(over?.problems.some((p) => p.includes("over 16384"))).toBe(true);
  });

  test("refuses run evidence outside the run folder and propagates helper state issues", () => {
    const base = ownedFolder("forensics-run-bounds-");
    const runRow = JSON.stringify({
      schema: "verify-index/1",
      row: "run",
      repository: "/repo",
      target: "example",
      pinnedCommit: "abc123",
      bun: "1.3.0",
      platform: "darwin",
      headCommit: "abc123",
      uncommittedPaths: 0,
    });
    const stepBody = JSON.stringify({
      schema: "verify-step/1",
      unmet: [],
      observed: {
        timedOut: false,
        outputTruncated: false,
        terminationConfirmed: true,
      },
      repository: { headCommit: "abc123", uncommittedPaths: 0 },
    });
    const stepHash = createHash("sha256").update(stepBody).digest("hex");
    const stepRowFor = (file: string) =>
      JSON.stringify({
        row: "step",
        feature: "read-only",
        step: "check",
        runner: "target",
        verdict: "met",
        commandIdentity: null,
        causeCode: null,
        exitCode: 0,
        file,
        sha256: stepHash,
      });

    const outsideDir = join(base, "outside");
    mkdirSync(outsideDir, { mode: 0o700 });
    writeFileSync(join(outsideDir, "outside-step.json"), stepBody);
    writeFileSync(
      join(outsideDir, "index.jsonl"),
      `${runRow}\n${stepRowFor("outside-step.json")}\n`,
    );

    const makeCleanState = (target: string) => {
      mkdirSync(target, { mode: 0o700 });
      mkdirSync(join(target, "coordination"), { mode: 0o700 });
      mkdirSync(join(target, "operations"), { mode: 0o700 });
      mkdirSync(join(target, "staging"), { mode: 0o700 });
      mkdirSync(join(target, "settled"), { mode: 0o700 });
      writeFileSync(
        join(target, "format"),
        encodeC3s1("format", { journal: "contract3.state.2" }),
      );
    };

    const linkedRun = join(base, "linked-run");
    mkdirSync(linkedRun, { mode: 0o700 });
    makeCleanState(join(linkedRun, "state"));
    symlinkSync(outsideDir, join(linkedRun, "evidence"));
    const linkedReport = inspectRunFolder(linkedRun);
    expect(linkedReport.ok).toBe(true);
    if (linkedReport.ok) {
      expect(linkedReport.report.status).toBe("issues");
      expect(linkedReport.report.steps).toEqual([]);
      expect(
        linkedReport.report.problems.some((p) =>
          p.includes("not a real directory"),
        ),
      ).toBe(true);
    }

    const escapeRun = join(base, "escape-run");
    mkdirSync(join(escapeRun, "evidence"), { recursive: true, mode: 0o700 });
    makeCleanState(join(escapeRun, "state"));
    symlinkSync(outsideDir, join(escapeRun, "evidence", "sub"));
    const backslashFile = "part\\step.json";
    writeFileSync(join(escapeRun, "evidence", backslashFile), stepBody);
    const absoluteOutsideStep = join(outsideDir, "outside-step.json");
    writeFileSync(
      join(escapeRun, "evidence", "index.jsonl"),
      `${runRow}\n${stepRowFor("../../outside/outside-step.json")}\n${stepRowFor("sub/outside-step.json")}\n${stepRowFor(backslashFile)}\n${stepRowFor(absoluteOutsideStep)}\n`,
    );
    const escapeReport = inspectRunFolder(escapeRun);
    expect(escapeReport.ok).toBe(true);
    if (escapeReport.ok) {
      expect(escapeReport.report.status).toBe("issues");
      expect(escapeReport.report.steps.map((s) => s.hashMatches)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      for (const badFile of [
        "../../outside/outside-step.json",
        "sub/outside-step.json",
        backslashFile,
        absoluteOutsideStep,
      ]) {
        expect(
          escapeReport.report.problems.some((p) =>
            p.includes(`evidence file escapes run folder (${badFile})`),
          ),
        ).toBe(true);
      }
    }

    const unresolvedRun = join(base, "unresolved-run");
    mkdirSync(join(unresolvedRun, "evidence"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(unresolvedRun, "evidence", "index.jsonl"),
      `${runRow}\n`,
    );
    const stateDir = join(unresolvedRun, "state");
    makeCleanState(stateDir);
    const opId = "op-0000000000000000000000000000000f";
    const opDir = join(stateDir, "operations", opId);
    mkdirSync(opDir, { mode: 0o700 });
    writeFileSync(
      join(opDir, "intent"),
      encodeC3s1("intent", {
        operationId: opId,
        commandIdentity: "notes.save",
        runId: "run-unresolved",
        effects: ["note.write"],
        scope: { resources: [], invariants: [], unknown: false, keys: ["k1"] },
        revisions: {},
        owner: { lease: "owner.lease", pid: 4242, startedAt: 1000 },
        coordination: [],
        approval: null,
        closes: null,
      }),
    );
    writeFileSync(join(opDir, "events"), new Uint8Array(0));

    const unresolvedReport = inspectRunFolder(unresolvedRun);
    expect(unresolvedReport.ok).toBe(true);
    if (unresolvedReport.ok) {
      expect(unresolvedReport.report.helperState?.status).toBe("issues");
      expect(unresolvedReport.report.helperState?.problems).toEqual([]);
      expect(unresolvedReport.report.status).toBe("issues");
      expect(
        unresolvedReport.report.problems.some((p) =>
          p.includes("helper state has 1 unresolved case(s)"),
        ),
      ).toBe(true);
      expect(unresolvedReport.report.summary).toContain("Next:");
    }
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
