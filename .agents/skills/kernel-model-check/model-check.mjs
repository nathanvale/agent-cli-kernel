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

export const syncCommit = "0b7a26f";

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
  });
  return {
    stdout: result.status === 0 ? result.stdout.trim() : "",
    stderr: (result.stderr ?? "").trim(),
  };
}

function locateTlc() {
  const envJar = process.env.TLA2TOOLS;
  const envJava = process.env.JAVA;
  if (envJar) {
    if (!existsSync(envJar))
      return { error: `TLA2TOOLS does not exist: ${envJar}` };
    return { java: envJava || "java", jar: envJar };
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
      error: `TLC 1.7.4 or Java not found.${detail ? ` (${detail})` : ""} Repair: run (cd ${skillDir} && mise install) or set TLA2TOOLS and JAVA.`,
    };
  }
  return { java, jar };
}

function staleFiles(covered) {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "diff",
      "--name-only",
      `${syncCommit}..HEAD`,
      "--",
      ...covered,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function runOne(tlc, model) {
  const stale = staleFiles(model.covered);
  if (stale.length > 0)
    process.stderr.write(
      `WARN ${model.id}: covered files changed since ${syncCommit}: ${stale.join(", ")}\n`,
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
      { cwd: join(skillDir, model.id), encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const summary =
      output
        .split("\n")
        .filter((line) =>
          /Model checking completed|states generated|Error: Invariant/.test(
            line,
          ),
        )
        .join(" | ") || `exit ${String(result.status)}`;
    if (result.status === 0) {
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
  const selected =
    requested.length === 0 || requested.includes("all")
      ? models
      : models.filter((entry) => requested.includes(entry.id));
  if (selected.length === 0) {
    process.stderr.write(
      `Unknown model(s): ${requested.join(", ")}. Expected one of: all, ${models.map((m) => m.id).join(", ")}.\n`,
    );
    process.exit(2);
  }
  const tlc = locateTlc();
  if ("error" in tlc) {
    process.stderr.write(`${tlc.error}\n`);
    process.exit(1);
  }
  const ok = selected.every((model) => runOne(tlc, model));
  process.exit(ok ? 0 : 1);
}
