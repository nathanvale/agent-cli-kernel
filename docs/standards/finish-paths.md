# Finish Paths

Review work a run does as it finishes, such as the state seam forgetting its
run identity: list each way the run can finish and find the case that reaches
it, then list each guard that reads what the finish work removes.

## Finish cases

- Give finish work a case for each way its run can finish: a handler that
  returns, a run that attaches state and never enters its handler, and a run
  whose promise rejects among them. A planted fault that drops the work on a
  way with no case survives. Witnessed: [7fb5649]
  (`IP08.attached-never-entered`, fault `7fb5649-in-process-entered`),
  [ef76011] (`IP08.rejected-run-forgets`, fault
  `d62870c-in-process-rejected`).

## Forgotten entries

- When a change deletes a lookup entry, find every guard that reads through
  that lookup, and make a missing entry read as closed. Reading the entry
  from another source first, such as the run's async context, still leaves
  every call that source misses open. Witnessed: [7fb5649] (forgetting a run
  deleted the seam entry that `recordedEffect` read for its closed check, so
  a transaction left open after its run could record an effect), [b64db4a]
  (a record kept past its forgotten run and called outside the run's context
  found no run and read it as open).

[7fb5649]: https://github.com/nathanvale/agent-cli-kernel/commit/7fb564900cff191397fdc8d1ba6f20e6807abdde
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
[b64db4a]: https://github.com/nathanvale/agent-cli-kernel/commit/b64db4ae25a19db89890590acfc91f933a0f4a36
