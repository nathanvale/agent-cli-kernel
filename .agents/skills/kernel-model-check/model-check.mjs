import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(skillDir, "../../..");

function statPath(path) {
  try {
    return { kind: "ok", stats: statSync(path) };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "error", reason };
  }
}
const tlcTool =
  "github:tlaplus/tlaplus[asset_pattern=tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4";
const javaTool = "java@temurin-25";

const timeouts = {
  miseMs: 30_000,
  gitMs: 15_000,
  tlcMs: 120_000,
};

export const syncCommit = "426e5db";

export const models = [
  {
    id: "state-journal",
    spec: "state-journal/StateJournal.tla",
    cfg: "state-journal/StateJournal.cfg",
    covered: [
      "kernel/src/addons/state/install.ts",
      "kernel/src/addons/state/store.ts",
      "kernel/src/addons/state/framing.ts",
      "kernel/src/addons/state/coordination.ts",
    ],
  },
  {
    id: "diagnostics-custody",
    spec: "diagnostics-custody/DiagnosticsCustody.tla",
    cfg: "diagnostics-custody/DiagnosticsCustody.cfg",
    covered: [
      "kernel/src/addons/diagnostics/custody.ts",
      "kernel/src/addons/diagnostics/run.ts",
    ],
  },
  {
    id: "kernel-lifecycle",
    spec: "kernel-lifecycle/KernelLifecycle.tla",
    cfg: "kernel-lifecycle/KernelLifecycle.cfg",
    covered: [
      "kernel/src/kernel/lifecycle.ts",
      "kernel/src/kernel/state-seam.ts",
      "kernel/src/kernel/writer.ts",
    ],
  },
];

function miseQuery(args) {
  const result = spawnSync("mise", args, {
    cwd: skillDir,
    encoding: "utf8",
    timeout: timeouts.miseMs,
    killSignal: "SIGKILL",
  });
  const err = result.error ? result.error.message : "";
  const stderr = [err, (result.stderr ?? "").trim()].filter(Boolean).join("; ");
  return {
    stdout: !result.error && result.status === 0 ? result.stdout.trim() : "",
    stderr,
  };
}

function locateTlc() {
  const envJar = process.env.TLA2TOOLS;
  const envJava = process.env.JAVA;
  if (envJar) {
    const stat = statPath(envJar);
    if (stat.kind === "missing")
      return { ok: false, error: `TLA2TOOLS does not exist: ${envJar}` };
    if (stat.kind === "error")
      return {
        ok: false,
        error: `Cannot stat TLA2TOOLS (${envJar}): ${stat.reason}`,
      };
    if (!stat.stats.isFile())
      return { ok: false, error: `TLA2TOOLS is not a file: ${envJar}` };
    return { ok: true, java: envJava || "java", jar: envJar };
  }
  const tlcRes = miseQuery(["where", tlcTool]);
  const jar = tlcRes.stdout ? join(tlcRes.stdout, "tla2tools.jar") : "";
  const javaRes = envJava
    ? { stdout: envJava, stderr: "" }
    : miseQuery(["which", "java", "--tool", javaTool]);
  const java = javaRes.stdout;
  const jarStat = jar ? statPath(jar) : { kind: "missing" };
  if (jarStat.kind === "error") {
    return {
      ok: false,
      error: `Cannot stat TLC jar (${jar}): ${jarStat.reason}`,
    };
  }
  if (!jar || jarStat.kind !== "ok" || !jarStat.stats.isFile() || !java) {
    const detail = [tlcRes.stderr, javaRes.stderr].filter(Boolean).join(" | ");
    return {
      ok: false,
      error: `TLC 1.7.4 or Java not found.${detail ? ` (${detail})` : ""} Repair: run (cd ${skillDir} && mise install) or set TLA2TOOLS and JAVA.`,
    };
  }
  return { ok: true, java, jar };
}

