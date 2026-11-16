import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  command,
  contractFor,
} from "../../starters/contract3/src/kernel/index.ts";
import type { InputSchema } from "../../starters/contract3/src/kernel/index.ts";

const empty = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const effects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
function host(
  identity: string,
  input: InputSchema = empty,
  route: readonly string[] = ["read"],
) {
  return {
    commandIdentity: identity,
    route,
    summary: "Read.",
    input,
    capabilities: {},
    stations: [],
    effectClass: "inspect",
    // A raw declaration needs a handler to be admitted (K1-5); never run.
    execute: () =>
      Promise.resolve({
        ok: false,
        path: "handler",
        reason: "Raw admission fixture never runs.",
      } as const),
  } as const;
}
function executable(
  identity: string,
  input: InputSchema = empty,
  route: readonly string[] = ["read"],
  onRun?: () => void,
) {
  return command({
    identity,
    route,
    summary: "Read.",
    input,
    capabilities: {},
    run: (_input, context) => {
      onRun?.();
      return context.result(
        { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects },
      );
    },
  });
}
function flags(required: boolean): InputSchema {
  return {
    ...empty,
    options: [
      {
        name: "--first",
        aliases: [],
        summary: "First choice.",
        required,
        repeatable: false,
        value: null,
      },
      {
        name: "--second",
        aliases: [],
        summary: "Second choice.",
        required: false,
        repeatable: false,
        value: null,
      },
    ],
  };
}
function operand(required: boolean): InputSchema {
  return {
    ...empty,
    arguments: [
      {
        name: "value",
        summary: "Value.",
        required,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 16,
          choices: null,
          pattern: null,
        },
      },
    ],
  };
}

test("empty root input is rejected by the constructor and raw declaration admission", () => {
  expect(() => executable("root.op", empty, [])).toThrow("Root operation");
  expect(() =>
    contractFor({ cli: "root", commands: [host("root.op", empty, [])] }),
  ).toThrow("Root operation");
});

test("either optional root flag is accepted but an invocation without a slot is refused", async () => {
  let calls = 0;
  const root = executable(
    "root.op",
    { ...flags(false), deadlineSupported: true },
    [],
    () => {
      calls++;
    },
  );
  const contract = contractFor({ cli: "root", commands: [root] });
  for (const [flag, expected] of [
    ["--first", { "--first": true }],
    ["--second", { "--second": true }],
  ] as const) {
    expect(await contract.resolve([flag])).toEqual({
      ok: true,
      value: { commandIdentity: "root.op", machine: false, input: expected },
    });
    expect((await root.execute([flag], {}, `run-${flag}`)).ok).toBe(true);
  }
  for (const argv of [
    [],
    ["--"],
    ["--json"],
    ["--json", "--"],
    ["--deadline-ms", "10"],
    ["--json", "--deadline-ms", "10"],
  ]) {
    expect(await contract.resolve(argv)).toMatchObject({
      ok: false,
      causeCode: "USAGE_INVALID_INVOCATION",
    });
  }
  for (const argv of [[], ["--"], ["--deadline-ms", "10"]]) {
    expect(await root.execute(argv, {}, "empty-run")).toMatchObject({
      ok: false,
      path: "input",
    });
    expect(await contract.parse("root.op", argv)).toMatchObject({
      ok: false,
      path: "input",
    });
    expect(
      await contract.execute("root.op", argv, "empty-contract-run"),
    ).toMatchObject({ ok: false, path: "input" });
  }
  expect(
    await contract.resolve(["--first", "--deadline-ms", "10"]),
  ).toMatchObject({
    ok: true,
    value: { input: { "--first": true }, deadlineMilliseconds: 10 },
  });
  expect(calls).toBe(2);
});

for (const required of [false, true]) {
  test(`root operand remains accepted with required=${required}`, async () => {
    const root = executable("root.op", operand(required), []);
    const contract = contractFor({ cli: "root", commands: [root] });
    expect(await contract.resolve(["value"])).toEqual({
      ok: true,
      value: {
        commandIdentity: "root.op",
        machine: false,
        input: { value: "value" },
      },
    });
    expect(await contract.resolve(["--"])).toMatchObject({
      ok: false,
      causeCode: "USAGE_INVALID_INVOCATION",
    });
    expect((await root.execute(["value"], {}, "operand-run")).ok).toBe(true);
  });
}

test("a required root option retains its ordinary required-slot grammar", async () => {
  const contract = contractFor({
    cli: "root",
    commands: [executable("root.op", flags(true), [])],
  });
  expect(await contract.resolve(["--second"])).toMatchObject({
    ok: false,
    causeCode: "USAGE_INVALID_INVOCATION",
  });
  expect(await contract.resolve(["--first"])).toMatchObject({
    ok: true,
    value: { commandIdentity: "root.op", input: { "--first": true } },
  });
  expect(await contract.resolve([])).toMatchObject({
    ok: false,
    commandIdentity: "root.dispatch",
  });
});

for (const identity of ["a".repeat(128), "é".repeat(64)]) {
  test(`128 UTF-8 byte host identity is accepted (${identity.length} code units)`, async () => {
    const raw = contractFor({ cli: "specimen", commands: [host(identity)] });
    expect(await raw.resolve(["read"])).toMatchObject({
      ok: true,
      value: { commandIdentity: identity },
    });
    expect(executable(identity).commandIdentity).toBe(identity);
    expect(() => executable(`${identity}a`)).toThrow("128 UTF-8 bytes");
    expect(() =>
      contractFor({ cli: "specimen", commands: [host(`${identity}a`)] }),
    ).toThrow("128 UTF-8 bytes");
  });
}

for (const prefix of ["a".repeat(110), "é".repeat(55)]) {
  test(`generated built-in identities obey the UTF-8 bound (${prefix.length} code units)`, () => {
    const contract = contractFor({ cli: prefix, commands: [] });
    expect(
      contract.discoverCommand(`${prefix}.command-discovery`)?.command
        .commandIdentity,
    ).toBe(`${prefix}.command-discovery`);
    expect(() => contractFor({ cli: `${prefix}a`, commands: [] })).toThrow(
      "128 UTF-8 bytes",
    );
  });
}

test("changing declaration admission enforces the same identity and root input bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contract3-declaration-"));
  try {
    const source = join(directory, "starters/contract3/src");
    await mkdir(join(source, "addons/state"), { recursive: true });
    await cp(
      new URL("../../starters/contract3/src/kernel", import.meta.url),
      join(source, "kernel"),
      { recursive: true },
    );
    const fixture = join(source, "addons/state/admission.ts");
    await writeFile(
      fixture,
      await readFile(
        new URL("fixtures/declaration-admission.ts.txt", import.meta.url),
      ),
    );
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      validIdentities: 2,
      oversizedRejected: 2,
      rootInvocationControls: 2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
