import { existsSync } from "node:fs";
import { join } from "node:path";

// One worker per core. A value such as "--parallel=2" caps the count.
const workers = "--parallel";

// Each file failed only under workers on hosted CI, against a wall-clock
// limit. They run after the workers, one file at a time.
const serialFiles: readonly string[] = [
  "tests/contract3/kernel-followup/decision-3.test.ts",
  "tests/contract3/lifecycle/lifecycle.test.ts",
  "tests/contract3/diagnostics/limits.test.ts",
  "tests/contract3/diagnostics/secrets.test.ts",
];

type Call = { readonly name: "workers" | "serial"; readonly argv: string[] };

const root = join(import.meta.dir, "..");
const options = process.argv.slice(2);
// A name filter (-t) can match tests in only one of the two calls.
const shared = [
  "--path-ignore-patterns",
  "starters/**",
  "--pass-with-no-tests",
];
const workerOnly = (option: string) =>
  option.startsWith("--parallel") || option === "--no-isolate";

const missing = serialFiles.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  process.stderr.write(
    `scripts/test.ts lists serial test files that do not exist: ${missing.join(", ")}. Remove them from serialFiles or restore the files.\n`,
  );
  process.exit(2);
}

const calls: Call[] = [
  {
    name: "workers",
    argv: [
      workers,
      ...shared,
      ...serialFiles.flatMap((path) => ["--path-ignore-patterns", path]),
      ...options,
    ],
  },
  {
    name: "serial",
    argv: [
      ...shared,
      ...serialFiles.map((path) => `./${path}`),
      ...options.filter((option) => !workerOnly(option)),
    ],
  },
];

const exits: string[] = [];
for (const call of calls) {
  const run = Bun.spawn([process.execPath, "test", ...call.argv], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await run.exited;
  exits.push(`${call.name} call exit ${code}`);
  if (code !== 0) process.exitCode = code;
}
process.stdout.write(`bun run test: ${exits.join(", ")}.\n`);
