# Look-only work is its own inspect route

Status: accepted

## Context and Problem

A command that only looks (a check, a plan, a dry run) can be offered two
ways: as its own route, or as a flag such as `--check` or `--dry-run` on the
changing route it previews.

The kernel treats the two kinds of command differently. A changing command
always runs inside a transaction: its facts carry a `TransactionProof`
(`kernel/src/kernel/declaration-checks.ts`, the `FactsForRow` type, about
lines 320 to 339), which the state add-on's journal and lock produce
(`kernel/src/kernel/state-seam.ts`, about line 47). An inspect command's facts
take no transaction and report its effects as unchanged.

The setup work in MAG-223 met this directly. `install --check` ran as the
changing `install` command, so it wrote its journal and took its lock even
when it changed nothing, and its Fingerprint could not stay unchanged.

The question: how does a kernel-based CLI offer look-only work?

## Decision Drivers

- The no-write guarantee for look-only work comes from the kernel, not from
  each command's handler.
- Every changing run keeps a journal record, with no exception.
- One pattern across every CLI, so an agent or a person never has to ask
  which form a given CLI uses.
- Small cost for the kernel and for each CLI.

## Considered Options

- **A. Separate inspect routes.** Look-only work is its own route with
  `effectClass: "inspect"` (for example `setup check` beside `setup install`).
- **B. A changing command that may return "unchanged" without a transaction.**
  `install --check` stays on the changing route and skips its journal when it
  changes nothing.
- **C. A flag alias.** `install --check` is routed to the separate `check`
  route.

Against the drivers:

- A: the kernel itself gives the inspect route no transaction, so it cannot
  write; changing runs still always journal; one pattern; costs one more route
  per CLI that needs a preview.
- B: the no-write promise moves into each handler; it adds an exception to the
  always-journal rule, and a wrong "unchanged" could write with no record.
- C: keeps the guarantee (the run is the inspect route), but mixes two
  patterns, the route and the flag, for the same thing, and costs routing and
  help work in the kernel.

## Decision

We choose option A. Work that only looks is its own `inspect` route. A
changing route takes no `--check` or `--dry-run` flag, and no alias maps one
onto the other.

It best satisfies the drivers: the kernel enforces the no-write guarantee
because an inspect route has no transaction; every changing run keeps its
journal; and there is one pattern.

Authority: Nathan, 26 November 2026, 08:12 ("good to know our current pattern
follow terram form and bre") and 08:13 ("as long as week stick to one pattern
and dont have a mix").

## Consequences

- Good: a look-only command cannot write by construction, and its result says
  so (effects unchanged, no transaction).
- Good: changing commands keep the always-journal rule with no exceptions.
- Good: agents and people learn one form for every kernel-based CLI.
- Bad: a CLI with previews adds one route per preview (`setup check` as well
  as `setup install`), and a user used to `--dry-run` from other tools types a
  different command.
- Neutral: `renamedFrom` route aliases are unaffected; they map an old route
  to the same command, never a flag to another command.

## Confirmation

Planned evidence (not built yet): a declaration check that refuses a
`--check` or `--dry-run` option on a changing command, with a `Repair:` line
naming the inspect-route pattern, and a test and planted fault for it.
