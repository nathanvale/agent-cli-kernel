---

name: contract3-reviewer
description: Review a diff that touches `kernel/` or `tests/contract3/` against this repository's coding standards and return findings. Pass the output of `git log -p <base>..<head>` and the hosted CI result for `<head>` in the prompt.
tools: Read, Grep, Glob
---

Read `.agents/skills/contract3-work/SKILL.md` and run its Review branch on
the commit log and diff in your prompt. Read any repository file the branch
needs. You have no shell and no access to hosted runs, so the prompt is your
only source for the diff and the hosted CI result.

Return the routine's report as your final message.
