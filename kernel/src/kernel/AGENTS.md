# Building a CLI on the kernel

This folder is the CLI kernel: stamped source, copied byte for byte from the
kernel repository. This guide is for writing a CLI's own commands on it.

Changing the kernel itself happens only in the kernel repository, where this
folder is `kernel/src/kernel/`. There, follow that repository's top-level
`AGENTS.md` and leave this guide to CLI authors.

## Rules

- Read these documents before any kernel source. They hold what a command
  needs, and each code block in them is copied from an example that the
  kernel repository compiles, lints and tests.
- Write your commands outside this folder. Command Contract 3 (CMD-6) names
  `src/cli.ts` as the front door and `src/commands.ts` as its command table.
- Import the kernel only through `src/kernel/index.ts`. The stamped lint
  refuses any other kernel file.
- Keep every file in this folder and in `config/kernel/` byte for byte as
  stamped (CMD-7). A kernel fault is repaired in the kernel repository.

## Routes

- Writing or changing a command, its input, or its entry file: read
  [commands](docs/commands.md).
- Declaring a result a command can produce, such as a refusal, or reading a
  throw when the CLI starts: read [stations](docs/stations.md).
- Testing a command: read [testing](docs/testing.md).
- Starting a CLI, or wanting whole files to copy: read
  [example](docs/example.md).
- Writing a command that changes anything, such as a file or a remote
  system: it needs the state add-on, which owns that guidance. If
  `src/addons/state/AGENTS.md` exists, read it first.
