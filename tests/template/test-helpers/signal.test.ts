import { expect, test } from "bun:test";
import { signalGroupIfPresent, signalIfPresent } from "../../support/signal.ts";

const root = process.getuid?.() === 0;

test("signalIfPresent reports false for a process that has exited and been reaped", async () => {
  const child = Bun.spawn(["true"]);
  await child.exited;
  expect(signalIfPresent(child.pid, "SIGKILL")).toBe(false);
});

test("signalIfPresent signals a live process and reports true", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  expect(signalIfPresent(child.pid, "SIGKILL")).toBe(true);
  expect(await child.exited).not.toBe(0);
});

function oldestForeignProcess(): number | undefined {
  const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,uid="], {
    timeout: 5_000,
  });
  if (listed.exitCode !== 0) return undefined;
  const ours = process.getuid?.();
  return listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      ([pid, uid]) =>
        Number.isInteger(pid) && Number.isInteger(uid) && uid !== ours,
    )
    .map(([pid]) => pid ?? 0)
    .sort((a, b) => a - b)
    .find((pid) => pid > 0);
}

const foreign = root ? undefined : oldestForeignProcess();

test.skipIf(foreign === undefined)(
  "signalIfPresent rethrows EPERM, because the process exists and is not ours",
  () => {
    expect(() => signalIfPresent(foreign ?? 0, "SIGCONT")).toThrow("EPERM");
  },
);

test("signalGroupIfPresent reports false for a group whose members are all reaped", async () => {
  const child = Bun.spawn(["true"], { detached: true });
  await child.exited;
  expect(signalGroupIfPresent(child.pid, "SIGKILL")).toBe(false);
});

test("signalGroupIfPresent signals a live group and reports true", async () => {
  const child = Bun.spawn(["sleep", "30"], { detached: true });
  expect(signalGroupIfPresent(child.pid, "SIGKILL")).toBe(true);
  expect(await child.exited).not.toBe(0);
});
