# `verify-cli` specification, part 4 of 11: implementation decisions, scenarios and evidence

Continues [part 3](03-implementation-commands.md). Sources are in [part
10](10-traceability.md#implementation-decisions).

## Implementation Decisions (continued)

**I11. Layer 2, scenarios, and the joint report.** An author writes every
scenario. None of it is derived from discovery. A scenario is what pstack
calls a journey: one feature, as an ordered list of steps. `report` gives one
state to each `required` station of each host command:

- `swept`: the sweep observed that cause from that command.
- `driven`: a met target step's envelope names that command identity and cause
  code.
- `owed`: neither.

Rules:

- A step run without `--json` writes no envelope, so it credits no station.
- A `"runner": "bun"` step never credits a station. It may run another entry
  file.
- A station the kernel adds is left out. Its trigger is exactly
  `Kernel <its cause code>.` A success station the kernel adds for a command
  that declares none has the command's summary as its trigger, so it stays in:
  somebody still has to drive it.
- Owed stations change no exit code. `report` always succeeds. It prints
  `Stations: <n> swept, <n> driven, <n> owed. Steps: <n> met, <n> unmet.` Its
  data lists each station with its state and the step or check that gave it,
  each unmet step with its unmet expectations, and each step whose process end
  was not confirmed.
- `findings` returns the check count and each finding. `pending` returns the
  state add-on's report as it is.

The station rule passed on macOS only, with the prototype. `report` is
designed and not run.

**I12. Formats.** Three formats, each with a `schema` name ending in its
version. The snippets below are from this revision's runs. A scratch script,
not the helper, ran each step through the real programs add-on and wrote the
receipts in these formats. They are trimmed to the parts that carry a
decision, and paths are shown as `<repository>` and `<work>`.

A scenario file. Three of the six steps of the changing-command example:

```json
{
  "schema": "verify-scenario/1",
  "feature": "changing-command",
  "steps": [
    {
      "name": "first-run",
      "argv": ["save", "{work}/note", "--content", "proof", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "commandIdentity": "moons.save",
          "causeCode": "SUCCESS_COMPLETED",
          "transactionState": "completed",
          "effects.completed": ["note.write"]
        },
        "files": [{ "path": "{work}/note", "content": "proof" }]
      }
    },
    {
      "name": "interrupted-run",
      "runner": "bun",
      "timeoutMilliseconds": 3000,
      "argv": [
        "{repository}/scratch/held-save.ts",
        "{work}/state",
        "save",
        "{work}/held-note",
        "--content",
        "held",
        "--json"
      ],
      "expect": {
        "exitCode": 143,
        "timedOut": true,
        "stdout": "",
        "stderr": "",
        "files": [{ "path": "{work}/held-note", "absent": true }]
      }
    },
    {
      "name": "interruption-is-listed",
      "argv": ["pending", "--json"],
      "expect": {
        "exitCode": 0,
        "stderr": "",
        "result": {
          "causeCode": "SUCCESS_UNCHANGED",
          "data.unfinished.length": 1,
          "data.unfinished.0.commandIdentity": "moons.save"
        }
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
  `length` for a list.
- A `files` entry is a path with exact `content`, or with `"absent": true`.
- `{work}` becomes the absolute path of the run root's `work/` folder.
  `{repository}` becomes the repository root. Both are replaced in every
  string of `argv` and `expect`. No other text in braces is touched.
- Target steps must be exact. `stdoutIncludes` and `stderrIncludes` loosen
  that only where exact text is impossible, such as a test runner's timings.

The evidence index, `index.jsonl` in the run root's `evidence/` folder. One
run row, then one row for each step, in JSON Lines:

```json
{"schema":"verify-evidence-index/1","row":"run","repositoryRoot":"<repository>","target":"src/cli.ts","pinnedCommit":"5b89b1fd98a5dcc6f7e7924bb63f6d1756c3d795","bun":"1.4.4","platform":"darwin arm64","headCommit":"f0ab4e2491c60ed404ebc71e40ed96a2bce376d8","uncommittedPaths":11}
{"row":"step","feature":"read-only-command","step":"show-known-planet","runner":"target","verdict":"met","commandIdentity":"moons.show","causeCode":"SUCCESS_UNCHANGED","exitCode":0,"receipt":"receipts/read-only-command/show-known-planet.json","sha256":"286426ed2481cb2ad32ca7d674cc559226773c45a791e0e05d2de6458198cb3e"}
{"row":"step","feature":"read-only-command","step":"show-unknown-planet","runner":"target","verdict":"met","commandIdentity":null,"causeCode":null,"exitCode":3,"receipt":"receipts/read-only-command/show-unknown-planet.json","sha256":"c6603b56c44c8221e0eda96877a15afd2ec08e46a16913a3180cbde60a128cfb"}
```

- `commandIdentity` and `causeCode` are null when the step wrote no envelope
  or is not a target step. That is the credit rule of I11.
- `sha256` is the SHA-256 (Secure Hash Algorithm, 256 bits) hash of the
  receipt file's bytes. Every hash in this specification is that one.

A receipt, whole, for the interrupted step:

```json
{
  "schema": "verify-receipt/1",
  "feature": "changing-command",
  "step": "interrupted-run",
  "runner": "bun",
  "argv": [
    "<repository>/scratch/held-save.ts",
    "<work>/state",
    "save",
    "<work>/held-note",
    "--content",
    "held",
    "--json"
  ],
  "limits": { "timeoutMilliseconds": 3000, "outputLimitBytes": 1048576 },
  "expected": {
    "exitCode": 143,
    "timedOut": true,
    "stdout": "",
    "stderr": "",
    "files": [{ "path": "<work>/held-note", "absent": true }]
  },
  "observed": {
    "exitCode": 143,
    "timedOut": true,
    "outputTruncated": false,
    "terminationConfirmed": true,
    "stdoutBytes": 0,
    "stderrBytes": 0,
    "stdout": "",
    "stderr": ""
  },
  "unmet": [],
  "verdict": "met"
}
```

- `observed` holds `stdout` in full unless the step has a `result`
  expectation. Then it holds the observed value at each `result` key instead.
- `unmet` lists each expectation that did not hold, as a string: `exitCode`,
  `timedOut`, `outputTruncated`, `stdout`, `stderr`, `stdoutIncludes.<index>`,
  `stderrIncludes.<index>`, `result.<key>` or `files.<index>`. The verdict is
  `met` when the list is empty, else `unmet`.

Passed on macOS only, with the scratch script. The helper writing them is
designed and not run.

**I13. Scenario rules and bounds.** `drive` checks the whole file before any
step runs. A broken rule refuses with `DOMAIN_VERIFY_SCENARIO` and names the
rule.

| Rule id                   | What the rule refuses                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `unreadable`              | A file that is missing, is not JSON, or is over 1,048,576 bytes; the message says which                                                 |
| `unknown-field`           | A field this format does not name, or a `schema` other than `verify-scenario/1`                                                         |
| `bad-name`                | A `feature` or step `name` that is not 1 to 64 of lower-case letters, digits and hyphens                                                |
| `duplicate-step`          | Two steps with one name                                                                                                                 |
| `step-count`              | No step, or more than 200                                                                                                               |
| `exit-code-only`          | A step whose `expect` lacks `exitCode`, or has nothing but `exitCode` and `timedOut`                                                    |
| `includes-on-target-step` | `stdoutIncludes` or `stderrIncludes` on a target step                                                                                   |
| `path-outside-work`       | A `files` path that does not start `{work}/`, or that has a `..` segment                                                                |
| `limit-out-of-range`      | A `timeoutMilliseconds` outside 1 to 600,000, an `outputLimitBytes` outside 1 to 8,388,608, or step time limits that sum past 3,600,000 |

- No step passes on an exit code alone. Bun given a working folder as two
  words printed its usage text and exited 0, running nothing.
- Each step is bounded. The default time limit is 20,000 milliseconds, the
  default output limit 1,048,576 bytes for each stream, and the shutdown
  budget 500 milliseconds.
- A step that passes its time limit is unmet at `timedOut`, unless it expects
  `"timedOut": true`. A step whose output was cut is always unmet at
  `outputTruncated`.
- `drive` runs every step in order, whatever the earlier verdicts. It then
  succeeds, printing `<n> steps met.`, when every step was met. Otherwise it
  fails with `DOMAIN_VERIFY_UNMET`, naming the first unmet step and its unmet
  expectations.
- `drive` refuses with `DOMAIN_VERIFY_ALREADY_DRIVEN` when the index already
  holds a row for that feature. A receipt is never overwritten. The repair is
  a new run root.

The two-word working folder result and the verdict rules passed on macOS only.
The refusals are designed and not run.

**I14. The run root.** `launch <run root> <target>` makes three folders:
`work/`, which a run may fill and cleanup removes; `evidence/`, which holds
the index and the receipts; and `state/`, the helper's own state root.

- The run root must be new or empty, and outside every git work tree. The
  helper finds a work tree by a `.git` entry in the folder or any folder above
  it.
- The run row records the binding (I7), the pinned commit from the Pin, the
  Bun version, the platform, and two git facts about the repository root: its
  head commit and its count of uncommitted paths. With no `git` on the path,
  or when `git` says the root is not a work tree, both are null. Any other
  `git` failure refuses the launch with its reason.
- `cleanup` removes `work/` and nothing else. A second `cleanup` succeeds and
  removes nothing.
- The programs add-on ends each child's process group before a step returns,
  and says whether the group was seen empty. So cleanup stops nothing, by name
  or otherwise. The report lists each step whose end was not confirmed. A
  descendant that left its group is not seen.

Designed and not run. The process group behaviour was read in the kernel's
source, and seen for one stopped step on macOS.

**I15. Where state lives during a run.** Two different states.

- The helper's own state is in the run root's `state/` folder. Each run root
  has its own, so an unfinished helper change holds one run root and no other.
  `cleanup` keeps it; it is part of the record.
- The target's state is wherever the target puts it. The helper cannot move
  it. The skill's rule is that it goes under `work/`, in one of two ways. A
  target that takes its state root from an argument gets `{work}` in that
  argument. A target that takes it from an environment variable gets that
  variable set, on the command line that starts the helper, to a path under
  the run root's `work/` folder; every step inherits it.
- A target that fixes its state root inside the repository cannot be isolated
  without kernel unit K7. Its feature file says so under Gotchas. Its scenario
  can still judge the change through the target's own read-only commands.
  `cleanup` will not remove that state, and a `files` expectation cannot see
  it.

The environment variable route passed on macOS only, with the scratch script:
six steps met, with the target's state under `work/`.

**I16. What an interrupted change leaves.** Two cases.

- The target's change is interrupted. A step's time limit ends it. Seen on
  macOS: the child exits 143 with no output; the same change is then refused
  as unresolved; the target's pending command lists one unfinished operation;
  a change to another resource still succeeds. The changing-command scenario
  drives exactly this.
- The helper's own change is interrupted. `launch`, `drive` or `cleanup` then
  leaves an unresolved case in that run root's `state/`. Where no capability
  qualification row matches the platform, as on every Mac today, the state
  add-on hands off instead of closing it. The next changing command on that
  run root is refused with `DOMAIN_VERIFY_UNRESOLVED`. The repair is: read
  `pending <run root>`, keep the run root as evidence, and launch another.

The first case passed on macOS only. The second is designed and not run.

**I17. Diagnostics is not the evidence.** The diagnostics add-on redacts its
records, caps each at 64,000 bytes and prunes them after seven days. A receipt
must be exact, whole and lasting. So receipts are plain files, and diagnostics
holds only the helper's own trace. This overrules one line of the brief; the
[index](README.md#where-the-inputs-and-the-code-disagreed) shows it. The
limits were read in the kernel's source.
