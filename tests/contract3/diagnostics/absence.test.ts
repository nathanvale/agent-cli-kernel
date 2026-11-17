import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { contractFor } from "../../../kernel/src/kernel/index.ts";
import { empty, plain } from "./fixtures/declarations.ts";
import { cleanTrees, get, observe, run, tree } from "./harness.ts";
import type { Run, Tree } from "./harness.ts";
import {
  expectAvailable,
  expectTwinEqual,
  expectUnavailable,
  expectSuccess,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const read = ["read", ...machine] as const;
const timeout = 60_000;
const repository = join(import.meta.dir, "../../..");

// Accepted decision (Nathan, 16 November 2026, 14:19, contract question 1
// of 8): a result refused before handler entry carries no key; the key
// appears only after handler entry, for a command that declares diagnostics.
const preDispatchKey = false;

function hasKey(result: Run): boolean {
  return (
    typeof result.envelope === "object" &&
    result.envelope !== null &&
    "diagnostics" in result.envelope
  );
}

function created(where: Tree): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(where.root, path));
    }
  };
  walk(where.root);
  return found;
}

function files(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe("D01 absent when disabled", () => {
  test(
    "D01.no-addon-success: a CLI without the add-on emits no key",
    async () => {
      const where = tree();
      const result = await run({ argv: read, tree: where, bare: true });
      expectSuccess(result);
      expect(hasKey(result)).toBe(false);
    },
    timeout,
  );

  test(
    "D01.no-addon-refusal: a refusal without the add-on emits no key",
    async () => {
      const result = await run({
        argv: ["read", "--bogus", ...machine],
        tree: tree(),
        bare: true,
      });
      expect(result.exit).toBe(2);
      expect(get(result.envelope, "result", "outcome")).toBe("refused");
      expect(hasKey(result)).toBe(false);
    },
    timeout,
  );

  test(
    "D01.no-addon-fallback: the fallback without the add-on emits no key",
    async () => {
      const result = await run({
        argv: read,
        tree: tree(),
        bare: true,
        env: { DXS_THROW: "1" },
      });
      expect(result.exit).toBe(1);
      expect(String(get(result.envelope, "result", "causeCode"))).toStartWith(
        "INTERNAL_",
      );
      expect(hasKey(result)).toBe(false);
    },
    timeout,
  );

  test(
    "D01.no-addon-no-files: a CLI without the add-on creates nothing under the state root or home",
    async () => {
      const where = tree();
      for (const argv of [
        read,
        ["read", "--bogus", ...machine],
        ["plain", ...machine],
      ])
        await run({ argv, tree: where, bare: true });
      expect(created(where)).toEqual([]);
      expect(observe(where.state).exists).toBe(false);
    },
    timeout,
  );

  test(
    "D01.installed-undeclared-command: a command without the capability emits no key and creates nothing",
    async () => {
      const where = tree();
      const result = await run({ argv: ["plain", ...machine], tree: where });
      expectSuccess(result, "dxs.plain");
      expect(hasKey(result)).toBe(false);
      expect(observe(where.state).exists).toBe(false);
    },
    timeout,
  );

  test(
    "D01.declared-command-key-present: a declaring command's result carries the key",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      expect(hasKey(result)).toBe(true);
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "file")).toBeString();
    },
    timeout,
  );

  test(
    "D01.declared-command-no-records-key-present: the key is present even when nothing was recorded, and nothing is created",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 0 },
      });
      expectSuccess(result);
      expect(statusOf(result)).toEqual({
        status: "available",
        file: null,
        sinkFailure: null,
        droppedRecords: 0,
        unflushedRecords: 0,
        truncatedRecords: 0,
        countsComplete: true,
        closed: false,
      });
      expect(observe(where.state).exists).toBe(false);
    },
    timeout,
  );

  test(
    "D01.pre-dispatch-refusal-no-key: a usage refusal of a declaring command carries no key (accepted decision, 14:19)",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", "--bogus", ...machine],
        tree: where,
      });
      expect(result.exit).toBe(2);
      expect(get(result.envelope, "result", "causeCode")).toBe(
        "USAGE_INVALID_INVOCATION",
      );
      expect(hasKey(result)).toBe(preDispatchKey);
      expect(observe(where.state).exists).toBe(false);
    },
    timeout,
  );
});

