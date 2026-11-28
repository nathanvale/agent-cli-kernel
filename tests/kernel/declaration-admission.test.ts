import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { InputSchema } from "../../kernel/src/kernel/index.ts";
import {
  emptyInput as empty,
  inertState,
  refusedHandoff,
  stationWords,
  unchanged as effects,
} from "./kernel-repair/shapes.ts";
import { neverRuns } from "./kernel-repair/handlers.ts";

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
    execute: neverRuns,
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
  const directory = await mkdtemp(join(tmpdir(), "kernel-declaration-"));
  try {
    const source = join(directory, "kernel/src");
    await mkdir(join(source, "addons/state"), { recursive: true });
    await cp(
      new URL("../../kernel/src/kernel", import.meta.url),
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

const lookOnlyOptionRefusal =
  "Changing commands take no --check or --dry-run option. Repair: declare a separate inspect route for the look-only work, such as `<thing> plan` beside `<thing> apply` (ADR 0002).";

const changingCauses = {
  ...commonCauses,
  DOMAIN_SPECIMEN_HELD: refusedHandoff,
  DOMAIN_SPECIMEN_UNRESOLVED: refusedHandoff,
} as const;

function flagSchema(
  entries: readonly {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly summary?: string;
  }[],
): InputSchema {
  return {
    ...empty,
    options: entries.map((entry) => ({
      name: entry.name,
      aliases: entry.aliases ?? [],
      summary: entry.summary ?? "Option.",
      required: false,
      repeatable: false,
      value: null,
    })),
  };
}

function changingStations(identity: string) {
  const handoff = {
    handoff: {
      owner: "operator",
      reason: "Inspect unfinished work.",
      inspect: [{ kind: "command", command: "specimen.pending", args: [] }],
    },
  } as const;
  return [
    station(changingCauses, {
      commandIdentity: identity,
      causeCode: "SUCCESS_COMPLETED",
      trigger: "The change finished.",
      independentObservable: "The target reflects the change.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      ...stationWords,
    }),
    station(changingCauses, {
      commandIdentity: identity,
      causeCode: "DOMAIN_SPECIMEN_HELD",
      trigger: "Another run holds this scope.",
      independentObservable: "Active scope lease.",
      repairAction: "Wait and inspect pending work.",
      guidance: handoff,
      ...stationWords,
    }),
    station(changingCauses, {
      commandIdentity: identity,
      causeCode: "DOMAIN_SPECIMEN_UNRESOLVED",
      trigger: "An earlier run did not finish.",
      independentObservable: "Unresolved case in pending.",
      repairAction: "Inspect pending work.",
      guidance: handoff,
      ...stationWords,
    }),
  ] as const;
}

function pendingCommand() {
  return command({
    identity: "specimen.pending",
    route: ["pending"],
    summary: "Report unfinished work.",
    input: empty,
    capabilities: {},
    stations: [
      station(changingCauses, {
        commandIdentity: "specimen.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Report completed.",
        independentObservable: "Pending list.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Inspect each unfinished item.",
          },
        },
        ...stationWords,
      }),
    ],
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: "specimen.pending",
          causeCode: "SUCCESS_UNCHANGED",
        },
        { message: "Pending.", data: [], effects },
      ),
  });
}

