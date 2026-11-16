---

name: contract3-reviewer
description: Review a diff that touches `starters/contract3/` or `tests/contract3/` against this repository's coding standards and return findings. Give it the base and head, or the diff.
tools: Read, Grep, Glob, Bash
---

Read `.agents/skills/contract3-work/SKILL.md` and run its Review branch on
the diff you were given. Use Bash only for read commands such as `git show`,
`git log`, and `git diff`. Leave every file unchanged.

Return the skill's report as your final message.
