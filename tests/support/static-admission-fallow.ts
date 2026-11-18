import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  gitAsync,
  hashProjectFiles,
  type Invocation,
  nativeEnvironment,
  sha256,
  writeJson,
} from "./static-admission-project.ts";

const CAPTURE_ENVIRONMENT_NAMES = [
  "FORCE_COLOR",
  "NO_COLOR",
  "TMPDIR",
  "PWD",
  "INIT_CWD",
  "STATIC_ADMISSION_CAPTURE_DIR",
  "STATIC_ADMISSION_FOCUS",
  "STATIC_ADMISSION_TOOL_ROOT",
  "STATIC_ADMISSION_NODE_MODULES",
  "BUN_INSTALL_CACHE_DIR",
  "FALLOW_CHANGED_SINCE",
  "FALLOW_DIFF_FILE",
  "FALLOW_EXTRA_ARGS",
  "FALLOW_PRODUCTION",
  "FALLOW_PRODUCTION_DEAD_CODE",
  "FALLOW_PRODUCTION_HEALTH",
  "FALLOW_PRODUCTION_DUPES",
  "FALLOW_MAX_FILE_SIZE",
  "FALLOW_TYPE_AWARE",
  "FALLOW_FORMAT",
  "FALLOW_QUIET",
  "FALLOW_ROOT",
  "FALLOW_CACHE_DIR",
  "FALLOW_CACHE_MAX_SIZE",
  "FALLOW_TYPE_AWARE_BIN",
  "FALLOW_SUGGESTIONS",
  "FALLOW_UPDATE_CHECK",
  "FALLOW_COMMAND",
  "FALLOW_FAIL_ON_ISSUES",
] as const;

export interface FallowCapture {
  postManifestPath: string;
  preManifest: Record<string, unknown>;
  preManifestPath: string;
  stderrPath: string;
  stdoutPath: string;
}

async function realpathOrOriginal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function describeNodeModules(
  root: string,
): Promise<Record<string, string>> {
  const directory = join(root, "node_modules");
  if (!existsSync(directory)) return {};
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    entries[entry.name] = entry.isSymbolicLink()
      ? await realpathOrOriginal(path)
      : entry.isDirectory()
        ? "directory"
        : "file";
  }
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function captureNativeEnvironment(): Record<string, string> {
  const environment = nativeEnvironment();
  return Object.fromEntries(
    CAPTURE_ENVIRONMENT_NAMES.map((name) => [
      name,
      environment[name] ?? "<unset>",
    ]),
  );
}

interface NativeCaptureResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function nativeCaptureResult(
  invocation: Invocation | null,
): NativeCaptureResult {
  if (invocation === null) {
    return { exitCode: null, stderr: "", stdout: "" };
  }
  return {
    exitCode: invocation.exitCode,
    stderr: invocation.stderr,
    stdout: invocation.stdout,
  };
}

function describeCaptureFailure(
  failure: unknown,
): null | Record<string, string> | string {
  if (failure instanceof Error) {
    return { name: failure.name, message: failure.message };
  }
  if (failure === undefined) return null;
  return JSON.stringify(failure);
}

function assertUnnecessarySemanticEvidence(
  typeAware: Record<string, unknown>,
  identity: Record<string, unknown> | undefined,
): void {
  expect(identity?.project_config_hash).toBe("deferred:no-semantic-queries");
  expect(typeAware.candidate_count).toBe(0);
  expect(typeAware.queries ?? []).toEqual([]);
}

function assertExecutedSemanticEvidence(
  typeAware: Record<string, unknown>,
): void {
  expect(typeAware.executed).toBe(true);
  const projects = typeAware.selected_tsconfigs;
  expect(Array.isArray(projects) && projects.length > 0).toBe(true);
  const queries = typeAware.queries as
    | Array<Record<string, unknown>>
    | undefined;
  if (!queries?.length) throw new Error("Native Fallow query results missing");
  for (const query of queries) expect(query.status).toBe("complete");
}

