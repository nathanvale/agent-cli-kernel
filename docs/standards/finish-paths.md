# Finish Paths

Review work a run does as it finishes, such as the state seam forgetting its
run identity, by listing each way the run can finish and finding the case
that reaches it.

- Give finish work a case for each way its run can finish: a handler that
  returns, a run that attaches state and never enters its handler, and a run
  whose promise rejects among them. A planted fault that drops the work on a
  way with no case survives. Witnessed: [7fb5649]
  (`IP08.attached-never-entered`, fault `7fb5649-in-process-entered`),
  [ef76011] (`IP08.rejected-run-forgets`, fault
  `d62870c-in-process-rejected`).

[7fb5649]: https://github.com/nathanvale/agent-cli-kernel/commit/7fb564900cff191397fdc8d1ba6f20e6807abdde
[ef76011]: https://github.com/nathanvale/agent-cli-kernel/commit/ef76011bdde8d36064b73bd85550d8efc7fb15a6
