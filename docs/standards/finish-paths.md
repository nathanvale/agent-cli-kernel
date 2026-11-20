# Finish Paths

Review work a run does as it finishes, such as the state seam forgetting its
run identity: list each way the run can finish and find the case that reaches
it, then list each guard that reads what the finish work removes.

## Finish cases

- When a change adds finish work, or a new way for a run to finish, give the
  work a case on each way its run can finish, and record a planted fault that
  drops the work there. The ways include a handler that returns, a run that
  attaches state and never enters its handler, and a run whose promise
  rejects. A fault that drops the work on a way with no case survives.
  Witnessed: [7fb5649], [ef76011], [e766237] (a pattern worker's blob URL
  was released when the worker answered, failed or ran out of time, but
  not when it failed to start; the fix makes one URL per process, so no
  way to finish has release work).

## Forgotten entries

- When a change deletes a lookup entry, find every guard that reads through
  that lookup, and make a missing entry read as closed. Reading the entry
  from another source first, such as the run's async context, still leaves
  every call that source misses open. Witnessed: [7fb5649] (forgetting a run
  deleted the seam entry that `recordedEffect` read for its closed check, so
  a transaction left open after its run could record an effect), [b64db4a]
  (a record kept past its forgotten run and called outside the run's context
  found no run and read it as open).
- When the lookup's key can be reused, a missing entry is not the only miss:
  a guard that reads through the key can find the open entry of the run that
  reused it. Bind the guard to the entry its caller holds, such as the run
  its transaction carries, and refuse a call that carries none. Witnessed:
  [c02caae] (with a missing run read as closed, a record kept past its
  forgotten run and called outside the run's context could still bind to a
  new run that reused its identity; `recordedEffect` now requires the active
  attached run and reads that run's own entry).

[7fb5649]: https://github.com/nathanvale/agent-cli-kernel/commit/7fb564900cff191397fdc8d1ba6f20e6807abdde
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
[b64db4a]: https://github.com/nathanvale/agent-cli-kernel/commit/b64db4ae25a19db89890590acfc91f933a0f4a36
[c02caae]: https://github.com/nathanvale/agent-cli-kernel/commit/c02caae41a3100ab2c8d5272d21a60acb7a0b992
[e766237]: https://github.com/nathanvale/agent-cli-kernel/commit/e76623703cff72cc32c30a97164243e2cc86f255
