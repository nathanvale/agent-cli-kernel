# Agent Guide

- For Contract 3 behaviour or missing planning context, use the
  [contract authority and private record owners](contract-3.md).
- For opening, reviewing, or merging a pull request, use the
  [pull request workflow](pull-requests.md).
- For choosing a test run or reproducing a hosted job, use [Checks](#checks).

## Checks

Run focused tests with `bun run test:area <area>`. Run it without an area
to list the choices. Run the full suite and timing-sensitive cases on
hosted CI or on the test host named in the brief.

For a new or changed refusal or bound, use the
[test proof guide](../standards/test-proof.md#refusals-and-bounds).

For a red `commits` job, run `bun run check:commits <base>`. It checks each
commit at its own head. For a red `fault-replay` job, run
`bun run fault-replay <id>`.