function declareChanging(
  effectClass: "repository-local" | "external",
  input: InputSchema,
  identity = "specimen.apply",
  route: readonly string[] = ["apply"],
  state = inertState("specimen"),
) {
  return changing({
    identity,
    route,
    summary: "Apply a change.",
    input,
    capabilities: {},
    effectClass,
    effects: ["specimen.write"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_SPECIMEN_HELD",
    unresolvedCaseCause: "DOMAIN_SPECIMEN_UNRESOLVED",
    stations: changingStations(identity),
    run: () => Promise.reject(new Error("Never runs.")),
  });
}

function admitRawChanging(
  effectClass: "repository-local" | "external",
  input: unknown,
): void {
  const state = inertState("specimen");
  Reflect.apply(contractFor, undefined, [
    {
      cli: "specimen",
      causes: changingCauses,
      state,
      installedAddons: ["state"],
      commands: [
        pendingCommand(),
        {
          commandIdentity: "specimen.apply",
          route: ["apply"],
          summary: "Apply a change.",
          input,
          capabilities: {},
          effectClass,
          effects: ["specimen.write"],
          ifNoResult: state.ifNoResult,
          heldLockCause: "DOMAIN_SPECIMEN_HELD",
          unresolvedCaseCause: "DOMAIN_SPECIMEN_UNRESOLVED",
          stations: changingStations("specimen.apply"),
          execute: neverRuns,
        },
      ],
    },
  ]);
}

test("changing() and raw contractFor refuse --dry-run and --check by name or alias", () => {
  const forbiddenInputs = [
    flagSchema([{ name: "--dry-run" }]),
    flagSchema([{ name: "--check" }]),
    flagSchema([{ name: "--verify", aliases: ["--check"] }]),
    flagSchema([{ name: "--preview", aliases: ["--dry-run"] }]),
  ];
  for (const effectClass of ["repository-local", "external"] as const) {
    for (const input of forbiddenInputs) {
      expect(() => declareChanging(effectClass, input)).toThrow(
        new Error(lookOnlyOptionRefusal),
      );
      expect(() => admitRawChanging(effectClass, input)).toThrow(
        new Error(lookOnlyOptionRefusal),
      );
    }
  }
});

test("SOL-1 dry-run and check changing prototype is refused at start-up", () => {
  const input = flagSchema([
    { name: "--check", summary: "Only look." },
    { name: "--dry-run", summary: "Only look." },
  ]);
  expect(() =>
    declareChanging("repository-local", input, "probe.write", ["write"]),
  ).toThrow(new Error(lookOnlyOptionRefusal));
});

test("SOL-2 P24 changing --dry-run prototype is refused at start-up", () => {
  const input = flagSchema([
    { name: "--dry-run", summary: "Only inspect the intended change." },
  ]);
  expect(() =>
    declareChanging("repository-local", input, "dryrun.run", ["run"]),
  ).toThrow(new Error(lookOnlyOptionRefusal));
});

test("NEON-mini mutate --dry-run and --check prototype is refused at start-up", () => {
  const input = flagSchema([
    { name: "--dry-run", summary: "Preview only." },
    { name: "--check", summary: "Check only." },
  ]);
  expect(() =>
    declareChanging("repository-local", input, "proto.mutate", ["mutate"]),
  ).toThrow(new Error(lookOnlyOptionRefusal));
});

test("NEON-laptop M2 changing --dry-run and --check prototype is refused at start-up", () => {
  const input = flagSchema([
    { name: "--dry-run", summary: "Dry run." },
    { name: "--check", summary: "Check." },
  ]);
  expect(() =>
    declareChanging("repository-local", input, "m2.mutate", ["mutate"]),
  ).toThrow(new Error(lookOnlyOptionRefusal));
});

test("an inspect command may still declare --check and --dry-run, and changing commands allow other options", async () => {
  const inspectInput = flagSchema([
    { name: "--check", summary: "Check." },
    { name: "--dry-run", summary: "Dry run." },
  ]);
  const inspectContract = contractFor({
    cli: "specimen",
    commands: [executable("specimen.read", inspectInput)],
  });
  expect(await inspectContract.resolve(["read", "--check"])).toMatchObject({
    ok: true,
    value: { commandIdentity: "specimen.read", input: { "--check": true } },
  });
  expect(
    contractFor({
      cli: "specimen",
      commands: [host("specimen.read", inspectInput)],
    }).cli,
  ).toBe("specimen");
  const state = inertState("specimen");
  const otherOptions = flagSchema([
    { name: "--check-mode", aliases: ["--dry-run-dir"] },
  ]);
  expect(
    contractFor({
      cli: "specimen",
      causes: changingCauses,
      state,
      installedAddons: ["state"],
      commands: [
        pendingCommand(),
        declareChanging(
          "repository-local",
          otherOptions,
          "specimen.apply",
          ["apply"],
          state,
        ),
      ],
    }).cli,
  ).toBe("specimen");
});

test("a raw changing declaration with malformed input still throws Invalid input declaration.", () => {
  const validDryRunOption = flagSchema([{ name: "--dry-run" }]).options[0];
  const validCheckOption = flagSchema([{ name: "--check" }]).options[0];
  const malformedInputs: readonly unknown[] = [
    null,
    { ...empty, options: "bad" },
    { ...empty, options: [null] },
    { ...empty, options: [{ name: "--other", aliases: "bad" }] },
    { options: [{ name: "--dry-run", aliases: [] }] },
    { ...empty, arguments: "bad", options: [validDryRunOption] },
    {
      ...empty,
      options: [
        {
          name: "--dry-run",
          aliases: [],
          summary: "",
          required: "bad",
          repeatable: 1,
          value: "bad",
        },
      ],
    },
    {
      ...empty,
      options: [{ ...validCheckOption, aliases: [123] }],
    },
    {
      ...empty,
      get options() {
        return [validDryRunOption];
      },
    },
    Object.defineProperty({ ...empty }, "options", {
      value: [validCheckOption],
      enumerable: false,
    }),
  ];
  for (const input of malformedInputs) {
    expect(() => admitRawChanging("repository-local", input)).toThrow(
      new Error("Invalid input declaration."),
    );
  }
});
