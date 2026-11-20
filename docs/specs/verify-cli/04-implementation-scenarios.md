# `verify-cli` specification, part 4 of 11: implementation decisions, scenarios and evidence

Continues [part 3](03-implementation-commands.md). Sources are in [part
10](10-traceability.md#implementation-decisions).

## Implementation Decisions (continued)

**I11. Layer 2, scenarios, and the joint report.** An author writes every
scenario, from what the feature must do. None of it is derived from discovery.
A scenario is what pstack calls a journey: one feature, as an ordered list of
steps. `report` gives one state to each `required` station of each of the
target's own commands:

- `swept`: the sweep observed that cause from that command.
- `driven`: a met target step's envelope names that command identity and cause
  code.
- `owed`: neither. This is an owed result.

Rules:

- A step run without `--json` writes no envelope, so it credits no station.
- A `"runner": "bun"` step never credits a station. It may run another entry
  file.
- A station the kernel adds is left out. Its trigger is exactly
  `Kernel <its cause code>.` A success station the kernel adds for a command
  that declares none has the command's summary as its trigger, so it stays in:
  somebody still has to drive it.
- Owed results change no exit code. `report` prints
  `Stations: <n> swept, <n> driven, <n> owed. Steps: <n> met, <n> unmet.` Its
  data lists each station with its state and the step or check that gave it,
  each unmet step with its unmet expectations, each step whose process end was
  not confirmed, and the sweep's finding count.
- `findings` returns the check count and each finding of the sweep. `pending`
  returns the state add-on's report whole, every field kept.

Passed on Linux and on macOS for the report on the example. The other rules
passed on macOS only.

**I12. Formats.** Three formats, each with a `schema` name ending in its
version: `verify-scenario/1`, `verify-index/1` and `verify-step/1`. The
snippets below are the build's own: the scenario from its seed feature map,
the index and the evidence file from its macOS run. They are trimmed to the
parts that carry a decision. The repository's formatter has laid them out.

A scenario file. Two of the six steps of the changing-command example:

```json
{
  "schema": "verify-scenario/1",
  "feature": "changing-command",
  "steps": [
    {
      "name": "first-run",
      "argv": ["save", "{scratch}/note", "--content", "proof", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "commandIdentity": "notes.save",
          "causeCode": "SUCCESS_COMPLETED",
          "transactionState": "completed",
          "effects.completed": ["note.write"]
        },
        "files": [{ "path": "{scratch}/note", "content": "proof" }]
      }
    },
    {
      "name": "interrupted-run",
      "timeoutMilliseconds": 3000,
      "argv": ["save", "{scratch}/held", "--content", "hold", "--json"],
      "expect": {
        "exitCode": 143,
        "timedOut": true,
        "stdout": "",
        "stderr": "",
        "files": [{ "path": "{scratch}/held", "absent": true }]
      }
    }
  ]
}
```

- A step has `name`, `argv` and `expect`, and may have `runner`,
  `timeoutMilliseconds` and `outputLimitBytes`.
- `expect` holds `exitCode`; exact `stdout` and `stderr`; `result`; `files`;
  `timedOut`; and, on a `"runner": "bun"` step only, `stdoutIncludes` and
  `stderrIncludes`, each a list of strings.
- A key of `result` is a field of the envelope's result, or a dotted path into
  it. The value there must equal the expected value exactly. A path may end in
  `length` for a list's size.
- A `files` entry is a path with exact `content`, or with `"absent": true`.
- `{scratch}` becomes the absolute path of the verification run's scratch
  folder. `{repository}` becomes the repository root. Both are replaced in
  every string of `argv` and `expect`, a file's `content` included. No other
  text in braces is touched.
- Target steps must be exact. `stdoutIncludes` and `stderrIncludes` loosen
  that only where exact text is impossible, such as a test runner's timings.

The run's index, `index.jsonl` in the evidence folder. One run row, then one
row for each step, in JSON Lines:

```json
{"schema":"verify-index/1","row":"run","repository":"<repository>","target":"src/cli.ts","pinnedCommit":"0d7c96b17ea3d979c4f833a7ec1b9efeeacf5b38","bun":"1.4.4","platform":"darwin arm64","headCommit":null,"uncommittedPaths":null}
{"row":"step","feature":"read-only-command","step":"show-known-planet","runner":"target","verdict":"met","commandIdentity":"moons.show","causeCode":"SUCCESS_UNCHANGED","exitCode":0,"file":"read-only-command/show-known-planet.json","sha256":"8628fa5962f736d531ea8918615ed60c22ccd8894e4a1cf209a88ef8bde808cf"}
{"row":"step","feature":"read-only-command","step":"show-unknown-planet","runner":"target","verdict":"met","commandIdentity":null,"causeCode":null,"exitCode":3,"file":"read-only-command/show-unknown-planet.json","sha256":"75ce68e4d62520e2fc9078fc7a4a45406ef28ac4452674d47f7ffa9f662d6c01"}
```

- The run row has nine fields. `repository` is the repository root. The two
  git facts are null here because that repository was not a git work tree.
- `commandIdentity` and `causeCode` are null when the step wrote no envelope
  or is not a target step. That is the credit rule of I11.
- `file` is the step's evidence file, at `<feature>/<step>.json` in the
  evidence folder. `sha256` is the SHA-256 (Secure Hash Algorithm, 256 bits)
  hash of that file's bytes. Every hash in this specification is that one.
- An index over 16,777,216 bytes, or one that is not a regular file, is
  unreadable.

One step's evidence file, whole:

```json
{
  "schema": "verify-step/1",
  "feature": "read-only-command",
  "step": "show-unknown-planet",
  "runner": "target",
  "argv": ["show", "pluto"],
  "limits": { "timeoutMilliseconds": 20000, "outputLimitBytes": 1048576 },
  "expected": {
    "exitCode": 3,
    "stdout": "",
    "stderr": "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n"
  },
  "observed": {
    "exitCode": 3,
    "timedOut": false,
    "outputTruncated": false,
    "terminationConfirmed": true,
    "stdoutBytes": 0,
    "stderrBytes": 60,
    "stdout": "",
    "stderr": "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n",
    "files": []
  },
  "unmet": [],
  "verdict": "met"
}
```

- `observed` holds `stdout` in full unless the step has a `result`
  expectation. Then it holds the observed value at each `result` key instead.
  `files` holds the content seen for each expected file.
- `unmet` lists each expectation that did not hold, as a string: `exitCode`,
  `timedOut`, `outputTruncated`, `stdout`, `stderr`, `stdoutIncludes.<index>`,
  `stderrIncludes.<index>`, `result.<key>` or `files.<index>`; and each broken
  contract check, as `contract.<name>`. The verdict is `met` when the list is
  empty, else `unmet`.

Passed on Linux and on macOS: the helper wrote these files in both runs.

**I13. Scenario rules, bounds and contract checks.** `drive` reads the file
once and checks all of it before any step runs. A broken rule refuses with
`DOMAIN_VERIFY_SCENARIO` and names the rule.

| Rule id                   | What the rule refuses                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreadable`              | A path that is missing, is not a regular file, is not JSON, or is over 1,048,576 bytes; the message says which                              |
| `unknown-field`           | A field this format does not name, or a `schema` other than `verify-scenario/1`                                                             |
| `bad-value`               | A field of the wrong type, such as an `argv` that is not a list of strings                                                                  |
| `bad-name`                | A `feature` or step `name` that is not 1 to 64 of lower-case letters, digits and hyphens                                                    |
| `duplicate-step`          | Two steps with one name                                                                                                                     |
| `step-count`              | No step, or more than 200                                                                                                                   |
| `exit-code-only`          | A step whose `expect` lacks `exitCode`, or has nothing beside it but `timedOut`. An empty `result`, `files` or includes list does not count |
| `includes-on-target-step` | `stdoutIncludes` or `stderrIncludes` on a target step                                                                                       |
| `path-outside-scratch`    | A `files` path that does not start `{scratch}/`, or that has a `..` segment                                                                 |
| `limit-out-of-range`      | A `timeoutMilliseconds` outside 1 to 600,000, an `outputLimitBytes` outside 1 to 8,388,608, or step time limits that sum past 3,600,000     |

- No step passes on an exit code alone. Bun given a working folder as two
  words printed its usage text and exited 0, running nothing.
- Each step is bounded. The default time limit is 20,000 milliseconds, the
  default output limit 1,048,576 bytes for each stream, and the shutdown
  budget 500 milliseconds.
- A step that passes its time limit is unmet at `timedOut`, unless it expects
  `"timedOut": true`. A step whose output was cut is always unmet at
  `outputTruncated`.
- On every target step that ended by itself, `drive` also makes four contract
  checks, unasked. With `--json`, `stdout` is one envelope
  (`contract.json-one-envelope`) and `stderr` is empty
  (`contract.json-stderr-empty`). An envelope's exit code is the process's
  (`contract.envelope-exit-code`). Without `--json`, a failed run prints
  nothing on `stdout` (`contract.failure-stdout-empty`). A target whose
  envelope claims one exit code while its process gives another otherwise
  passes every scenario.
- `drive` runs every step in order, whatever the earlier verdicts. It then
  succeeds, printing `<n> steps met.`, when every step was met. Otherwise it
  fails with `DOMAIN_VERIFY_EXPECTATION_UNMET`, naming the first unmet step
  and what it missed.
- `drive` refuses with `DOMAIN_VERIFY_ALREADY_DRIVEN` when the index already
  holds a row for that feature. An evidence file is never overwritten. The
  repair is a new verification run. It refuses with `DOMAIN_VERIFY_RUN_CLEAN`
  once `cleanup` has removed the scratch folder.

Passed on macOS only, in the build's tests, with both sides of each numeric
bound. A met drive passed on Linux too.

**I14. The verification run.** `launch <run folder> <target>` makes one folder
holding three: `scratch/`, the scratch folder, which a run may fill and
cleanup removes; `evidence/`, the evidence folder, which holds the run's index
and the evidence files; and `state/`, the helper's own state.

- The run folder must be new or empty, and outside every git work tree. The
  helper finds a work tree by a `.git` entry in the folder or any folder above
  it.
- `launch` refuses, before it makes anything: a target path with no file; a
  folder that is a file or holds an entry; a folder inside a work tree; a
  target with no `package.json` above it, or with no kernel Pin in it; and a
  `git` failure it cannot read.
- The run row records the binding (I7), the pinned commit from the Pin, the
  Bun version, the platform, and two git facts about the repository root: its
  head commit and its count of uncommitted paths. With no `git` on the path,
  or when `git` says the root is not a work tree, both are null. Any other
  `git` failure refuses the launch with `DOMAIN_VERIFY_GIT_FAILED` and its
  reason.
- `cleanup` removes the scratch folder and nothing else, and says what it
  removed and what it kept. A second `cleanup` is refused with
  `DOMAIN_VERIFY_RUN_CLEAN`: nothing is left to remove (I8).
- The programs add-on ends each child's process group before a step returns,
  and says whether the group was seen empty. So cleanup stops nothing, by name
  or otherwise. The report lists each step whose end was not confirmed. A
  descendant that left its group is not seen.

Passed on Linux and on macOS for `launch`, `cleanup` and the second `cleanup`.
The refusals passed on macOS only.

**I15. Where state lives during a run.** Two different states.

- The helper's own state is in the verification run's `state/` folder. Each
  run has its own, so an unfinished helper change holds one run and no other.
  `cleanup` keeps it; it is part of the record.
- The target's state is wherever the target puts it. The helper cannot move
  it. The skill's rule is that it goes under the scratch folder, in one of two
  ways. A target that takes its state folder from an argument gets `{scratch}`
  in that argument. A target that takes it from an environment variable gets
  that variable set, on the command line that runs `drive`, to a path under
  the scratch folder; every step inherits it.
- A target that fixes its state folder inside the repository cannot be
  isolated without the programs add-on's folder and environment (K7). Its
  feature file says so under Gotchas. Its scenario can still judge the change
  through the target's own read-only commands. `cleanup` will not remove that
  state, and a `files` expectation cannot see it.

Passed on macOS only, in the build's test "a changing command keeps its state
under the run root".

**I16. What an interrupted change leaves.** Two cases.

- The target's change is interrupted. A step's time limit ends it. Seen: the
  child exits 143 with no output; the same change is then refused as
  unresolved; the target's report command lists one unfinished change. The
  changing-command scenario drives exactly this, in six steps.
- The helper's own change is interrupted. A helper killed outright leaves an
  unresolved case in that run's `state/`. Where no capability qualification
  row matches the platform, as on every Mac today, the state add-on hands off
  instead of closing it. The next changing command on that run is refused with
  `DOMAIN_VERIFY_RUN_UNRESOLVED`, and `pending` lists the change, even when
  the run's index is gone. The repair is: read `pending <run folder>`, keep
  the run folder as evidence, and launch another.
- The build shows the second case by an interrupted `drive`, and by one whose
  index is then removed. It does not stop a `launch` part way: a `launch`
  cannot be stopped between its state record and its index write without a
  race, and the guard under test is the same.

Passed on macOS only, in the build's tests.

**I17. Diagnostics is not the evidence.** The diagnostics add-on redacts its
records, caps each at 64,000 bytes and prunes them after seven days. An
evidence file must be exact, whole and lasting. So evidence files are plain
files, and diagnostics holds only the helper's own trace: one record for each
step of a drive. This overrules one line of the brief; the
[map](00-map.md#where-the-inputs-and-the-code-disagreed) shows it. The limits
were read in the kernel's source.
