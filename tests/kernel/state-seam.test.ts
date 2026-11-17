import type { CommandResult } from "../../kernel/src/kernel/index.ts";
import { expect, test } from "bun:test";
import { contractFor, command } from "../../kernel/src/kernel/index.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";

test("a declared installed name or arbitrary host callback cannot acquire the state issuer", () => {
  let called = false;
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "specimen",
        installedAddons: ["state"],
        commands() {
          called = true;
          return [];
        },
      },
    ]);
  }).toThrow("Host callbacks never receive a state issuer");
  expect(called).toBe(false);
  expect(() =>
    contractFor({ cli: "specimen", installedAddons: ["state"], commands: [] }),
  ).toThrow("descriptor created by contractFor.stateAddon");
  expect(() => {
    Reflect.apply(contractFor, undefined, [
      {
        cli: "specimen",
        installedAddons: ["state"],
        state: { name: "state" },
        commands: [],
      },
    ]);
  }).toThrow("descriptor created by contractFor.stateAddon");
});

test("a handler cannot return a cloned result or a prior invocation with reused run text", async () => {
  let previous: CommandResult<"specimen.read"> | undefined;
  let copy = false;
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) => {
      if (previous) return copy ? { ...previous } : previous;
      const result = context.result(
        { commandIdentity: "specimen.read", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: unchanged,
        },
      );
      previous = result;
      return result;
    },
  });
  const contract = contractFor({ cli: "specimen", commands: [read] });
  const first = await contract.execute("specimen.read", [], "same-text");
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("Expected initial handler result.");
  const other = contractFor({ cli: "specimen", commands: [read] });
  expect(await other.buildResult(first.value)).toMatchObject({
    ok: false,
    path: "result",
  });
  expect((await contract.buildResult(first.value)).ok).toBe(true);
  expect(
    await contract.execute("specimen.read", [], "same-text"),
  ).toMatchObject({ ok: false, path: "result" });
  copy = true;
  expect(
    await contract.execute("specimen.read", [], "same-text"),
  ).toMatchObject({ ok: false, path: "result" });
});