describe("Fallback with the add-on (T2 F02 and W06 through this add-on)", () => {
  test(
    "F02.diagnostics-in-fallback (T5 add-on): the fallback carries the frozen status",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2, throwAfter: true },
      });
      expect(result.exit).toBe(1);
      expect(String(get(result.envelope, "result", "causeCode"))).toStartWith(
        "INTERNAL_RESULT_",
      );
      const status = statusOf(result);
      expectAvailable(status);
      const [log] = observe(where.dir).files;
      expect(get(status, "file")).toBe(log?.path);
    },
    timeout,
  );

  test(
    "D11.invalid-no-fallback and W06.diagnostics-fault-no-fallback (T5 add-on): a diagnostics fault never takes the fallback",
    async () => {
      const expected = [
        { fault: "write-lies", variant: "status-invalid" },
        { fault: "size-throws", variant: "status-unavailable" },
        { fault: "write-stalls", variant: "flush-timeout" },
        { fault: "close-throws", variant: "close" },
      ] as const;
      for (const { fault, variant } of expected) {
        const result = await run({ argv: read, tree: tree(), fault });
        expectSuccess(result);
        await expectTwinEqual(result, { argv: read });
        const status = statusOf(result);
        if (variant === "status-invalid" || variant === "status-unavailable")
          expectUnavailable(status, variant);
        else {
          expectAvailable(status);
          expect(get(status, "sinkFailure")).toBe(variant);
        }
      }
    },
    timeout,
  );
});

describe("D18 effect exclusions and the inspect stance", () => {
  test(
    "D18.inspect-stays-unchanged: diagnostics activity leaves an inspect command unchanged",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 3 },
      });
      expectSuccess(result);
      expect(observe(where.dir).files.length).toBeGreaterThan(0);
      expect(get(result.envelope, "result", "effectClass")).toBe("inspect");
      expect(get(result.envelope, "result", "transactionState")).toBe(
        "unchanged",
      );
      expect(get(result.envelope, "result", "effects")).toEqual(empty);
    },
    timeout,
  );

  test(
    "D18.discovery-effect-exclusions: discovery discloses diagnostic maintenance",
    async () => {
      const result = await run({
        argv: ["--discover", ...machine],
        tree: tree(),
      });
      expect(result.exit).toBe(0);
      const exclusions = get(
        result.envelope,
        "result",
        "data",
        "effectExclusions",
      );
      expect(
        Array.isArray(exclusions) &&
          exclusions.includes("Incidental diagnostic maintenance."),
      ).toBe(true);
    },
    timeout,
  );
});

describe("D19 no raw streams or destinations", () => {
  test(
    "D19.child-stream-marker-absent: a child program's output is never retained",
    async () => {
      const where = tree();
      const marker = `T5SYNTHMARKER-child-${crypto.randomUUID()}`;
      const result = await run({
        argv: ["spawn", ...machine],
        tree: where,
        env: { DXS_CHILD_MARKER: marker },
      });
      expectSuccess(result, "dxs.spawn");
      expect(get(result.envelope, "result", "data", "exitCode")).toBe(0);
      expect(observe(where.dir).files.length).toBe(1);
      for (const path of files(where.root))
        expect(readFileSync(path, "utf8")).not.toContain(marker);
    },
    timeout,
  );

  test(
    "D19.no-destination-option: no command offers a diagnostics destination",
    async () => {
      const where = tree();
      for (const identity of ["dxs.read", "dxs.plain", "dxs.spawn"]) {
        const result = await run({
          argv: ["--discover-command", identity, ...machine],
          tree: where,
        });
        expect(result.exit).toBe(0);
        const options = get(
          result.envelope,
          "result",
          "data",
          "input",
          "options",
        );
        if (!Array.isArray(options)) throw new Error("no options");
        for (const option of options)
          expect(String(get(option, "name"))).not.toMatch(
            /diag|log|dest|sink|state/i,
          );
      }
    },
    timeout,
  );

  test(
    "D19.environment-cannot-move-files: only XDG_STATE_HOME or HOME places the files",
    async () => {
      const where = tree();
      const elsewhere = join(where.root, "elsewhere");
      const result = await run({
        argv: read,
        tree: where,
        env: {
          XDG_DATA_HOME: join(elsewhere, "data"),
          XDG_CACHE_HOME: join(elsewhere, "cache"),
          XDG_RUNTIME_DIR: join(elsewhere, "runtime"),
          LOGTAPE_LEVEL: "debug",
        },
      });
      expectSuccess(result);
      expect(observe(elsewhere).exists).toBe(false);
      expect(observe(where.dir).files).toHaveLength(1);
    },
    timeout,
  );
});

