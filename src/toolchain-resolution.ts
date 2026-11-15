import { createRequire } from "node:module";
import { join } from "node:path";

function packageDocument(value: unknown): object {
  if (value === null || typeof value !== "object")
    throw new Error("The installed package has no identity document.");
  return value;
}

function version(value: unknown): string {
  const document = packageDocument(value);
  if (!("version" in document) || typeof document.version !== "string")
    throw new Error("The installed package has no version identity.");
  return document.version;
}

function acceptedBackends(
  lint: string,
  lintPackage: string,
  compiler: string,
  semantic: string,
): void {
  if (
    lint !== "6.0.2" ||
    lintPackage !== "6.0.2" ||
    compiler !== "7.0.2" ||
    semantic !== "7.0.2"
  )
    throw new Error(
      "The installed lint, compiler and semantic backends do not match the accepted toolchain.",
    );
}

export function resolveToolchain(project: string) {
  const local = createRequire(join(project, "package.json"));
  const eslint = createRequire(local.resolve("typescript-eslint"));
  const companion = createRequire(
    local.resolve("fallow-type-aware/package.json"),
  );
  const lint: unknown = eslint("typescript");
  const lintPackage: unknown = eslint("typescript/package.json");
  const native: unknown = local("@typescript/native/package.json");
  const semantic: unknown = companion("typescript/package.json");
  const compiler = Bun.spawnSync(
    [join(project, "node_modules/.bin/tsc"), "--version"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (
    compiler.exitCode !== 0 ||
    compiler.stdout.toString().trim() !== "Version 7.0.2"
  )
    throw new Error("The project compiler is not native TypeScript 7.0.2.");
  const receipt = {
    lint: version(lint),
    lintPackage: version(lintPackage),
    compiler: version(native),
    semantic: version(semantic),
    compilerExecutable: compiler.stdout.toString().trim(),
  };
  acceptedBackends(
    receipt.lint,
    receipt.lintPackage,
    receipt.compiler,
    receipt.semantic,
  );
  return receipt;
}
