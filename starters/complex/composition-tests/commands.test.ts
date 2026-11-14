import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entryPath = "__CLI_ENTRY_POINT__";
const entryPoint = fileURLToPath(new URL(entryPath, import.meta.url));
const cases = [
  [["status"], "example.status"],
  [["set", "--value", "enabled", "--preview"], "example.set"],
  [["recover"], "example.recover"],
] as const;

test.each(cases)(
  "the existing CLI runs composed command %j",
  (args, identity) => {
    const state = mkdtempSync(join(tmpdir(), "composed-command-"));
    try {
      const child = Bun.spawnSync(
        [process.execPath, entryPoint, ...args, "--json"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            CLI_EXAMPLE_STATE: join(state, "state.json"),
            XDG_STATE_HOME: join(state, "diagnostics"),
          },
        },
      );
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe("");
      const observed: unknown = JSON.parse(child.stdout.toString());
      expect(observed).toMatchObject({
        result: {
          commandIdentity: identity,
          outcome: "success",
          transactionState: "unchanged",
        },
      });
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  },
);
