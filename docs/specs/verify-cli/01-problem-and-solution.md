# `verify-cli` specification, part 1 of 11: problem and solution

Read the [index](README.md) first. It holds the status, the source key and the
claim tags.

## Problem Statement

An agent in a generated repository can write a command by following the author
skill. It has no scripted way to show that the command-line interface (CLI)
works as a user meets it.

- The author skill asks for one test for each station, in words. Nothing lists
  the stations that no test reaches
  (`KR/skills/agent-cli-kernel/references/testing.md:86`).
- The author skill covers read-only commands. Its guidance for a command that
  changes something is not written yet
  (`KR/skills/agent-cli-kernel/SKILL.md:35`).
- The template's verification skill is shell. It proves the template. It lists
  a generated repository's own CLI under "Not mapped yet"
  (`TP/.agents/skills/verify-template/features/README.md:79`).
- A verifier built on the kernel shares the kernel's fate. With one fault
  planted in the installed kernel, the prototype helper found seven failed
  checks and still exited 0 (`E/16-trust-redesign.txt:40` to `:42`).
- A verifier that blames the kernel too easily is no better. The first
  prototype reported a kernel fault, exit 70, for a healthy CLI whose one
  command has no route word (`E/18-root-operation.txt:31` to `:35`).

## Solution

A second skill, `verify-cli`, ships beside the author skill in the kernel
repository. It reaches a generated repository through its Pin, so its helper
always matches the installed kernel. The skill tells the agent how to launch a
run, check that the target is ready, drive a feature, keep evidence and clean
up.

What the agent does, in order:

1. Starts every command through one kernel-free check. The check reads raw
   exit codes and bytes. It tests the helper against itself, then against a
   raw run of the target. If it fails, the run exits 70: do not trust this
   verdict, because the installed kernel or the helper is broken.
2. Runs `ready`. It says whether the target is worth driving. A target that
   cannot start gets exit 3 and its own error line, never exit 70.
3. Runs `sweep`. It checks what the kernel promises for every CLI, derived
   from the target's own discovery, with nothing written by the agent. It
   lists the stations still owed.
4. Runs `launch`, `drive`, `report` and `cleanup`. They run scenarios the
   agent wrote, with exact expectations, in a run root outside the repository.
   Each step leaves a receipt.

What the agent can then show:

- The CLI starts.
- Behaviour the kernel promises holds for this CLI.
- Each driven station happened as written.
- Which stations nobody has driven yet.
- Evidence that is still there after cleanup, with a hash for each receipt.

What the skill does not do:

- It does not replace in-process tests.
- It cannot catch a wrong declaration. The sweep trusts what discovery says.
- It cannot see state the target keeps outside the run root.
