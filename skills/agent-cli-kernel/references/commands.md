# Writing a command

Paths are from the root of your repository. The code is from the
[example](example.md), a CLI named `moons`.

## The parts

One import brings everything a command needs:

```ts
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";
```

- `command({...})` declares a read-only command, and `changing({...})` a
  command that changes something. See [changing](changing.md).
- `station(causes, {...})` declares one result a command can produce. See
  [stations](stations.md).
- `contractFor({ cli, commands, causes })` checks every declaration when the
  CLI starts, and throws on the first fault.
- `contractFor().boundary` is the contract boundary. Its `authority`, `resource`
  and `path` constructors validate authority identities, resource identities
  and absolute paths.
- `runProcess(contract, setup)(argv)` is the entry. It parses, routes, runs
  the handler, writes the result and exits the process. `setup` is optional;
  it gives a run its add-ons.
- `runInProcess(contract, setup)(argv)` returns the result instead of
  writing it. See [testing](testing.md).

## Declare a command

```ts
const list = command({
  identity: "moons.list",
  route: ["list"],
  summary: "List the planets this CLI knows.",
  input: {
    ...noInput,
    options: [
      {
        name: "--at-least",
        aliases: [],
        summary: "Only planets with at least this many moons.",
        required: false,
        repeatable: false,
        value: { kind: "integer", minimum: 0, maximum: 1000 },
      },
    ],
  },
  capabilities: {},
  run: (input, context) => {
    const atLeast = input["--at-least"] ?? 0;
    const planets = [...moons]
      .filter(([, count]) => count >= atLeast)
      .map(([planet]) => planet);
    return context.result(
      {
        commandIdentity: "moons.list",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
      },
      {
        message: `${String(planets.length)} planets.`,
        data: { planets },
        effects: nothingChanged,
      },
    );
  },
});
```

- `identity` is unique in the CLI and at most 128 bytes. The built-in
  commands are named `<cli>.<name>`, as in `moons.help`. Name yours the same
  way.
- `route` holds the words typed after the CLI's name. Each route is unique,
  and no word starts with `-`. Name a route with the thing, then the action
  (`family check`, `note-name plan`, `record find`), using the glossary's
  singular word for the thing (as in `family`). When the CLI's own name is the
  thing, the route may be the action alone (`doorway start`); `moons` with
  `route: ["list"]` is this case.
- `summary` is the line that help prints for the command.
- `capabilities` is `{}` unless an add-on's guidance says otherwise.
- `stations` is optional. Without it the command has one result, the success
  `SUCCESS_UNCHANGED`.
- `run` returns `context.result(selected, facts)`. It may be `async`.

## Input

`input` always has all six keys. The kernel exports no empty input, so
declare one and spread it:

```ts
const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
```

- An argument is positional, in declared order. It has four keys: `name`,
  `summary`, `required` and `value`.
- An option has six keys: `name` as typed (`--at-least`), `aliases`,
  `summary`, `required`, `repeatable` and `value`.
- A `value` is a string rule with five keys (`kind: "string"`, `minLength`,
  `maxLength`, `choices`, `pattern`), an integer rule with three
  (`kind: "integer"`, `minimum`, `maximum`), or `null` on an option that is a
  flag. Set `choices` and `pattern` to `null` when unused. A `pattern` is a
  regular expression that the whole value must match.
- `run` receives the parsed input keyed by declared name: `input.planet`,
  `input["--at-least"]`. A slot with `required: false` may be `undefined`. A
  flag is `true` when given. A repeatable option is an array.
- An option takes its value as the next word: `--at-least 2`. The kernel
  refuses `--at-least=2`.
- `constraints` relate slots by name:
  `{ kind: "requires", ifPresent, thenPresent }` or
  `{ kind: "exclusive", members }`.
- `deadlineSupported: true` makes the command accept `--deadline-ms <n>`.
  Its handler then stops starting work once `context.signal` aborts.

The handler only ever sees input that fits the declaration. For anything
else the kernel refuses with `USAGE_INVALID_INVOCATION` and exit code 2
before the handler runs.

## The result

`selected` names one of the command's stations by `commandIdentity` and
`causeCode`. The facts of a read-only command are:

- `message`: one line for a person.
- `data`: a JSON value on a success, `null` on every other result. Build it
  from a literal or a `type` alias. An `interface` compiles there only when
  it declares a string index signature of `JsonValue`.
- `effects`: always this constant, because a read-only command changes
  nothing.

```ts
const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
```

## Register and run

