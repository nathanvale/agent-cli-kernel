# Look-only work is its own inspect route

Status: accepted

## Context and Problem

A command that only looks (a check, a plan, a dry run) can be offered two
ways: as its own route, or as a flag such as `--check` or `--dry-run` on the
changing route it previews.

The kernel treats the two kinds of command differently:

- A changing command's facts must carry a `TransactionProof` on every outcome
  except a refusal (`kernel/src/kernel/declaration-checks.ts`, the
  `FactsForRow` type, about lines 320 to 339). The state seam issues that proof
  from the journal and lock (`kernel/src/kernel/state-seam.ts`). A refused
  outcome carries no transaction, reports its effects as unchanged, and the
  runtime skips the proof for it (`kernel/src/kernel/index.ts`,
  `applyChangingState`).
- An inspect command's facts never carry a transaction, and always report
  their effects as unchanged.

The kernel enforces the second point for state it records in its journal. It
does not stop an inspect handler from calling a filesystem or program API
directly; that is left to the handler and to the repository's lint rules.

The setup work in MAG-223 met this directly. `install --check` ran as the
changing `install` command. A check that succeeds is not a refusal, so it had
to run in a transaction: it wrote its journal and took its lock even when it
changed nothing, and its Fingerprint could not stay unchanged.

The question: how does a kernel-based CLI offer look-only work?

## Decision Drivers

1. Look-only work cannot change the state the kernel records in its journal,
   by the kernel's own contract rather than by each handler's care.
2. Every changing run that changes state keeps its journal record, with no
   new exception.
3. One pattern across every CLI, so an agent or a person never has to ask
   which form a given CLI uses.
4. Small cost for the kernel and for each CLI.

## Considered Options

- **A. Separate inspect routes.** Look-only work is its own route with
  `effectClass: "inspect"` (for example `setup check` beside `setup install`).
- **B. A changing command that may return "unchanged" without a transaction.**
  `install --check` stays on the changing route and skips its journal when it
  changes nothing.
- **C. A flag alias.** `install --check` is routed to the separate `check`
  route.

| Driver                                      | A. Inspect routes                                             | B. Changing, no transaction                                                             | C. Flag alias                                                           |
| ------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1. Contract keeps journaled state unchanged | Yes: an inspect route never gets a transaction                | No: each handler must decide, and a wrong "unchanged" could change state with no record | Yes: the run is the inspect route                                       |
| 2. Every state-changing run journals        | Yes: changing routes are unchanged                            | No: adds an exception to the rule                                                       | Yes: changing routes are unchanged                                      |
| 3. One pattern                              | Yes                                                           | No: some CLIs would preview by flag, others by route                                    | No: two forms, a route and a flag, for the same thing                   |
| 4. Small cost                               | One more route per CLI that needs a preview; no kernel change | A new kernel path for proof-free changing results, plus per-handler care                | Routing, help and discovery work in the kernel, plus declaration checks |

## Decision

We choose option A. Work that only looks is its own `inspect` route. A
changing route takes no `--check` or `--dry-run` flag, and no alias maps one
onto the other.

It best satisfies the drivers: the kernel's contract gives an inspect route no
transaction, so it cannot change journaled state; every state-changing run
keeps its journal; there is one pattern; and the kernel needs no change.

Authority: Nathan, 26 November 2026, 08:12 ("good to know our current pattern
follow terram form and bre") and 08:13 ("as long as week stick to one pattern
and dont have a mix").

## Consequences

- Good: a look-only command cannot change journaled state, and its result says
  so (effects unchanged, no transaction).
- Good: changing commands keep their journal rule with no new exception.
- Good: agents and people learn one form for every kernel-based CLI.
- Bad: a CLI with previews adds one route per preview (`setup check` as well
  as `setup install`), and a user used to `--dry-run` from other tools types a
  different command.
- Bad: the kernel does not block direct filesystem or program calls in an
  inspect handler; keeping those read-only is the handler's job and the lint
  rules'.
- Neutral: route aliases for renamed commands (a separate change) are
  unaffected; they map an old route to the same command, never a flag to
  another command.

## Confirmation

Built evidence: `validateChangingShape` (`kernel/src/kernel/declarations.ts`)
refuses a `--check` or `--dry-run` option by name or alias on a changing
command, throwing a `Repair:` line that points to a separate inspect route.
It is pinned by `tests/kernel/declaration-admission.test.ts`
(`changing() and raw contractFor refuse --dry-run and --check by name or alias`)
and planted fault record `c9997d49-declarations`
(`tests/planted-faults/fault-records/c9997d49-declarations.json`).
