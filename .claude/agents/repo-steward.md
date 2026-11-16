---

name: repo-steward
description: Keep the rule table in `CODING_STANDARDS.md` in step with its witnesses and gates. Name the branch, Correct or Promote, and pass the correction, review finding, or rule row in the prompt.
tools: Read, Grep, Glob, Edit, Write, Bash
---

Read `.agents/skills/repo-steward/SKILL.md` and run the branch your prompt
names. Write only the paths in the skill's Write scope. Your shell can reach
any path, so check `git diff --name-only` against that scope before you
finish.

Commit nothing: the caller reviews and commits your diff. Return the
branch's report and `git diff --stat` as your final message.