Declare each command in its own `const`, then list them. A command with no
`stations` that is written inline in the `commands` array does not compile.
`src/commands.ts` builds the contract in a function, `moonsCli(home, opener)`,
because `visit` needs a folder and a program from outside the process. The
function builds the contract:

```ts
const contract = contractFor({
  cli: "moons",
  commands: [list, show, visit, pending],
  causes,
  state: state.descriptor,
  installedAddons: ["state", "programs"],
});
```

`src/cli.ts` is the whole entry file. It reads the folder and the program
from the environment:

```ts
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runProcess } from "agent-cli-kernel";
import { moonsCli } from "./commands.ts";

const xdg = process.env.XDG_STATE_HOME;
const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");

const { contract, setup } = moonsCli(
  process.env.MOONS_HOME ?? join(base, "my-agent-dojo", "moons"),
  process.env.MOONS_OPENER ?? "/usr/bin/open",
);

await runProcess(contract, setup)(process.argv.slice(2));
```

A CLI of read-only commands needs neither: it exports
`contractFor({ cli, commands, causes })` and runs `runProcess(contract)`.

## Choose add-ons

`installedAddons` on `contractFor` is the one place a CLI chooses add-ons.
Its names are `"state"`, `"programs"`, `"approval"`, `"diagnostics"` and
`"menu"`. Leave
it out and the CLI uses none.

- Name an add-on in `installedAddons` to select it. Importing it, or naming
  it in a command's `capabilities`, selects nothing.
- State is a required add-on of approval. List `"state"` with `"approval"`;
  without it the CLI throws at start-up. See
  [stations](stations.md#start-up-throws).

## What the kernel adds

- Every CLI accepts `--json`, `--help`, `--discover` and
  `--discover-command <identity>`. With `--json` the result is one JSON
  envelope on stdout.
- Without `--json`, a success of one of your commands prints its message
  to stdout, then its data unless the data is `null`. Any other result
  prints one line to stderr.
- `--help` lists the commands with their identities. `<command> --help`
  answers with exit code 0 and that command's discovery: its arguments,
  options and possible results, the same as
  `--discover-command <identity>`.
- A usage refusal's message names what was wrong, such as a missing
  argument or an option the command does not declare.
- The exit code comes from the result's cause: 0 success, 1 internal,
  2 usage, 3 domain, 4 schema, 75 transient.

## What the kernel's lint refuses

The package exports its lint as `kernelLint` from `agent-cli-kernel/lint`.
Where your repository uses it, it checks every file in `src/`, including
`src/kernel/` and `src/addons/`, and the test folders you name, and it
ignores inline `eslint-disable` comments. In `src/` it refuses:

- A file that is not TypeScript: `.js`, `.mjs`, `.cjs`, `.jsx` or `.tsx`.
  Write source as `.ts`, `.mts` or `.cts`.
- `console`, `process.stdout` and `process.stderr`. Return `data` and let
  the kernel write it.
- `Bun.spawn`, `Bun.spawnSync`, `Bun.$` and `node:child_process`. Starting a
  program belongs to the programs add-on.
- The same streams and program starts by another route. From `Bun` and
  `process`, read or import only allowlisted members such as `Bun.file(path)`,
  `Bun.which`, `Bun.YAML`, `Bun.markdown`, `process.env`, `process.argv` and
  `process.exit`, and call chainable `process` listener methods such as
  `process.on` only when discarding the result; the lint refuses streams such
  as `Bun.stdout` with the stream message, program starts with the
  program-start message, and unlisted `Bun` or `process` members such as
  `Bun.gc` or `process.emitWarning` as not on the kernel's runtime allowlist.
  It also refuses a default, namespace or
  side-effect import of `"bun"`, `node:process` or `node:console`, any
  non-type import or re-export of `node:module`, `globalThis.process`,
  `stdout` destructured from `process`, a dynamic `import()`, `require()`
  or `import.meta.require()` of those modules or of `node:child_process`,
  aliasing `require` or `import.meta.require`, computed keys on
  `import.meta`, and `Bun`, `process` or `console` passed on as a value.
  Type-only imports from `"bun"`, `node:process` and `node:module` pass.
- The `in` operator on a key the type does not declare, such as
  `"code" in error` in a `catch`. Read the value with `Object.hasOwn` and
  `Reflect.get`.
- A kernel cause code written as a free string, such as
  `causeCode: "SUCCESS_UNCHANGED"`. Write
  `"SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses`, so a renamed
  or removed code fails the type check. Your own codes, such as
  `DOMAIN_MOONS_UNKNOWN_PLANET`, need no change.

In `src/` and in tests it refuses:

- A type assertion with `as`, except `as const`.
- `any`, a non-null `!`, and a type predicate (`value is T`).
