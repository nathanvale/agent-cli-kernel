---

name: agent-cli-kernel
description: Write commands on the agent-cli-kernel package. Use when code imports agent-cli-kernel to declare a command or its input, declare a result it can produce (a station), build the contract with contractFor, test a command, or read a throw from contractFor when the CLI starts.
---

# Writing commands on agent-cli-kernel

Your repository installs the kernel as the package `agent-cli-kernel`, pinned
to one commit. This skill ships inside that package, at
`node_modules/agent-cli-kernel/skills/agent-cli-kernel/`.

## Rules

- Read these references before any kernel source. They hold what a command
  needs, and each code block in them is copied from an example that the
  kernel repository compiles, lints and tests as a repository that depends
  on the package.
- Write your commands in your repository's `src/`. `src/cli.ts` is the front
  door and `src/commands.ts` is its command table.
- Import the kernel from `agent-cli-kernel`, and an add-on from
  `agent-cli-kernel/addons/<name>`. The package's `exports` map refuses any
  deeper path, and the type check reports it.
- Leave `node_modules/agent-cli-kernel/` as installed. A kernel fault is
  repaired in the kernel repository, and reaches your repository when its
  dependency line names a commit that holds the repair.

## Routes

- Writing or changing a command, its input, or its entry file: read
  [commands](references/commands.md).
- Declaring a result a command can produce, such as a refusal, or reading a
  throw when the CLI starts: read [stations](references/stations.md).
- Testing a command: read [testing](references/testing.md).
- Starting a CLI, or wanting whole files to copy: read
  [example](references/example.md).
- Writing a command that changes anything, such as a file or a remote
  system: it needs the state add-on, which owns that guidance. This skill
  covers read-only commands.
