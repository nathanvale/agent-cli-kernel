# Writing a changing command

Paths are from the root of your repository. The code is from the
[example](example.md) and its [example tests](example-tests.md):
`visit <planet>` writes the planet's page, then launches an opener program
to show it, and `pending` lists the visits that never finished.

## When a command is changing

A command that changes a file, a program's state or anything else is a
changing command. Its effect class is `repository-local` or `external`;
`visit` is `external`, because it asks another program to act.
A command that only looks is never a changing command; see
[commands](commands.md).

It needs three things:

- `"state"` in `installedAddons`, and `"programs"` too when it starts a
  program. See [commands](commands.md#choose-add-ons).
- One state add-on from `stateAddon({ root, report })`. `root` is the state
  folder. `report` names the command that lists unfinished changes.
- The declaration from `changing({...})`.

```ts
import {
  programDetails,
  programsAddon,
} from "agent-cli-kernel/addons/programs";
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
    effects: ["planet.record", "viewer.launch"],
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

| Message                                                                | Cause                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Invalid changing declaration.`                                        | `effects` is empty or repeats an identifier.                                                                         |
| `Changing commands require the state add-on.`                          | `installedAddons` does not list `"state"`.                                                                           |
| `ifNoResult must come from the state add-on descriptor.`               | `ifNoResult` is a copy, not the value `state.descriptor` holds.                                                      |
| `ifNoResult must name a declared inspect command.`                     | `report` names a command that `commands` does not hold, or one that is not `inspect`.                                |
| `ifNoResult step <identity> <args> carries a global switch before --.` | The `ifNoResult` step passes `--json`, `--help`, `--discover`, `--discover-all` or `--discover-command` before `--`. |
| `ifNoResult step <identity> [] can never parse: ...`                   | The `report` command requires an argument or option. It is run with none.                                            |
| `ifNoResult step <identity> <args> routes to <other>.`                 | The `report` command's route plus its `ifNoResult` arguments match another command instead of the `report` command.  |
| `ifNoResult needs explicit further inspection guidance.`               | The `report` command's success guidance is `{ kind: "done" }`.                                                       |
| `Changing commands need distinct coordination refusal stations.`       | `heldLockCause` and `unresolvedCaseCause` are one cause, or either is not one of the command's declared stations.    |
| `Coordination refusal causes are host-owned.`                          | Either names a kernel cause, such as `DOMAIN_AUTHORITY_REQUIRED`. Add your own rows.                                 |
| `Coordination refusal requires an unchanged handoff.`                  | Either station is not refused and unchanged with a `handoff`.                                                        |

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
which never creates the state folder, and `state.history(operationId)` so
each entry names the planet from its scope:

```ts
      const report = state.report();
      if (!report.ok && report.reason !== "missing")
```

- `report.ok` is true with `report.unfinished`: one entry for each
  unresolved case, with its `operationId`, `commandIdentity` and `effects`.
  Read `state.history(entry.operationId)` to include the scope's resource
  key (here `planet`), so a caller with two unfinished visits can tell them
  apart.
- `report.reason` is `"missing"` before the first change makes the state
  folder. Answer it as an empty list. Refuse `"unreadable"` and `"corrupt"`
  with a station of the command's own.

## The transaction

**Look and ask first, change last.** Every look-up and every question to
the caller happens before the transaction opens, because the transaction
holds a coordination lock on its scope until its work returns. A reviewer
refuses a handler that looks something up or waits for a person inside the
work; no check can see it.

If the command sets `deadlineSupported: true` and `--deadline-ms` expires
before `state.transaction` opens, the kernel closes the state capability so
no transaction can start, answers `DOMAIN_DEADLINE_BEFORE_START` (before
handler entry) or `DOMAIN_DEADLINE_UNCHANGED` (after handler entry, exit
code 3), and leaves nothing pending.

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
`transaction: outcome.proof` on every non-refused station. The kernel
requires the proof's `transactionState` to match the selected cause row's
declared `transactionState`, or it refuses the result:

- `completed`: `SUCCESS_COMPLETED` when the opener exited 0, or a
  `failed`, `completed` station with a handoff
  (`DOMAIN_MOONS_VISIT_NOT_OPENED`) when it exited non-zero. Neither leaves
  an unresolved case, so the next visit simply runs.
- `partially-completed`: a `failed`, `partially-completed` station with a
  handoff (`DOMAIN_MOONS_VISIT_PARTIAL`), for when an earlier effect
  confirmed and a later effect never started.
- `unknown`: a `failed`, `unknown` station with a handoff
  (`DOMAIN_MOONS_VISIT_UNCONFIRMED`), for when an effect started and was
  not confirmed.
- `unchanged`: a refused, unchanged station with `effects: nothingChanged`
  (`DOMAIN_MOONS_VISIT_UNAVAILABLE`), for when the work stopped before any
  effect started.

## Read-back

A read-back answers "is the change there now?" from the real resource. A
read-back that returns `false` or throws leaves its effect uncertain:
`transaction.record` does not rethrow a read-back error, the run fails with
transaction state `unknown`, and the case stays unresolved for its scope.
The `report` command lists it, and the next change to that scope is refused
with the unresolved-case station.

A file: read it back and compare, and gate the next effect on that
confirmation so the opener never runs on an unconfirmed page:

```ts
          let pageConfirmed = false;
          await transaction.record(
            "planet.record",
            async () => {
              await mkdir(join(home, "visits"), { recursive: true });
              await writeFile(page, text);
            },
            async () => {
              pageConfirmed = (await readFile(page, "utf8")) === text;
              return pageConfirmed;
            },
          );
          if (!pageConfirmed) return;
```

An action you start and do not wait for, such as opening a page or an
editor:

- Record the **launch** (`viewer.launch`), never "the viewer showed it". An
  editor's window can appear seconds after its opener returns.
- Start the opener through the programs add-on, inside the record:
  `context.programs.domain(recorded).start(request)`.
- Read back from whether the launcher exited on its own without timing out
  and stopped cleanly (`!context.signal.aborted`, `result.exitCode !== null`,
  `result.terminationConfirmed`, and `programDetails(result)` defined with
  `!details.timedOut`), observed by the programs add-on. A timed-out launch
  is not a clean stop even when the opener traps the timeout's SIGTERM and
  exits 0, and `undefined` details are not confirmed. Then pick the station
  from `launched.exitCode`: exit 0 is `SUCCESS_COMPLETED`; any non-zero exit
  returns `DOMAIN_MOONS_VISIT_NOT_OPENED` (`failed`, `completed`, with a
  handoff) and leaves no unresolved case, so the next visit simply runs.
- An unresolved case is left for `viewer.launch` only if the launcher
  cannot be seen to stop (`terminationConfirmed` is false), is killed by a
  signal (`result.exitCode === null`), times out (`details.timedOut` is true,
  or `programDetails(result)` is `undefined`), or the run is stopped in
  mid-launch (`context.signal.aborted`).

The record:

```ts
const launched = await transaction.record(
  "viewer.launch",
  (recorded) =>
    context.programs.domain(recorded).start({
      executable: viewer,
      args: [page],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4_096,
      shutdownMilliseconds: 1_000,
    }),
  (result) => {
    const details = programDetails(result);
    return Promise.resolve(
      !context.signal.aborted &&
        result.exitCode !== null &&
        result.terminationConfirmed &&
        details !== undefined &&
        !details.timedOut,
    );
  },
);
exitCode = launched.exitCode;
```

The executable is an absolute path. `moonsCli` checks it once the contract
is built, so a relative path throws `Expected absolute path.` when the CLI
starts:

```ts
const viewer = contract.boundary.path(opener);
```

Keep the page write and the launch as two effects. If the page is not
confirmed, the opener never runs and the result says `planet.record` is
uncertain while `viewer.launch` is remaining.

## Stops: what is left behind

- Stopped before the transaction opens, by Ctrl-C or SIGTERM: the process
  exits 130 or 143, prints nothing, and leaves nothing pending.
- Deadline before the transaction opens: the process exits 3 with
  `DOMAIN_DEADLINE_BEFORE_START` or `DOMAIN_DEADLINE_UNCHANGED` and leaves
  nothing pending.
- Stopped inside the transaction, as by SIGTERM: the process exits 143 and
  prints nothing. The programs add-on stops a program the record started.
  The case stays unresolved: the `report` command lists it, and the next
  change to that scope is refused with the unresolved-case station.

## A case no command can close

Because a clean non-zero opener exit ends `failed` and `completed`, an
unresolved case is a rare last resort: a stop in mid-launch, a timed-out
launch, a launcher killed by a signal or not seen to stop, or an unconfirmed
page write.

On macOS the state add-on cannot close an unresolved case. A host's close
command, `state.close(context.state, request)`, returns `unavailable` with
reason `stopped-owner-proof-unqualified`, and `state.capabilities()`
reports `stoppedOwnerProof` as `unavailable`. So:

- Keep each scope narrow. A stuck case then blocks one destination, not the
  tool.
- Never advise moving or deleting state files to get round the protocol
  (Command Contract 3 REC-7: "A person is not advised to bypass this
  protocol by deleting files").
- In the unresolved-case, partial and unconfirmed stations' repair action,
  name the command that reports the case (`pending`, which lists each
  case's `operationId`, `planet` and `effects`), say what the person checks
  by hand (that planet's page and viewer), and state that the case stays
  until a qualified close exists:

```ts
const unresolvedRepair =
  "Run pending to see the planet and operation id, then check that planet's page and viewer by hand. That planet stays blocked until a qualified close exists.";
```

## Healing an unresolved case on the next run

By default, an unresolved case blocks the next run on a conflicting scope until
a qualified close runs. When a command is safe to run again even alongside a
leftover copy of a program an earlier run started, its author may opt in by
setting `supersedeUnresolved: true` on the state declaration passed to
`state.transaction`:

```ts
const declaration: Declaration = {
  command: "moons.visit",
  scope: { resources: [{ resource: "planet", key: "earth" }] },
  facts: { planet: "earth" },
  supersedeUnresolved: true,
};
```

Setting `supersedeUnresolved: true` is a strong promise by the command's
author: the command is safe to run again even alongside a leftover copy of the
program the earlier run started, because the effect is idempotent or a
duplicate is visible and acceptable to the person (for example, opening a
second editor window). The kernel never tries to stop that leftover program.
An effect that creates something new is safe to repeat only when its name or
key comes from the inputs, not from the fresh `operationId`; a request the
earlier run already sent can still arrive after the new run's, so only the
remote side can deduplicate it using an input-derived key.

When set, the declaration is read once into plain data and the command identity
comes from the kernel (the attached command, not `declaration.command`). The
store is scanned once for conflicting unresolved cases. When any conflict, the
next run checks that the state root sits on a local filesystem whose lock is
honoured, takes and holds each prior case's `owner.lease` directly with no
probe (a live run refuses with the held-lock station and an unreadable lease
refuses `lease-unreadable`), confirms on re-read under that lease that the case
is still unresolved, intact, unchanged, recorded under the same kernel command
identity, and covered by the new declaration's declared resources (the dead
case's recorded declared resources and invariants are a subset of the new
declaration's; unknown scope on either side refuses), consumes approval,
publishes the new run's own intent first, and only then links an
`outcome-unknown` closure with no authority, empty evidence, and working
qualification label `superseded-owner-lease-free` (never claiming completion),
recording each closed id at the link commit point, moves settled cases to
`settled`, and carries on. The cleared run stays in history as
`outcome-unknown`, and every result path of the new run lists every cleared
operation id in `result.superseded` (omitted on runs that cleared nothing). A
same-boot `delegate-admitted` record is allowed to clear on this flagged path;
unflagged commands and `state.close` keep their existing paths and refusals
unchanged.

Never set `supersedeUnresolved: true` on a command that is not safe to run
again alongside a leftover earlier program. After a kill, the next run repeats
the effect without anyone checking (a second payment, a second push, or a
second deletion), and the journal can only record that the earlier run's
outcome was unknown.

## Choosing the scope

A scope is what one unresolved case blocks, and what the coordination lock
holds while the work runs.

- Scope a destination's commands to that destination, never to the whole
  tool. `visit` scopes to the planet: an interrupted visit to venus blocks
  venus, and a visit to earth still runs.
- Keep every resource the work writes inside the scope. Give each
  destination its own page, as `visit` writes `visits/<planet>.txt`. A
  record every destination shares belongs to every scope, and would widen
  the scope to the whole tool.

## Testing

Build the contract in a function, as [testing](testing.md#in-process)
shows, so each test passes its own state folder and opener. Prove that a
non-zero opener fails with a handoff, leaves nothing pending, and lets the
next visit to that planet run:

```ts
test("a non-zero opener fails with a handoff and leaves nothing pending, so the next visit runs", async () => {
  const home = newHome();
  const failing = moonsIn(home, "/usr/bin/false");
  expect(await failing(["visit", "earth"])).toMatchObject({
    exitCode: 3,
    outcome: "failed",
    causeCode: "DOMAIN_MOONS_VISIT_NOT_OPENED",
    transactionState: "completed",
    effects: { completed: ["planet.record", "viewer.launch"] },
    handoff: { owner: "human" },
  });
  expect(await failing(["pending"])).toMatchObject({
    data: { unfinished: [] },
  });
  expect(
    await moonsIn(home, "/usr/bin/true")(["visit", "earth"]),
  ).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
  });
});
```

A second test in [example tests](example-tests.md) symlinks `earth.txt` to
`/dev/null` so the page read-back returns false: the opener does not run,
`pending` lists `earth` by planet, a second visit to `earth` is refused as
unresolved, and a visit to `mars` succeeds.

Then drive the real CLI with verify-cli's changing-command feature, in
`node_modules/agent-cli-kernel/skills/verify-cli/features/changing-command.md`.
Its scenario runs a first change, a second run, an empty report, a run
stopped by its time limit, the refusal and the listing it leaves, and a
change to another scope.
