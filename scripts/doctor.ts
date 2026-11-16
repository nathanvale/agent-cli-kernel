import { existsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { resolveToolchain } from "../src/toolchain-resolution.ts";

type Finding = {
  status: "ok" | "FAIL" | "WARN";
  check: string;
  detail: string;
};

const install = "bun install --frozen-lockfile";

async function pinnedBun(root: string): Promise<string | undefined> {
  try {
    const manifest = (await Bun.file(join(root, "package.json")).json()) as {
      packageManager?: unknown;
    };
    return /^bun@(.+)$/.exec(String(manifest.packageManager))?.[1];
  } catch {
    return undefined;
  }
}

async function bunVersion(root: string): Promise<Finding> {
  const pinned = await pinnedBun(root);
  if (pinned === undefined)
    return {
      status: "FAIL",
      check: "bun",
      detail:
        "package.json has no packageManager pin of the form bun@<version>.",
    };
  if (pinned === Bun.version)
    return {
      status: "ok",
      check: "bun",
      detail: `Bun ${Bun.version} matches the packageManager pin.`,
    };
  return {
    status: "FAIL",
    check: "bun",
    detail: `found Bun ${Bun.version}, pinned ${pinned}. Repair: install Bun ${pinned} (mise install bun@${pinned}, or setup-bun in CI), then ${install}.`,
  };
}

function toolchain(root: string): Finding {
  if (!existsSync(join(root, "node_modules")))
    return {
      status: "FAIL",
      check: "toolchain",
      detail: `node_modules is missing. Repair: ${install}.`,
    };
  try {
    resolveToolchain(root);
    return {
      status: "ok",
      check: "toolchain",
      detail:
        "node_modules resolves the accepted lint, compiler and semantic backends.",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "FAIL",
      check: "toolchain",
      detail: `${reason} Repair: ${install}.`,
    };
  }
}

function hostLoad(): Finding {
  const load = loadavg()[0] ?? 0;
  const cores = availableParallelism();
  const summary = `one-minute load ${load.toFixed(1)} on ${cores} cores`;
  if (load > cores)
    return {
      status: "WARN",
      check: "load",
      detail: `${summary}. Run the full suite and timing-sensitive cases on the Mac mini gate or hosted CI.`,
    };
  return { status: "ok", check: "load", detail: `${summary}.` };
}

export async function doctor(root: string): Promise<boolean> {
  const findings = [await bunVersion(root), toolchain(root), hostLoad()];
  for (const { status, check, detail } of findings)
    process.stdout.write(`${status} ${check}: ${detail}\n`);
  return findings.every((finding) => finding.status !== "FAIL");
}

if (import.meta.main) process.exitCode = (await doctor(process.cwd())) ? 0 : 1;
