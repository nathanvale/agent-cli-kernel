import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(skillDir, "../../..");
const tlcTool =
  "github:tlaplus/tlaplus[asset_pattern=tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4";
const javaTool = "java@temurin-25";

const timeouts = {
  miseMs: 30_000,
  gitMs: 15_000,
  tlcMs: 120_000,
};

export const syncCommit = "4edc43c";

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
    if (!existsSync(envJar))
      return { ok: false, error: `TLA2TOOLS does not exist: ${envJar}` };
    return { ok: true, java: envJava || "java", jar: envJar };
  }
  const tlcRes = miseQuery(["where", tlcTool]);
  const jar = tlcRes.stdout ? join(tlcRes.stdout, "tla2tools.jar") : "";
  const javaRes = envJava
    ? { stdout: envJava, stderr: "" }
    : miseQuery(["which", "java", "--tool", javaTool]);
  const java = javaRes.stdout;
  if (!jar || !existsSync(jar) || !java) {
    const detail = [tlcRes.stderr, javaRes.stderr].filter(Boolean).join(" | ");
    return {
      ok: false,
      error: `TLC 1.7.4 or Java not found.${detail ? ` (${detail})` : ""} Repair: run (cd ${skillDir} && mise install) or set TLA2TOOLS and JAVA.`,
    };
  }
  return { ok: true, java, jar };
}

function staleFiles(covered) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "diff", "--name-only", syncCommit, "--", ...covered],
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

function runOne(tlc, model) {
  const stale = staleFiles(model.covered);
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

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const requested = process.argv.slice(2);
  const validIds = new Set(["all", ...models.map((m) => m.id)]);
  const unknown = requested.filter((arg) => !validIds.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown model(s): ${unknown.join(", ")}. Expected one of: all, ${models.map((m) => m.id).join(", ")}.\n`,
    );
    process.exit(2);
  }
  const selected =
    requested.length === 0 || requested.includes("all")
      ? models
      : models.filter((entry) => requested.includes(entry.id));
  const tlc = locateTlc();
  if (!tlc.ok) {
    process.stderr.write(`${tlc.error}\n`);
    process.exit(1);
  }
  let allPassed = true;
  for (const model of selected) {
    if (!runOne(tlc, model)) allPassed = false;
  }
  process.exit(allPassed ? 0 : 1);
}
