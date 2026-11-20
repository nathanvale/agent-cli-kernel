# A changing command

A user runs a command that changes something, through the state add-on. The
change lands and reads back, a second run behaves as the command promises,
and a run stopped part way leaves an unfinished case that blocks the next
change until someone looks at it.

## Sub-features

- `change-first` makes the change: exit 0, `SUCCESS_COMPLETED`.
- `change-read-back` shows the change through a second, read-only view.
- `change-second` runs the same command again.
- `change-interrupted` is stopped while its change is in progress.
- `change-blocked` refuses the next change on that scope as unresolved.
- `change-report` lists the unfinished case in the CLI's report command.

## How to get to it (user POV)

- Any command whose `--help` first line ends `(repository-local)` or
  `(external)`, such as `save <path> --content <text>`.
- The report command its discovery names under `ifNoResult`.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor --run <run>` exits 0 and lists a command whose
  `effectClass` is not `inspect`. A CLI with none fails this feature with
  that reason.
- The CLI keeps its state under the folder it runs in, or under `HOME`;
  both are inside the run's scratch folder.

- **First change.** Run `verify.ts drive <run> change-first '["save","note.txt","--content","one","--json"]' --expect-exit 0 --expect-cause SUCCESS_COMPLETED --expect-empty-stderr`. Exit 0.
- **Read back.** Read the change through the CLI's own read command when it has one. Otherwise read the file with a script: run `verify.ts drive <run> change-read-back '["-e","process.stdout.write(await Bun.file(\"<scratch>/note.txt\").text())"]' --bun --expect-exit 0 --expect-stdout one`, with the `scratch` path `launch` printed in place of `<scratch>`. Exit 0. `--bun` runs in the repository root, so the path must be absolute.
- **Second run.** Run `verify.ts drive <run> change-second '["save","note.txt","--content","two","--json"]' --expect-exit 0 --expect-cause SUCCESS_COMPLETED`. Exit 0, and a second read-back step shows `two`.
- **Interrupted run.** Make the change block for real: run `mkfifo <scratch>/blocked` with the `scratch` path from `launch`. Then run `verify.ts drive <run> change-interrupted '["save","blocked","--content","x","--json"]' --timeout-ms 3000 --expect-exit 143`. Exit 0; the evidence shows `"timedOut": true`.
- **Blocked.** Run `verify.ts drive <run> change-blocked '["save","blocked","--content","y","--json"]' --timeout-ms 10000 --expect-exit 3 --expect-cause <the unresolved-case cause from save --help>`. Exit 0.
- **Report.** Run `verify.ts drive <run> change-report '["pending","--json"]' --expect-exit 0 --expect-stdout save`. Exit 0; the evidence names the unfinished operation.

## Gotchas

- A fast change finishes before any timeout. Stop it for real by making it
  block, as the FIFO does; a short `--timeout-ms` alone proves nothing.
- `--expect-exit 143` is the kernel's exit for SIGTERM. A CLI that does not
  exit on SIGTERM shows `"exitCode": null` and a signal instead; report it.
- After the interrupted step, that scope stays blocked in this run. Use a
  new run for anything else on the same scope.
- Relative paths in argv resolve in the run's scratch folder.
