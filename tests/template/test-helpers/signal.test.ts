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

test.skipIf(root)(
  "signalIfPresent rethrows EPERM, because the process exists and is not ours",
  () => {
    expect(() => signalIfPresent(1, "SIGCONT")).toThrow("EPERM");
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
