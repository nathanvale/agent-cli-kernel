import { expect } from "bun:test";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import { runFamily, stateFixture } from "./harness.ts";

// R12 (F10): never enter a handler with a declared capability absent or
// different from the one that passed validation.
const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const received: unknown[] = [];
function fixture() {
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: {
      arguments: [],
      options: [],
      constraints: [],
      deadlineSupported: false,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { diagnostics: true },
    run: (_input, context) => {
      received.push(context.diagnostics);
      return context.result(
        { commandIdentity: "specimen.read", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      );
    },
  });
  return contractFor({
    cli: "specimen",
    commands: [read],
    installedAddons: ["diagnostics"],
  });
}
const diagnostics = () => ({ record() {} });
// Either refused before the handler, or entered with the validated object.
async function inspectObserved(context: object, validated: () => unknown) {
  received.length = 0;
  const executed = await fixture().execute(
    "specimen.read",
    [],
    "run-1",
    context,
  );
  if (received.length === 0) expect(executed.ok).toBe(false);
  else {
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(validated());
  }
}
let changing: Promise<unknown> | undefined;
async function changingObserved(id: string) {
  changing ??= stateFixture("context-changing");
  const observed: unknown = Reflect.get(Object(await changing), id);
  return observed;
}
const refusedOrSame = (observed: unknown) =>
  expect<unknown[]>([
    { executed: false, entries: 0, sameAsValidated: false },
    { executed: true, entries: 1, sameAsValidated: true },
  ]).toContainEqual(observed);

runFamily("R12", {
  "R12.inspect-hidden-capability": () => {
    const capability = diagnostics();
    const context = {};
    Object.defineProperty(context, "diagnostics", {
      value: capability,
      enumerable: false,
    });
    return inspectObserved(context, () => capability);
  },
  "R12.inspect-getter-capability": () => {
    const first = diagnostics();
    let reads = 0;
    const context = {};
    Object.defineProperty(context, "diagnostics", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? first : {};
      },
    });
    return inspectObserved(context, () => first);
  },
  "R12.inspect-plain-twin": async () => {
    const capability = diagnostics();
    await inspectObserved({ diagnostics: capability }, () => capability);
    expect(received).toEqual([capability]);
  },
  "R12.changing-hidden-capability": async () =>
    refusedOrSame(await changingObserved("R12.changing-hidden-capability")),
  "R12.changing-getter-capability": async () =>
    refusedOrSame(await changingObserved("R12.changing-getter-capability")),
  "R12.changing-plain-twin": async () =>
    expect(await changingObserved("R12.changing-plain-twin")).toEqual({
      executed: true,
      entries: 1,
      sameAsValidated: true,
    }),
});