describe("D20 sole owner and pin", () => {
  test("D20.sole-logging-import: only the diagnostics add-on imports a logging library", () => {
    const source = join(repository, "kernel/src");
    const logging =
      /(?:from|import|require)\s*\(?\s*["'](@logtape\/[^"']+|pino[^"']*|winston[^"']*|bunyan|log4js|loglevel|consola|signale)["']/;
    const offenders = files(source)
      .filter((path) => path.endsWith(".ts"))
      .filter(
        (path) => !relative(source, path).startsWith("addons/diagnostics/"),
      )
      .filter((path) => logging.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    const owners = files(join(source, "addons/diagnostics")).filter((path) =>
      logging.test(readFileSync(path, "utf8")),
    );
    expect(owners.length).toBeGreaterThan(0);
    for (const path of files(join(source, "kernel")))
      expect(readFileSync(path, "utf8")).not.toMatch(
        /addons\/diagnostics|diagnosticsAddon/,
      );
  });

  test("D20.pin-2.4.2: the LogTape packages are pinned at exactly 2.4.2 with the template revision 4 integrity", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(repository, "package.json"), "utf8"),
    );
    expect(get(manifest, "dependencies")).toEqual({
      "@logtape/logtape": "2.4.2",
      "@logtape/redaction": "2.4.2",
    });
    const lock = readFileSync(join(repository, "bun.lock"), "utf8");
    expect(lock).toContain(
      '"@logtape/logtape": ["@logtape/logtape@2.4.2", "", {}, "sha512-YJyC1gEMgWmTqJTRtKkjgasEbi8/0gP7Dj8n6bL46gQIAhpTY8uXJ+1QYMOgF5asotlGMvy3G7ejXUe45Yd1MQ=="]',
    );
    expect(lock).toContain(
      '"@logtape/redaction": ["@logtape/redaction@2.4.2", "", { "peerDependencies": { "@logtape/logtape": "^2.4.2" } }, "sha512-QERsPJYr+ZaHj+pPoGGMlDcpE+V27j05ImDyGRi6vxuAQ3uIBCJtUUrcs6jNwXWG90SEZw9C0dS0jeLFOayjrg=="]',
    );
    const installed: unknown = JSON.parse(
      readFileSync(
        join(repository, "node_modules/@logtape/logtape/package.json"),
        "utf8",
      ),
    );
    expect(get(installed, "version")).toBe("2.4.2");
    expect(
      statSync(
        join(repository, "node_modules/@logtape/redaction/package.json"),
      ).isFile(),
    ).toBe(true);
  });

  test("D20.kernel-validator-both-variants: a CLI without the add-on validates both variants and rejects invalid ones", async () => {
    const contract = contractFor({
      cli: "dxs",
      commands: [plain],
      installedAddons: [],
    });
    const executed = await contract.execute("dxs.plain", [], "run-1");
    if (!executed.ok) throw new Error("fixture command did not run");
    const built = await contract.buildResult(executed.value);
    if (!built.ok) throw new Error("fixture envelope did not build");
    const available = {
      status: "available",
      file: "/state/dxs/diagnostics/run-1.jsonl",
      sinkFailure: null,
      droppedRecords: 0,
      unflushedRecords: 0,
      truncatedRecords: 0,
      countsComplete: true,
      closed: true,
    };
    const with_ = (diagnostics: unknown) =>
      contract.validate({ ...built.value, diagnostics });
    expect((await with_(available)).ok).toBe(true);
    expect(
      (
        await with_({
          status: "unavailable",
          reason: "status-invalid",
          trusted: {},
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await with_({
          status: "unavailable",
          reason: "status-unavailable",
          trusted: { file: available.file },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await with_({
          ...available,
          closed: true,
          sinkFailure: "flush-timeout",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await with_({ status: "unavailable", reason: "setup", trusted: {} })).ok,
    ).toBe(false);
    expect(
      (
        await with_({
          status: "unavailable",
          reason: "status-invalid",
          trusted: { droppedRecords: -1 },
        })
      ).ok,
    ).toBe(false);
    expect((await with_({ ...available, extra: true })).ok).toBe(false);
  });
});
