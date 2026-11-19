# Author Guide

The author guide is `kernel/src/kernel/AGENTS.md` and
`kernel/src/kernel/docs/`. It is stamped with the kernel.
Its reader is an agent writing commands in a generated repository.

- Write for that reader. Give paths from a generated repository's root,
  where the kernel is `src/kernel/`.
- Change a code block by changing the example in
  `tests/kernel/author-guide/example/`, then run
  `bun run author-guide:write`. Each example file is stored as its path in a
  generated repository plus `.txt`.
- Copy a shorter excerpt into another guide document by hand. The gate
  refuses a `ts` block that no example file holds.
- State kernel behaviour in words only after running it. When a planned
  kernel change would make a sentence false, pin the sentence with a case in
  `tests/kernel/author-guide/author-guide.test.ts`, titled with the document
  it backs.
- Prove a change with `bun run test:area author-guide`. The gate builds a
  generated repository from the base stamp roots and the example, compiles
  it, runs the stamped lint over it and runs the example's tests.
- Run `bun run format` before committing. A generated repository cannot
  reformat stamped source.
- Keep an add-on's guidance in that add-on's own stamp root.
