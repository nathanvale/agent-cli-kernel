# Writing a changing command

Paths are from the root of your repository. The code is from the
[example](example.md): `visit <planet>` writes the planet's page, then asks
an opener program to show it, and `pending` lists the visits that never
finished.

## When a command is changing

A command that changes a file, a program's state or anything else is a
changing command. Its effect class is `repository-local` or `external`;
`visit` is `external`, because it asks another program to act.

It needs three things:

- `"state"` in `installedAddons`, and `"programs"` too when it starts a
  program. See [commands](commands.md#choose-add-ons).
- One state add-on from `stateAddon({ root, report })`. `root` is the state
  folder. `report` names the command that lists unfinished changes.
- The declaration from `changing({...})`.

```ts
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
```

```ts
const state = stateAddon({
  root: join(home, "state"),
  report: "moons.pending",
});
```

Take the state folder from an argument or a variable, as `moons` takes
`MOONS_HOME`. A test then passes its own folder, and verify-cli puts it in a
run's scratch folder.

`changing` takes `command`'s fields, and these beside `capabilities`:

```ts
    capabilities: { programs: true },
    effectClass: "external",
    effects: ["planet.record", "viewer.open-request"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_MOONS_VISIT_HELD",
    unresolvedCaseCause: "DOMAIN_MOONS_VISIT_UNRESOLVED",
```

- `effects` names each change the command can make, once each.
- `ifNoResult` comes from the state add-on. It points a caller that got no
  result at the `report` command.
- `heldLockCause` is the station for "another change to this scope is
  running". `unresolvedCaseCause` is the station for "an earlier change to
  this scope never finished".

Give each run the add-ons' run setup, and pass it to `runProcess` and
`runInProcess` beside the contract:

```ts
  return {
    contract,
    setup: {
      addons: { programs: programsAddon() },
      emergencyRecord: state.emergencyRecord,
    },
  };
```

## Start-up throws

`changing` and `contractFor` throw these when the CLI starts.

| Message                                                          | Cause                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Invalid changing declaration.`                                  | `effects` repeats an identifier.                                                     |
| `Changing commands require the state add-on.`                    | `installedAddons` does not list `"state"`.                                           |
| `ifNoResult must come from the state add-on descriptor.`         | `ifNoResult` is a copy, not the value `state.descriptor` holds.                      |
| `ifNoResult must name a declared inspect command.`               | `report` names a command that `commands` does not hold.                              |
| `ifNoResult needs explicit further inspection guidance.`         | The `report` command's success guidance is `{ kind: "done" }`.                       |
| `ifNoResult step <identity> [] can never parse: ...`             | The `report` command requires an argument or option. It is run with none.            |
| `Changing commands need distinct coordination refusal stations.` | `heldLockCause` and `unresolvedCaseCause` are one cause.                             |
| `Coordination refusal causes are host-owned.`                    | Either names a kernel cause, such as `DOMAIN_AUTHORITY_REQUIRED`. Add your own rows. |
| `Coordination refusal requires an unchanged handoff.`            | Either station is not refused and unchanged with a `handoff`.                        |

The `report` command's success guidance tells the caller what to do with
the list:

```ts
        guidance: {
          next: {
            kind: "instruction",
            text: "Check each unfinished visit before that planet is visited again.",
          },
        },
```

## The report command

`pending` is an ordinary read-only command. It reads `state.report()`,
which never creates the state folder:

```ts
      const report = state.report();
      if (!report.ok && report.reason !== "missing")
```

- `report.ok` is true with `report.unfinished`: one entry for each
  unresolved case, with its `operationId`, `commandIdentity` and `effects`.
- `report.reason` is `"missing"` before the first change makes the state
  folder. Answer it as an empty list. Refuse `"unreadable"` and `"corrupt"`
  with a station of the command's own.

## The transaction

**Look and ask first, change last.** Every look-up and every question to
the caller happens before the transaction opens, because the transaction
holds a lock on its scope until its work returns. A reviewer refuses a
handler that looks something up or waits for a person inside the work; no
check can see it.

```ts
      const outcome = await state.transaction(
        context.state,
        {
          command: "moons.visit",
          scope: { resources: [{ resource: "planet", key: input.planet }] },
          facts: { planet: input.planet },
        },
```

- `transaction(context.state, declaration, work)` opens the transaction.
  `scope` is what it locks; see [Choosing the scope](#choosing-the-scope).
  `facts` is kept with the case.
- Inside `work`, call `transaction.record(effect, operation, readBack)`
  once for each effect, in order, and await each one.
- `outcome.kind` is `"ran"`, or the refusal that kept the work from
  running: `"held-lock"`, `"unresolved-case"` or another kind. Select a
  station for each:

```ts
      if (outcome.kind !== "ran") {
        const causeCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_MOONS_VISIT_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_MOONS_VISIT_UNRESOLVED"
              : "DOMAIN_MOONS_VISIT_UNAVAILABLE";
```

A refusal changed nothing, so its facts carry `effects: nothingChanged`.
After a run, select by `outcome.proof.transactionState` and pass
`transaction: outcome.proof` as the facts' effects. `completed` selects the
success `SUCCESS_COMPLETED`. Anything else selects a failed station whose
row has that transaction state; `visit` declares one row with
`transactionState: "unknown"`, `DOMAIN_MOONS_VISIT_UNCONFIRMED`.

## Read-back

A read-back answers "is the change there now?" from the real resource. A
read-back that returns false leaves its effect uncertain: the run fails with transaction state `unknown`, and the case stays unresolved for
its scope. The `report` command lists it, and the next change to that scope
is refused with the unresolved-case station.

A file: read it back and compare.

```ts
await transaction.record(
  "planet.record",
  async () => {
    await mkdir(join(home, "visits"), { recursive: true });
    await writeFile(page, text);
  },
  async () => (await readFile(page, "utf8")) === text,
);
```

An action you start and do not wait for, such as opening a page or an
editor:

- Name the effect for what you can confirm: the request was delivered
  (`viewer.open-request`), never "the viewer showed it". An editor's
  window can appear seconds after its opener returns.
- Start the opener through the programs add-on, inside the record:
  `context.programs.domain(recorded).start(request)`. The executable is an
  absolute path. Check it once the contract is built, so a relative path
  throws `Expected absolute path.` when the CLI starts:

```ts
const viewer = contract.boundary.path(opener);
```

- Read back from the opener's own result: exit code 0 and
  `terminationConfirmed`.

```ts
await transaction.record(
  "viewer.open-request",
  (recorded) =>
    context.programs.domain(recorded).start({
      executable: viewer,
      args: [page],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4_096,
      shutdownMilliseconds: 1_000,
    }),
  (opened) =>
    Promise.resolve(opened.exitCode === 0 && opened.terminationConfirmed),
);
```

Keep the record and the request as two effects. When the opener fails, the
result then says the page was written (`completed`) and the request is
uncertain.

## Stops: what is left behind

- Stopped before the transaction opens, by Ctrl-C or SIGTERM: the process
  exits 130 or 143, prints nothing, and leaves nothing pending.
- Stopped inside the transaction, as by SIGTERM: the process exits 143 and
  prints nothing. The programs add-on stops a program the record started.
  The case stays unresolved: the `report` command lists it, and the next change
  to that scope is refused with the unresolved-case station.

## A case no command can close

On macOS the state add-on cannot close an unresolved case. A host's close
command, `state.close(context.state, request)`, returns `unavailable` with
reason `stopped-owner-proof-unqualified`, and `state.capabilities()`
reports `stoppedOwnerProof` as `unavailable`. So:

- Keep each scope narrow. A stuck case then blocks one destination, not the
  tool.
- Name the hand repair in the unresolved-case and unconfirmed stations'
  repair action. A person checks the effect by hand, then, with no change
  running, moves the case folder `operations/<operationId>` out of the state
  folder and keeps it. The `report` command lists that `operationId`, and
  the next change to the scope runs.

```ts
const handRepair =
  "Read pending. With no visit running, check the planet by hand, then move its case folder out of state/operations in the moons home and keep it.";
```

## Choosing the scope

A scope is what one unresolved case blocks, and what the lock holds while
the work runs.

- Scope a destination's commands to that destination, never to the whole
  tool. `visit` scopes to the planet: an interrupted visit to venus blocks
  venus, and a visit to earth still runs.
- Keep every resource the work writes inside the scope. Give each
  destination its own record, as `visit` writes `visits/<planet>.txt`. A
  record every destination shares belongs to every scope, and would widen
  the scope to the whole tool.

## Testing

Build the contract in a function, as [testing](testing.md#in-process)
shows, so each test passes its own state folder and opener. Reach a failed
read-back with an opener that exits non-zero, then assert the case it
leaves:

```ts
test("a failed open leaves a case that pending lists and that blocks only that planet", async () => {
  const home = newHome();
  const failing = moonsIn(home, "/usr/bin/false");
  expect(await failing(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "failed",
    causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
    effects: {
      completed: ["planet.record"],
      uncertain: ["viewer.open-request"],
    },
  });
```

The same test then shows `pending` listing the case, a second visit to
earth refused as unresolved with a working opener, and a visit to mars
that succeeds.

Then drive the real CLI with verify-cli's changing-command feature, in
`node_modules/agent-cli-kernel/skills/verify-cli/features/changing-command.md`.
Its scenario runs a first change, a second run, an empty report, a run
stopped by its time limit, the refusal and the listing it leaves, and a
change to another scope.
