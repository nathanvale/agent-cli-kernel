---

name: agent-cli-kernel
description: Write commands on the agent-cli-kernel package. Use when code imports agent-cli-kernel to declare a command or its input, write a command that changes something, declare a result it can produce (a station), build the contract with contractFor, test a command, or read a throw from contractFor when the CLI starts.
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
- Import the kernel from `agent-cli-kernel`, and an add-on from
  `agent-cli-kernel/addons/<name>`. The package's `exports` map refuses any
  deeper path, and the type check reports it.
- Leave `node_modules/agent-cli-kernel/` as installed. A kernel fault is
  repaired in the kernel repository, and reaches your repository when its
  dependency line names a commit that holds the repair.
- Move the pin as its own change. Replace the commit in the `agent-cli-kernel`
  dependency line of `package.json`, which reads
  `github:nathanvale/agent-cli-kernel#<full 40-character commit>`, then
  install. The new commit needs a passed kernel trial: a repository made from that
  commit, with every add-on selected, whose check command passes. Upgrading from the
  template never moves it.

## Routes

- Writing or changing a command, its input, its entry file, or the add-ons
  a CLI uses (`installedAddons`): read
  [commands](references/commands.md).
- Declaring a result a command can produce, such as a refusal, or reading a
  throw when the CLI starts: read [stations](references/stations.md).
- Testing a command: read [testing](references/testing.md).
- Showing a list of rows for a person to choose from in an interactive run:
  read [menu](references/menu.md).
- Starting a CLI, or wanting whole source files to copy: read
  [example](references/example.md).
- Reading the example's whole test files: read
  [example tests](references/example-tests.md).
- Writing a command that changes a file or any other resource, its state
  add-on, its report command, or a case it leaves unfinished: read
  [changing](references/changing.md).
- Adding a second subject to a CLI, placing a command, rule or shared edge
  file, or repairing a boundary violation: read
  [source layout](references/source-layout.md).