function staleFiles(covered, targetRepo) {
  const result = spawnSync(
    "git",
    ["-C", targetRepo, "diff", "--name-only", syncCommit, "--", ...covered],
    { encoding: "utf8", timeout: timeouts.gitMs, killSignal: "SIGKILL" },
  );
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0)
    return {
      ok: false,
      reason:
        (result.stderr ?? "").trim() || `git exited ${String(result.status)}`,
    };
  return {
    ok: true,
    files: result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

function runOne(tlc, model, targetRepo) {
  const stale = staleFiles(model.covered, targetRepo);
  if (!stale.ok)
    process.stderr.write(
      `WARN ${model.id}: could not verify staleness against ${syncCommit}: ${stale.reason}\n`,
    );
  else if (stale.files.length > 0)
    process.stderr.write(
      `WARN ${model.id}: covered files changed since ${syncCommit}: ${stale.files.join(", ")}\n`,
    );
  const work = mkdtempSync(join(tmpdir(), `kernel-model-check-${model.id}-`));
  try {
    const specPath = join(skillDir, model.spec);
    const cfgPath = join(skillDir, model.cfg);
    const result = spawnSync(
      tlc.java,
      [
        "-XX:+UseParallelGC",
        "-cp",
        tlc.jar,
        "tlc2.TLC",
        "-deadlock",
        "-workers",
        "auto",
        "-metadir",
        work,
        "-config",
        cfgPath,
        specPath,
      ],
      {
        cwd: join(skillDir, model.id),
        encoding: "utf8",
        timeout: timeouts.tlcMs,
        killSignal: "SIGKILL",
      },
    );
    const spawnErr = result.error ? `${result.error.message}\n` : "";
    const output = `${spawnErr}${result.stdout ?? ""}${result.stderr ?? ""}`;
    const summary =
      output
        .split("\n")
        .filter((line) =>
          /Model checking completed|states generated|Error: Invariant/.test(
            line,
          ),
        )
        .join(" | ") || `exit ${String(result.status ?? result.signal)}`;
    const verifiedClean =
      !result.error &&
      result.status === 0 &&
      /Model checking completed\. No error has been found\./.test(output);
    if (verifiedClean) {
      process.stdout.write(`PASS ${model.id}: ${summary}\n`);
      return true;
    }
    process.stderr.write(`FAIL ${model.id}: ${summary}\n${output}\n`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  let targetRepo = defaultRepoRoot;
  const requested = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: "--repo requires a directory path." };
      }
      targetRepo = resolve(next);
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) {
        return { ok: false, error: "--repo requires a directory path." };
      }
      targetRepo = resolve(value);
    } else {
      requested.push(arg);
    }
  }
  const repoStat = statPath(targetRepo);
  if (repoStat.kind === "error") {
    return {
      ok: false,
      error: `Cannot stat --repo path (${targetRepo}): ${repoStat.reason}`,
    };
  }
  if (repoStat.kind !== "ok" || !repoStat.stats.isDirectory()) {
    return {
      ok: false,
      error: `--repo path must be an existing directory: ${targetRepo}`,
    };
  }
  const validIds = new Set(["all", ...models.map((m) => m.id)]);
  const unknown = requested.filter((arg) => !validIds.has(arg));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown model(s): ${unknown.join(", ")}. Expected one of: all, ${models.map((m) => m.id).join(", ")}.`,
    };
  }
  const selected =
    requested.length === 0 || requested.includes("all")
      ? models
      : models.filter((entry) => requested.includes(entry.id));
  return { ok: true, targetRepo, selected };
}

function main(argv) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const tlc = locateTlc();
  if (!tlc.ok) {
    process.stderr.write(`${tlc.error}\n`);
    return 1;
  }
  let allPassed = true;
  for (const model of parsed.selected) {
    if (!runOne(tlc, model, parsed.targetRepo)) allPassed = false;
  }
  return allPassed ? 0 : 1;
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  process.exitCode = main(process.argv.slice(2));
}
