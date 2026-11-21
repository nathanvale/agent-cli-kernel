# Declaring a command's results

A station is one result a command can produce: a cause code and the fixed
words that go with it. A handler ends each run by selecting one.
`--discover-command <identity>` lists a command's stations, so a caller
knows every result before it runs the command.

The code is from the [example](example.md).

## Start with none

A command without `stations` has one result, the success
`SUCCESS_UNCHANGED`.

Once a command declares any station, declare its success station too. A
handler can select only the stations its command declares. Selecting another
one does not compile.

## Cause rows

A cause row fixes what a result means. `commonCauses` holds the kernel's
rows. Add your own beside them:

```ts
const causes = {
  ...commonCauses,
  DOMAIN_MOONS_UNKNOWN_PLANET: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_MOONS_VISIT_HELD: handoffRow,
  DOMAIN_MOONS_VISIT_UNRESOLVED: handoffRow,
  DOMAIN_MOONS_VISIT_UNAVAILABLE: handoffRow,
  DOMAIN_MOONS_VISIT_UNCONFIRMED: {
    ...handoffRow,
    outcome: "failed",
    transactionState: "unknown",
  },
} as const satisfies CauseTable;
```

- The `DOMAIN_MOONS_VISIT_` rows belong to `visit`, a changing command.
  `handoffRow` is a refused, unchanged, domain row with exit code 3 and
  guidance `handoff`.
- `outcome` is `success`, `refused` or `failed`. A refusal comes before any
  attempted change.
- `transactionState` is `unchanged` on every row of a read-only command.
- `failureClass` and `exitCode` go together: `usage` 2, `domain` 3,
  `schema` 4, `internal` 1, `transient` 75. A success has `null` and 0.
- `guidance` names the arm its stations must use: `next` or `handoff`.
- Pass the same table to every `station(causes, ...)` and to
  `contractFor({ causes })`.
- A cause sits on one station of a command. Two refusals that a caller must
  tell apart need two rows.
- `DOMAIN_PRECONDITION_UNMET` is a common row with the same shape as the one
  above. Use it when a command has a single refusal.

## A station

```ts
station(causes, {
  ...stationWords,
  commandIdentity: "moons.show",
  causeCode: "DOMAIN_MOONS_UNKNOWN_PLANET",
  trigger: "The planet is not one this CLI knows.",
  repairAction: "Use a planet that the list command returns.",
  guidance: {
    next: { kind: "command", command: "moons.list", args: [] },
  },
  independentObservable: "moons.show:unknown-planet",
}),
```

- `trigger` says when the result happens.
- `repairAction` is the station's repair action: `null` on a success, otherwise
  the fixed guidance explaining the repair or the named handoff.
- `guidance` is `{ next }` or `{ handoff }`, as the row says.
- `independentObservable` names the evidence that the result happened.
  Discovery does not print it.
- Three words are the same on almost every station. Declare them once:

```ts
const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
```

Write stations inline in the command's `stations` array, as the example
does. A station list annotated with a wider type, such as
`DeclaredStation[]`, loses its literal types, and `contractFor` then reports
a long type error at `commands`.

## Guidance

A `next` step has one of four kinds:

- `{ kind: "done" }`: only on a success.
- `{ kind: "instruction", text }`: words for the caller.
- `{ kind: "command", command, args }`: another command of this CLI, by
  identity. The built-in `<cli>.help`, `<cli>.discovery` and
  `<cli>.command-discovery` count.
- `{ kind: "retry" }`: on every row with `retryable: true`, and on no other.
  Such a station sets `retryDelayPolicy` to
  `{ kind: "bounded", minimumMilliseconds, maximumMilliseconds }`, and its
  result carries a `retryDelayMilliseconds` fact inside those bounds.

A `handoff` is `{ owner, reason, inspect }`. `owner` is `"human"` or
`"operator"`. `inspect` holds at least one instruction or command step, and
a command step there names a read-only command.

## Braces

In `repairAction` and in guidance text, braces mark a template token.
Guidance text is an instruction's `text`, a command step's `args`, and a
handoff's `reason`, its resource `kind` and `id`, and its `inspect` steps.

- The tokens are `{runId}`, `{completedEffects}`, `{remainingEffects}`,
  `{uncertainEffects}`, `{idempotencyKey}` and `{binding.<name>}`.
- `{binding.<name>}` must be the whole of a command-step argument or the
  whole of a handoff's resource `id`, and the result then carries a
  `bindings` fact with that name.
- Any other brace makes `contractFor` throw when the CLI starts, with
  `Invalid run binding placement or guidance template token.` or
  `Malformed guidance template token.` The message names no station, so
  search your repair action and guidance text for a brace.
- Describe a JSON shape in words there.
- `trigger`, `summary` and a result's `message` are plain text. Braces are
  safe in them.

## Reachability

`reachability: "required"` says a test must reach the station.
`"declared-unreachable"`, with a reason in `unreachableRationale`, is only
for a result that cannot happen. Unreachable means impossible, not
untested. A result that is hard to reach stays `required`. See [testing](testing.md#reach-every-station).

## Kernel stations

Kernel stations are the stations the kernel adds to every command, such as the
usage refusal and the internal failures. `--discover-command <identity>` lists
them after yours. They need no declaration.

## Start-up throws

`station` and `contractFor` throw these when the CLI starts.

| Message                                                                   | Cause                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid run binding placement or guidance template token.`               | A brace in repair action or guidance text. See [Braces](#braces).                                                                                                                                                                                    |
| `Station identity is undeclared, duplicated or bound to another command.` | Two stations of one command share a cause, or a station's cause is missing from the table `contractFor` got.                                                                                                                                         |
| `Station disagrees with the CLI cause owner.`                             | The station's cause row differs from the row for that cause in the table `contractFor` got.                                                                                                                                                          |
| `Done requires success.`                                                  | `{ kind: "done" }` on a station that is not a success.                                                                                                                                                                                               |
| `Wrong guidance arm.`                                                     | `next` where the row says `handoff`, or the reverse.                                                                                                                                                                                                 |
| `Retry correlation.`                                                      | `{ kind: "retry" }` on a row that is not retryable, or another step on one that is.                                                                                                                                                                  |
| `Guidance target is not declared with the required effect class.`         | A command step names a command that `commands` does not hold.                                                                                                                                                                                        |
| `Approval requires the state add-on: ...`                                 | `installedAddons` lists `"approval"` without `"state"`; the message ends with the repair. The CLI stops on every invocation, even `--help`: exit code 1, nothing on stdout, the message on stderr. See [Choose add-ons](commands.md#choose-add-ons). |
| `Unreachable needs a reviewed rationale.`                                 | `declared-unreachable` without a reason, or `required` with one.                                                                                                                                                                                     |
