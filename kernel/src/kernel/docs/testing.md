# Testing a command

A command needs two kinds of test. The code is from the
[example](example.md).

## In process

`runInProcess(contract)` returns a function that runs one invocation inside
the test and returns its result. Nothing is printed. A command that uses the
programs add-on still starts the programs it declares.

```ts
const run = runInProcess(contract);

async function resultOf(argv: readonly string[]) {
  const ran = await run(argv);
  if (ran.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${ran.kind}.`);
  return ran.envelope.result;
}
```

- `kind` is `envelope` for a run that produced a result. Narrow on it first.
- `envelope` is the validated envelope that `--json` would write.
  `envelope.result` holds `causeCode`, `outcome`, `exitCode`, `data` and the
  `next` or `handoff` guidance.
- Assert the cause, the exit code and the data of each result:

```ts
test("show refuses a planet it does not know and points at list", async () => {
  expect(await resultOf(["show", "pluto"])).toMatchObject({
    exitCode: 3,
    outcome: "refused",
    causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
    data: null,
    next: { kind: "command", command: "moons.list", args: [] },
  });
});
```

## Through the real process

Reach each station you declare as `required` with a test through the real
process. Start the real entry file and check what a caller sees:
the exit code, stdout and stderr.

```ts
const cli = join(import.meta.dir, "../src/cli.ts");

function invoke(...argv: string[]) {
  const ran = Bun.spawnSync([process.execPath, cli, ...argv], {
    timeout: 20_000,
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}
```

```ts
test("a refusal exits with its cause's code and writes one line to stderr", () => {
  const ran = invoke("show", "pluto");
  expect(ran.exitCode).toBe(3);
  expect(ran.stdout).toBe("");
  expect(ran.stderr).toBe(
    "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n",
  );
});
```

- With `--json`, every result is one envelope on stdout, and stderr is
  empty.
- The stamped lint allows `Bun.spawnSync` in tests. It refuses it in `src/`.
- Read `JSON.parse` output into a variable typed `unknown`, then assert on
  it. The lint refuses an `any` that flows on.

## Reach every station

- Write one test for each station the command declares: its success and
  each refusal or failure.
- Reach a result by making its condition real: input that names a missing
  thing, or a temporary folder that holds the wrong contents. Keep test
  switches out of `src/`.
- When a result depends on something outside the process, such as a folder
  or a clock, build the contract in a function that takes it as a parameter.
  A test then passes its own.
- A result that is hard to reach is still `required`. See
  [reachability](stations.md#reachability).
