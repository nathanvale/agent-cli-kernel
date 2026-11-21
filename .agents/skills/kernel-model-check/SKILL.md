---

name: kernel-model-check
description: Formally model-check the agent-cli-kernel concurrency and crash-recovery protocols (state journal v2, diagnostics custody, kernel lifecycle and state seam) in TLA+/TLC. Use before or after changing or refactoring kernel/src/addons/state/, kernel/src/addons/diagnostics/, or kernel/src/kernel/lifecycle.ts and state-seam.ts, or when comparing a simplified rebuild design against contract invariants.
---

# Kernel model check

Exhaustive TLA+/TLC model checks for the three concurrency and crash-recovery protocols where bugs hurt most and unit tests reach least. Each model separates **implementation-independent contract invariants** (what any simpler rebuild must keep true) from the **current-code model** (every action and guard cited to file and symbol), so you can both guard current code and verify candidate refactor designs before editing TypeScript.

## Coverage and sync commit

Last confirmed in sync at commit **`426e5db`** (`origin/main`).

| Model                 | Spec & config                                         | Covered files                                                                                                                                             | Contract invariants (plain English)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state-journal`       | `state-journal/StateJournal.tla` / `.cfg`             | `kernel/src/addons/state/install.ts`, `kernel/src/addons/state/store.ts`, `kernel/src/addons/state/framing.ts`, `kernel/src/addons/state/coordination.ts` | A case never moves to `settled/` while live, closing, or unresolved (`NoMoveWhileLiveOrClosing`); a closure never publishes while the writer holds the lease, a same-boot delegate may run, or a record hides mid-line in a torn tail (`NoUnsafeClosure`); a closure never verifies or publishes against a journal revision different from the close request's revision or on a case the writer already settled (`NoStaleRevisionClosure`); the writer lease stays held until started effects settle (`LeaseHeldUntilEffectsSettled`); a lockless `history` reader never misses a case moving `operations/` → `settled/` (`LocklessReaderNeverMissesCase`); v2 never exists without `settled/` ready (`UpgradeSafe`). |
| `diagnostics-custody` | `diagnostics-custody/DiagnosticsCustody.tla` / `.cfg` | `kernel/src/addons/diagnostics/custody.ts`, `kernel/src/addons/diagnostics/run.ts`                                                                        | Two live processes never hold `.allocation-lock` at once (`MutualExclusion`); a live holder's lock is never displaced (`LiveHolderNeverDisplaced`); `prune` never unlinks an open or marker-mismatched file (`NeverPruneUnclosed`); live files never exceed the capacity bound (`CapacityBoundRespected`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kernel-lifecycle`    | `kernel-lifecycle/KernelLifecycle.tla` / `.cfg`       | `kernel/src/kernel/lifecycle.ts`, `kernel/src/kernel/state-seam.ts`, `kernel/src/kernel/writer.ts`                                                        | Every modelled handler exit path emits at most one envelope and drained runs emit exactly one (`SingleEnvelope`); pre-handler exits in `runDeclaredCommand` (including `notInteractiveRefusal`) and built-ins are not modelled; once closed by handler return or deadline, late state calls are refused (`NoLateStateMutationAfterClose`); live runs, unfinished handlers, and open transactions reserve `runId` and reject duplicates (`NoDuplicateRunIdWhileLiveOrOpenTx`); revoked proofs are never trusted (`RevokedProofNeverTrusted`); a stop received before emission starts prevents any envelope from starting emission (`NoEnvelopeAfterStop`).                                                             |

**Staleness rule:** Before relying on a pass, check whether any covered file changed since the sync commit above (`git diff --name-only <syncCommit> -- <covered files>`). When any covered file changed since `syncCommit` or staleness cannot be verified (for example, a shallow clone missing `syncCommit`), `model-check.mjs` prints `STALE` and exits non-zero rather than `PASS`. Pass `--repo <path>` when invoking the script against a different git worktree. Advance the sync commit in both `SKILL.md` and `model-check.mjs` **only** after confirming every action and symbol citation still matches the code at the new commit.

## Bounds and what is left out

- **`state-journal`**: 1 case, 1 writer, 1 closer, 1 lockless reader, 2 boots (`boot1`/`boot2`), `MaxRev = 5`. Leaves out OS kernel bugs in `flock`/`O_EXLOCK`, filesystem corruption outside the durability boundary, and the 64/128 mover batch caps (covered by `tests/kernel/state/`).
- **`diagnostics-custody`**: 3 processes (`P1`, `P2`, `P3`), `MaxFiles = 1`. Leaves out cross-host stale-lock timeout clocks and LogTape redaction internals.
- **`kernel-lifecycle`**: 1 primary run + duplicate `runId` collision/attach probes + stop signal (including during `emitting`) + deadline. Leaves out pre-handler exits in `runDeclaredCommand` (including `notInteractiveRefusal`), built-in navigation commands, multi-run `inFlight` interleavings, and OS signal delivery internals.

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
bun .agents/skills/kernel-model-check/model-check.mjs --repo /path/to/worktree kernel-lifecycle
```

Or pass explicit `TLA2TOOLS` and `JAVA` environment variables to bypass `mise`.

## Reading results and raw TLC traces

- **Pass:** `model-check.mjs` prints `PASS <model>: Model checking completed. No error has been found. | <N> states generated, <M> distinct states found, 0 states left on queue.` and exits `0`.
- **Stale:** `model-check.mjs` prints `STALE <model>: ...` to stderr and exits `1` whenever covered files changed since `syncCommit` or `git diff` cannot verify `syncCommit` (such as a shallow clone).
- **Counterexample (`FAIL`):** TLC prints `Error: Invariant <Name> is violated.` followed by a shortest-path state trace:
  - `State 1: <Initial predicate>` shows the initial variable assignments.
  - Each subsequent `State k: <ActionName ...>` shows the action taken and every variable value after that step.
  - Walk the action sequence top-to-bottom against the `file: symbol()` entry points cited on each action in the `.tla` file to see whether the real TypeScript allows the same sequence.
- **Comparing a candidate refactor:** copy the `.tla` and `.cfg` files to a scratch folder, keep the **Contract Invariants** section unchanged, edit only the state-machine actions to match the proposed design, and run TLC directly (`$JAVA -cp $TLA2TOOLS tlc2.TLC -deadlock -config <cfg> <tla>`).

## Telling a real bug from a modeling error

1. Replay the counterexample step-by-step against the real TypeScript entry points cited on each action (file and symbol), observing only public/on-disk behavior.
2. If the real code reproduces the violation, **it is a real bug**: keep the invariant intact, report the counterexample in the code's words, and fix the product code (or log the finding if in read-only verification mode). Never weaken an invariant to make TLC pass.
3. If the real code blocks a step the model allowed, cite the real file and symbol guard you missed, tighten the model action to match that guard, and rerun TLC.
4. Before trusting any edited invariant, verify it can fail on a negative control (a removed guard or reordered step), confirm TLC catches it, then revert the negative control.
