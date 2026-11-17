# Pull Requests

- Open a draft so hosted checks can run first. The repository configures
  automatic review to skip drafts. The author's Copilot settings can
  also affect when a review is requested.
- Mark the pull request ready once its hosted checks pass. Check the
  timeline to see which Copilot and CodeRabbit reviews arrived for that head. Both
  reviews are optional for GitHub's merge gate.
- Answer every review thread. Commit each fix, then run the
  [repo-gardener](../../.agents/skills/repo-gardener/SKILL.md) Sow job on
  a clean tree for each finding about code, tests, or checks. Commit what
  Sow writes. Route instruction wording to its owner. Push the fixes
  as one batch.
- Stop requesting reviews after the third round. Ask Copilot again only
  after the first and second batches. CodeRabbit is configured for
  incremental reviews on pushes. After round three, address comments
  that identify real faults.
- Merge with a merge commit on the operator's word. GitHub protects
  `main` from direct pushes.
