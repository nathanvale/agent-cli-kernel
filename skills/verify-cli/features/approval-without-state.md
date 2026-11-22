# Approval without state

A CLI that selects the approval add-on without the state add-on cannot
start: the kernel refuses its contract. A user sees the kernel's sentence
on stderr, whatever command they run.

## Sub-features

- `refused-at-start` shows the kernel's sentence and a failed start.

## How to get to it (user POV)

- Any command of a CLI whose `installedAddons` lists `approval` and not
  `state`.

## Driving it with verify-cli

Preconditions: none; `ready` is the driver.

```text
$ verify.ts ready src/cli.ts
The target did not start: its usage probe exited 1, and its discovery probe wrote no envelope. Its first error: error: Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.
```

Exit 3, `DOMAIN_VERIFY_TARGET_START`. The exit is never 70: the helper is
honest, and the target cannot start.

## Gotchas

- `launch` still binds a run to such a target; `ready` is the check that
  shows it cannot start. List `state` in `installedAddons` and pass the
  `state` descriptor created by `contractFor.stateAddon`, then run `ready`
  again.
