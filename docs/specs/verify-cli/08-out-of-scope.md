# `verify-cli` specification, part 8 of 11: out of scope

## Out of Scope

Decided by Nathan, and so not in this work:

- A `bin` entry in the kernel's `package.json`.
- The kernel checking itself with `verify-cli` (K8). Its check command
  sweeping the author skill's example and `verify-cli`'s own CLI is a later
  unit of its own, after this skill lands. It is not a slice here. The skill's
  own tests do use the author skill's example as their target. That tests the
  helper. The later unit is what makes the sweep a standing gate on the
  example and on the helper's own CLI.
- Moving the template's `verify-template` onto the kernel. It stays shell
  until the programs add-on's folder and environment (K7) returns.
- The programs add-on's folder and environment (K7): a working folder and an
  environment for each program that add-on starts.
- Any edit to the author skill or to `cli-design`. Slice S6 reports how each
  could use the helper. Changing either is a separate decision.
- Any entry in a glossary. The kernel's glossary owns `verify-cli`'s words,
  and pull request 56 adds them (part 11).

Left out by this specification:

- The template's pointer skill and Bootstrap's kernel row (T4). The pointer
  should name `verify-cli`. The acceptance runs call the template's function
  from a script.
- Any change to the kernel. Two kernel findings from the build are parked in
  part 9.
- Replacing in-process tests. The helper shows public behaviour; it does not
  stand in for a test of a function.
- A snapshot copy of the working tree. The target is driven in place, and the
  run row records the head commit and the uncommitted path count instead.
- A compiled target. Every step runs Bun on an entry file.
- A terminal session for a step. Steps read pipes.
- Standard input held open during a step, two steps at once, and a signal sent
  on request. The one interruption a step can make is its time limit.
- Two runs sharing one folder. Each verification run is its own.
- Scenarios derived from discovery, feature files that run themselves, and
  generated test files.
- A `selftest` command. The lying CLI it would drive is kept as a test fixture
  instead (TD4).
- Closing an unresolved helper case. The repair is a new verification run.
- A hostile target. A target has the agent's rights.
