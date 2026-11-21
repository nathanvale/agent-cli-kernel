---

name: kernel-model-check
description: Formally model-check the agent-cli-kernel concurrency and crash-recovery protocols (state journal v2, diagnostics custody, kernel lifecycle and state seam) in TLA+/TLC. Use before or after changing or refactoring kernel/src/addons/state/, kernel/src/addons/diagnostics/, or kernel/src/kernel/lifecycle.ts and state-seam.ts, or when comparing a simplified rebuild design against contract invariants.
---

# Kernel model check

Exhaustive TLA+/TLC model checks for the three concurrency and crash-recovery protocols where bugs hurt most and unit tests reach least. Each model separates **implementation-independent contract invariants** (what any simpler rebuild must keep true) from the **current-code model** (every action and guard cited to `file:line`), so you can both guard current code and verify candidate refactor designs before editing TypeScript.

## Coverage and sync commit

Last confirmed in sync at commit **`0b7a26f`** (kernel source unchanged from `main` at `491e41d`).

| Model                 | Spec & config                                         | Covered files                                                                                                                                             | Contract invariants (plain English)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state-journal`       | `state-journal/StateJournal.tla` / `.cfg`             | `kernel/src/addons/state/install.ts`, `kernel/src/addons/state/store.ts`, `kernel/src/addons/state/framing.ts`, `kernel/src/addons/state/coordination.ts` | A case never moves to `settled/` while live, closing, or unresolved (`NoMoveWhileLiveOrClosing`); a closure never publishes while the writer holds the lease, a same-boot delegate may run, or a record hides mid-line in a torn tail (`NoUnsafeClosure`); a closure never uses a stale pre-lease revision (`NoStaleRevisionClosure`); the writer lease stays held until started effects settle (`LeaseHeldUntilEffectsSettled`); a lockless `history` reader never misses a case moving `operations/` → `settled/` (`LocklessReaderNeverMissesCase`); v2 never exists without `settled/` ready (`UpgradeSafe`). |
| `diagnostics-custody` | `diagnostics-custody/DiagnosticsCustody.tla` / `.cfg` | `kernel/src/addons/diagnostics/custody.ts`, `kernel/src/addons/diagnostics/run.ts`                                                                        | Two live processes never hold `.allocation-lock` at once (`MutualExclusion`); a live holder's lock is never displaced (`LiveHolderNeverDisplaced`); `prune` never unlinks an open or marker-mismatched file (`NeverPruneUnclosed`); live files never exceed the capacity bound (`CapacityBoundRespected`).                                                                                                                                                                                                                                                                                                       |
| `kernel-lifecycle`    | `kernel-lifecycle/KernelLifecycle.tla` / `.cfg`       | `kernel/src/kernel/lifecycle.ts`, `kernel/src/kernel/state-seam.ts`, `kernel/src/kernel/writer.ts`                                                        | Every exit path emits at most one envelope and drained runs emit exactly one (`SingleEnvelope`); once closed by handler return or deadline, late state calls are refused (`NoLateStateMutationAfterClose`); live runs and open transactions reserve `runId` and reject duplicates (`NoDuplicateRunIdWhileLiveOrOpenTx`); revoked proofs are never trusted (`RevokedProofNeverTrusted`); stopped runs emit no envelope (`NoEnvelopeAfterStop`).                                                                                                                                                                   |

**Staleness rule:** Before relying on a pass, check whether any covered file changed since the sync commit above (`git diff --name-only <syncCommit>..HEAD -- <covered files>` — `model-check.mjs` prints a `WARN` automatically when stale). Advance the sync commit in both `SKILL.md` and `model-check.mjs` **only** after confirming every action and `file:line` citation still matches the code at the new commit.

## Bounds and what is left out

- **`state-journal`**: 1 case, 1 writer, 1 closer, 1 lockless reader, 2 boots (`boot1`/`boot2`), `MaxRev = 3`. Leaves out OS kernel bugs in `flock`/`O_EXLOCK`, filesystem corruption outside the durability boundary, and the 64/128 mover batch caps (covered by `tests/kernel/state/`).
- **`diagnostics-custody`**: 2 processes (`P1`, `P2`), `MaxFiles = 1`. Leaves out cross-host stale-lock timeout clocks and LogTape redaction internals.
- **`kernel-lifecycle`**: 1 primary run + duplicate `runId` collision probe + stop signal + deadline. Leaves out multi-run `inFlight` interleavings and OS signal delivery internals.

A passing model check proves the invariants across every interleaving within these bounds, not for unmodeled OS or runtime behavior.

## Run the check

This folder ships a scoped `mise.toml` pinning `java@temurin-25` and `tla2tools.jar@1.7.4` (leaving Bun pinned solely in root `package.json`). Install once if needed:

```sh
(cd .agents/skills/kernel-model-check && mise install)
```

Run all three models (or pass one model id: `state-journal`, `diagnostics-custody`, `kernel-lifecycle`):

```sh
bun .agents/skills/kernel-model-check/model-check.mjs
bun .agents/skills/kernel-model-check/model-check.mjs state-journal
```

Or pass explicit `TLA2TOOLS` and `JAVA` environment variables to bypass `mise`.

## Reading results and comparing refactors with `/statechart`

Read every TLC result with the pstack **`/statechart`** skill:

- When an invariant fails, `/statechart` shows the shortest counterexample path in plain words so you can replay each step against the real code without reading raw TLC dumps.
- When all invariants pass, `/statechart` renders a statechart of how the protocol moves between states.
- When exploring a **simplified rebuild** of any covered subsystem, model the candidate simpler design in a scratch copy keeping the exact same **Contract Invariants** section, and use `/statechart` to compare the candidate against the current model before writing TypeScript.

## Telling a real bug from a modeling error

1. Replay the counterexample step-by-step against the real TypeScript entry points cited on each action (`file:line`), observing only public/on-disk behavior.
2. If the real code reproduces the violation, **it is a real bug**: keep the invariant intact, report the counterexample in the code's words, and fix the product code (or log the finding if in read-only verification mode). Never weaken an invariant to make TLC pass.
3. If the real code blocks a step the model allowed, cite the real `file:line` guard you missed, tighten the model action to match that guard, and rerun TLC.
4. Before trusting any edited invariant, verify it can fail on a negative control (a removed guard or reordered step), confirm TLC catches it, then revert the negative control.