export async function prepareFallowCapture(
  retainedRoots: Set<string>,
  root: string,
  args: string[],
  expectedRules: Record<string, number | FallowRuleExpectation>,
): Promise<FallowCapture | null> {
  const configuredDirectory = process.env.STATIC_ADMISSION_CAPTURE_DIR;
  if (!configuredDirectory) return null;

  const captureDirectory = resolve(configuredDirectory);
  await mkdir(captureDirectory, { recursive: true });
  const label = `fallow-${basename(root)}`;
  const preManifestPath = join(captureDirectory, `${label}.pre-native.json`);
  const postManifestPath = join(captureDirectory, `${label}.post-native.json`);
  const stdoutPath = join(captureDirectory, `${label}.native.stdout`);
  const stderrPath = join(captureDirectory, `${label}.native.stderr`);
  const fileHashes = await hashProjectFiles(root);
  const configNames = new Set([
    ".fallowrc.json",
    ".gitignore",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "tsconfig.base.json",
    "tsconfig.json",
  ]);
  const configHashes = Object.fromEntries(
    Object.entries(fileHashes).filter(([path]) => configNames.has(path)),
  );
  const preManifest = {
    captureKind:
      "focused-native-fallow-preflight-summary-not-byte-exact-envelope",
    capturePhase: "before-native-invocation",
    fixture: {
      root,
      rootRealpath: await realpathOrOriginal(root),
      processCwd: process.cwd(),
      osTmpdir: tmpdir(),
      envTmpdir: process.env.TMPDIR ?? "<unset>",
      projectFilesBeforeNative: Object.keys(fileHashes),
      fileHashes,
      configHashes,
      nodeModules: await describeNodeModules(root),
      gitHead: (await gitAsync(root, "rev-parse", "HEAD")).trim(),
      gitStatus: (await gitAsync(root, "status", "--porcelain=v1")).trim(),
    },
    expectedRuleCounts: Object.fromEntries(
      Object.entries(expectedRules).map(([rule, expectation]) => [
        rule,
        typeof expectation === "number" ? expectation : expectation.count,
      ]),
    ),
    native: {
      executable: "node_modules/.bin/fallow",
      executableRealpath: await realpathOrOriginal(
        join(root, "node_modules/.bin/fallow"),
      ),
      argv: args,
      cwd: root,
      environment: captureNativeEnvironment(),
      rawStdoutPath: stdoutPath,
      rawStderrPath: stderrPath,
    },
  } satisfies Record<string, unknown>;
  await writeJson(preManifestPath, preManifest);
  retainedRoots.add(root);
  return {
    postManifestPath,
    preManifest,
    preManifestPath,
    stderrPath,
    stdoutPath,
  };
}

export type FallowPass = "whole-project" | "production-dependencies";

export function fallowDeadCodeArgs(
  pass: FallowPass = "whole-project",
): string[] {
  return [
    "dead-code",
    ...(pass === "production-dependencies" ? ["--production"] : []),
    "--format",
    "json",
    "--quiet",
    "--type-aware",
    "--type-aware-require",
    "complete",
    "--fail-on-issues",
  ];
}

export function parseFallowDocument(
  invocation: Invocation,
): Record<string, unknown> {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(invocation.stdout) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      "Fallow produced non-JSON stdout.\nstdout:\n" +
        invocation.stdout +
        "\nstderr:\n" +
        invocation.stderr,
      { cause },
    );
  }
  return document;
}

export async function finishFallowCapture(
  capture: FallowCapture | null,
  invocation: Invocation | null,
  failure?: unknown,
): Promise<void> {
  if (!capture) return;
  const result = nativeCaptureResult(invocation);
  await writeFile(capture.stdoutPath, result.stdout);
  await writeFile(capture.stderrPath, result.stderr);
  await writeJson(capture.postManifestPath, {
    ...capture.preManifest,
    capturePhase: "after-native-invocation",
    nativeResult: {
      exitCode: result.exitCode,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    },
    failure: describeCaptureFailure(failure),
  });
}

export function assertRequiredSemanticEvidence(
  document: Record<string, unknown>,
): void {
  const meta = document._meta as Record<string, unknown> | undefined;
  const typeAware = meta?.type_aware as Record<string, unknown> | undefined;
  if (!typeAware) {
    throw new Error(
      "Native Fallow semantic evidence missing: _meta.type_aware",
    );
  }
  expect(typeAware.required_completeness).toBe("complete");
  const identity = typeAware.identity as Record<string, unknown> | undefined;
  expect(identity?.completeness).toBe("complete");
  if (typeAware.executed === false) {
    assertUnnecessarySemanticEvidence(typeAware, identity);
  } else {
    assertExecutedSemanticEvidence(typeAware);
  }
}

export function assertExpectedFallowRuleCounts(
  document: Record<string, unknown>,
  expectedRules: Record<string, number | FallowRuleExpectation>,
): void {
  const summary = document.summary as Record<string, unknown> | undefined;
  for (const [rule, expectation] of Object.entries(expectedRules)) {
    const expectedCount =
      typeof expectation === "number" ? expectation : expectation.count;
    if (expectedCount <= 0) {
      throw new Error(`Expected a positive native count for ${rule}`);
    }
    const actualCount = summary?.[rule];
    expect(actualCount).toBe(expectedCount);
    const findings = document[rule];
    expect(Array.isArray(findings)).toBe(true);
    const findingList = findings as unknown[] | undefined;
    expect(findingList?.length).toBe(expectedCount);
    if (typeof expectation !== "number" && expectation.matches) {
      expect(
        findingList?.some(
          (finding) =>
            typeof finding === "object" &&
            finding !== null &&
            !Array.isArray(finding) &&
            expectation.matches?.(finding as Record<string, unknown>),
        ),
      ).toBe(true);
    }
  }
}

export interface FallowRuleExpectation {
  count: number;
  matches?: (finding: Record<string, unknown>) => boolean;
}
