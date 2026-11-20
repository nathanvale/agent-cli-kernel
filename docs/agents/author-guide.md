# Author Guide

The author guide is the skill `skills/agent-cli-kernel/`: `SKILL.md` and
its `references/`. It ships in the `agent-cli-kernel` package at that path,
so a repository that installs the kernel by its pin finds it at
`node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md`. Its reader
is an agent writing commands in that repository.

- Keep that path. A generated repository's pointer skill names it.
- Keep the skill to this kernel's own rules: commands, input, stations,
  testing and the example. General CLI design belongs to the user-level
  `cli-design` skill.
- Write for that reader. Give paths from that repository's root, and name
  the kernel by its package name, `agent-cli-kernel`.
- Change a code block by changing the example in
  `tests/kernel/author-guide/example/`, then run
  `bun run tests/kernel/author-guide/example-document.ts`.
- Store each example file as its path in that repository plus `.txt`, and
  format it as Biome formats TypeScript.
- Copy a shorter excerpt into another reference by hand. The gate refuses a
  `ts` block that no example file holds.
- State kernel behaviour in words only after running it. When a planned
  kernel change would make a sentence false, pin the sentence with a case in
  `tests/kernel/author-guide/author-guide.test.ts`, titled with the document
  it backs.
- Describe a lint refusal in your own words. Lint messages change wording
  more often than the rules do.
- Prove a change with `bun run test:area author-guide`. The gate lays the
  example out with `agent-cli-kernel` linked to this repository, compiles
  it, runs `kernelLint` over it and runs the example's tests. It also
  installs the package from this checkout's `HEAD` by git ref and finds
  every skill file there, so commit before you trust that case.
- Keep an add-on's guidance with that add-on.
