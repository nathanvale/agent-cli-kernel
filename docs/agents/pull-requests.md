# Pull Requests

- Open a draft so hosted checks can run first. The repository configures
  automatic review to skip drafts. The author's Copilot settings can
  also affect when a review is requested.
- Mark the pull request ready once its hosted checks pass. Check the
  timeline to see which Copilot and CodeRabbit reviews arrived for that head. Both
  reviews are optional for GitHub's merge gate.
- After each review request, push nothing until every requested review for
  that head has arrived. A CodeRabbit check that reads "Review rate limited"
  counts as CodeRabbit's review. A push during a review
  cancels it or leaves it reviewing an old commit. If a requested review has
  not arrived after 30 minutes, request it once more, then ask the operator.
- Only the pull request's author pushes to its branch. Leave the review
  bots' fix buttons, such as CodeRabbit's "Fix comments", unticked.
- Answer every review thread. Commit each fix, then run the
  [repo-gardener](../../.agents/skills/repo-gardener/SKILL.md) Sow job on
  a clean tree for each finding about code, tests, check commands, or
  gates. Commit what Sow writes. Route instruction wording to the
  document's owner. Push the fixes as one batch.
- Stop requesting reviews after the third round. Ask Copilot again only
  after the first and second batches. CodeRabbit pauses after one
  reviewed commit, so post `@coderabbitai review` with those same two
  batches. After round three, address comments that identify real faults.
- Merge with a merge commit on the operator's word. GitHub protects
  `main` from direct pushes.

Throwaway padding line 1 for the commits proof. Do not merge.

Throwaway padding line 2 for the commits proof. Do not merge.

Throwaway padding line 3 for the commits proof. Do not merge.
