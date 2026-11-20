# `verify-cli` specification, part 10 of 11: traceability

This part belongs to Further Notes. The source letters are in the
[index](README.md#sources). `RF` and `RS` are cited by axis and number, as the
reviews number their findings. Shortened paths:

| Short            | Full                                                 |
| ---------------- | ---------------------------------------------------- |
| `E/16` to `E/25` | The evidence file whose name starts with that number |
| `E/fmt/`         | `E/format-examples/`                                 |
| `KR/src/`        | `KR/kernel/src/`                                     |
| `KR/std/`        | `KR/docs/standards/`                                 |
| `KR/author/`     | `KR/skills/agent-cli-kernel/`                        |
| `KR/lint`        | `KR/kernel/config/kernel/eslint.mjs`                 |
| `TP/vt/`         | `TP/.agents/skills/verify-template/`                 |
| `R/unit-b/`      | `R/generated-unit-b/`                                |

## Implementation decisions

| Decision                            | Sources                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 name and placement               | `D:47`, `D:7`, `D:16`, `B:13`, `B:52`, `P:27`, `E/14-names-check.txt:2`                                                                                                                                                                                                                         |
| I2 source in the skill folder       | `D:50`, `B:15`, `E/21:3` to `:18`, `FW/evidence/18-self-reference-in-kernel-checkout.txt`                                                                                                                                                                                                       |
| I3 no `bin`                         | `D:51`, `B:46`, `C:11`                                                                                                                                                                                                                                                                          |
| I4 built on the kernel              | `D:8`, `B:19`, `C:12`, `IF:29`, `KR/src/kernel/declaration-checks.ts:199`, `KR/src/addons/programs/index.ts:15`, `:331`                                                                                                                                                                         |
| I5 judged from outside              | `B:21`, `C:13`, `IF:39`, `P:29`; a search of `KR/src/` for a terminal check found none                                                                                                                                                                                                          |
| I6 commands                         | `B:19`, `IF:19` to `:27`, `IF:40`, `IS:11` to `:18`, `KR/author/references/commands.md:120`, `R/unit-b/src/state-commands.ts:229`                                                                                                                                                               |
| I7 target binding                   | `RS` Spec 2, `RF` Spec 3, `B:21`, `KR/src/addons/programs/index.ts:65`, `:272`, `E/22`, `E/13-child-folder-and-environment.txt`, `E/16:9`                                                                                                                                                       |
| I8 exit and cause codes             | `IF:38`, `E/07-discover.txt:3`, `R/unit-b/src/state-commands.ts:15` to `:36`, `KR/src/kernel/causes.ts:99`, `KR/std/failure-envelopes.md:17`, `RF` Standards 11                                                                                                                                 |
| I9 `ready`                          | `IF:43`, `IF:53`, `D:18`, `KR/src/kernel/index.ts:84`, `E/16:16` to `:30`, `E/18:14` to `:29`, `E/24`, `KR/GLOSSARY.md:113`, `RF` Spec 3                                                                                                                                                        |
| I10 the sweep                       | `D:10`, `C:27`, `IF:37`, `FW/trial/verify-sketch/cli.ts:116` to `:236`, `KR/src/kernel/navigation.ts:12` to `:33`, `KR/src/kernel/declarations.ts:130`, `:142`, `E/16:12`, `E/18:37` to `:45`                                                                                                   |
| I11 scenarios and the report        | `D:10`, `C:23`, `C:27`, `IS:50`, `IF:44`, `IF:48`, `KR/src/kernel/navigation.ts:258` to `:261`, `E/23`, `RF` Spec 3                                                                                                                                                                             |
| I12 formats                         | `IS:30`, `IF:44`, `TP/vt/scripts/session.sh:85`, `:99`, `E/19`, `E/fmt/`, `RF` Spec 3                                                                                                                                                                                                           |
| I13 scenario rules and bounds       | `D:10`, `E/12-check-through-bun-cwd.txt:1` to `:9`, `KR/src/kernel/capabilities.ts:41` to `:43`, `FW/trial/verify-sketch/cli.ts:349`, `KR/CODING_STANDARDS.md:59`, `RF` Standards 8, `RF` judgement 10                                                                                          |
| I14 the run root                    | `B:22`, `P:33`, `TP/vt/SKILL.md:41`, `:89`, `TP/vt/scripts/session.sh:93` to `:100`, `IS:34`, `KR/src/addons/programs/index.ts:22`, `:302`, `KR/std/untrusted-values.md:51`, `E/17:23`                                                                                                          |
| I15 where state lives               | `RF` Spec 2, `B:34`, `R/unit-b/src/cli.ts:5`, `R/unit-b/src/state-commands.ts:65`, `E/19`, `E/fmt/changing-command/index.jsonl`                                                                                                                                                                 |
| I16 an interrupted change           | `B:34`, `E/17:21` to `:42`, `KR/src/addons/state/capability-qualification-table.ts:8`, `:37`                                                                                                                                                                                                    |
| I17 diagnostics is not the evidence | `B:19`, `B:22`, `C:24`, `IF:29`, `KR/src/addons/diagnostics/limits.ts:8`, `:17`                                                                                                                                                                                                                 |
| I18 the trust model                 | `B:20`, `B:39`, `C:10`, `C:32`, `IS:28`, `IF:38`, `RS` Spec 1, `RF` Spec 1, `RF` Spec 7, `RF` Standards 9, `KR/std/failure-envelopes.md:3`, `KR/std/one-owner.md:9`, `E/16`, `E/18:31` to `:35`                                                                                                 |
| I19 fit with the kernel repository  | `D:32`, `D:49`, `B:41`, `C:33`, `C:55`, `KR/GLOSSARY.md:247`, `KR/std/gate-coverage.md:151`, `KR/lint:231`, `:237`, `:377`, `:387`, `KR/.fallowrc.json:58`, `KR/scripts/check-file-size.ts:5`, `:49`, `E/15-kernel-repository-lint-on-skills.txt`, `FW/evidence/17-sketch-typecheck-lint.txt:6` |
| I20 without K7                      | `D:48`, `D:11`, `D:27`, `C:15`, `E/22`, `E/12-check-through-bun-cwd.txt:43` to `:44`                                                                                                                                                                                                            |
| I21 skill document and map          | `B:13`, `B:34`, `P:27` to `:38`, `KR/GLOSSARY.md:270`, `KR/author/SKILL.md:35`, `E/19:19` to `:23`, `RF` Standards 10                                                                                                                                                                           |

## Testing decisions

| Decision                | Sources                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TD1 the process surface | `D:51`, `KR/CODING_STANDARDS.md:47`, `KR/std/test-proof.md:81`, `:87`, `KR/tests/kernel/author-guide/author-guide.test.ts:44`, `KR/docs/agents/author-guide.md:28`   |
| TD2 in-process tests    | `D:53`, `KR/CODING_STANDARDS.md:48`, `KR/std/test-proof.md:93`, `:98`, `KR/author/references/testing.md:8`, `RS` Standards 1, `RF` Standards 1, `TS:15`              |
| TD3 a good test         | `KR/std/test-proof.md:12`, `:27`, `:32`, `:52`, `:59`, `KR/CODING_STANDARDS.md:49` to `:51`, `D:49`                                                                  |
| TD4 planted faults      | `KR/CODING_STANDARDS.md:46`, `KR/std/test-proof.md:104`, `:118`, `KR/GLOSSARY.md:219`, `:224`, `RS` Standards 2, `RF` Standards 2, `IF:41`, `C:35`, `B:39`           |
| TD5 platforms           | `B:38`, `KR/CODING_STANDARDS.md:61`, `KR/std/platform-parity.md:3`, `:22`                                                                                            |
| TD6 prior art           | `KR/tests/kernel/author-guide/author-guide.test.ts:44`, `KR/author/references/testing.md:47`, `TP/vt/SKILL.md:80`, `R/unit-b/tests/state.test.ts:67`, `:111`, `:147` |

## Acceptance criteria

Each criterion, the decisions it shows, and the run behind a `macOS` tag.

| Criteria                   | Decisions               | Evidence                                               |
| -------------------------- | ----------------------- | ------------------------------------------------------ |
| AC1, AC2                   | I10                     | `E/16:12` to `:14`, `E/20:4` to `:7`                   |
| AC3                        | I10                     | `E/18:37` to `:41`                                     |
| AC4                        | I9                      | `E/16:9` to `:11`, `E/20:10` to `:12`                  |
| AC5, AC6                   | I9, I18                 | `E/16:16` to `:30`                                     |
| AC7, AC8, AC9              | I9, I10, TD4            | None: designed                                         |
| AC10                       | I6, I10                 | `E/16:125` to `:131`                                   |
| AC11                       | I18                     | `E/16:32` to `:113`                                    |
| AC12                       | I18                     | `E/16:33` to `:35`, `:40` to `:42`                     |
| AC13                       | I18                     | `E/16:115` to `:121`                                   |
| AC14                       | I18                     | `E/16:36` to `:39`                                     |
| AC15, AC16                 | I18                     | None: designed                                         |
| AC17                       | I2                      | `E/21:3` to `:15`                                      |
| AC18                       | I7                      | `E/22`                                                 |
| AC19 to AC22               | I7, I8, I14             | None: designed                                         |
| AC23                       | I11, I12                | `E/fmt/read-only-command/`                             |
| AC24                       | I12, I13                | `E/fmt/read-only-command-unmet/`                       |
| AC25, AC26, AC27           | I13                     | None: designed                                         |
| AC28                       | I12, I16                | `E/fmt/changing-command/`, `E/17`                      |
| AC29                       | I15                     | `E/19:15` to `:17`                                     |
| AC30                       | I13, I20                | `E/12-check-through-bun-cwd.txt:9`, `:23`, `:48`       |
| AC31                       | I11                     | None: designed                                         |
| AC32                       | I11                     | `E/23`                                                 |
| AC33, AC34, AC35           | I14, I16                | None: designed                                         |
| AC36 to AC38, AC40 to AC45 | I19, I21, TD1, TD2, TD4 | None: designed                                         |
| AC39                       | I1, I19                 | `E/25`                                                 |
| AC46, AC47                 | TD5, I21                | None: designed. Sources `B:38`, `B:40`, `P:42`, `C:16` |
| AC48                       | Slice S6                | `E/20`. Sources `D:9`, `B:56` to `:65`                 |

## Slices

| Slice | Decisions it builds                                  | Sources beyond those decisions' own                            |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------- |
| S1    | I1 to I5, I7, I9, I18 without its evidence step, I19 | `B:20`, `B:41`                                                 |
| S2    | I10, the comparison step of I18                      | `D:10`, `C:27`                                                 |
| S3    | I14, I16, the binding of I7                          | `B:19`, `B:22`                                                 |
| S4    | I11, I12, I13, I15, the evidence step of I18         | `D:10`, `B:22`                                                 |
| S5    | I21, TD1, TD5                                        | `B:13`, `B:34`, `B:38`, `B:40`, `P:42`                         |
| S6    | None: it reports                                     | `D:9`, `B:56` to `:65`, `B:54`, `RS` Spec 3, `RF` judgement 13 |

## User stories

| Stories    | Decisions      | Criteria                  |
| ---------- | -------------- | ------------------------- |
| 1, 2       | I1, I3         | AC42, AC45                |
| 3, 4       | I7             | AC18                      |
| 5 to 9     | I18            | AC11 to AC16              |
| 10, 11     | I9             | AC5, AC6, AC7             |
| 12, 13     | I9             | AC4, AC8                  |
| 14 to 17   | I6, I10        | AC1, AC2, AC9, AC10       |
| 18, 19     | I10, I11       | AC3, AC32                 |
| 20 to 24   | I7, I14        | AC19 to AC21              |
| 25 to 29   | I12, I13       | AC23 to AC25, AC27        |
| 30, 31, 32 | I15, I16       | AC28, AC29                |
| 33, 34     | I20, I21       | AC30, AC24                |
| 35, 36     | I13            | AC24, AC26                |
| 37, 38     | I11            | AC31, AC34                |
| 39, 40, 41 | I14            | AC33                      |
| 42         | I18            | AC15                      |
| 43, 44     | I16, I8        | AC35, AC22                |
| 45, 46     | I21            | AC45                      |
| 47, 48     | TD4            | AC11, AC44                |
| 49         | TD2            | AC43                      |
| 50         | I19            | AC37, AC38                |
| 51         | I6, I8, I12    | AC45                      |
| 52         | I19            | AC41                      |
| 53         | I20            | AC36                      |
| 54         | I2             | AC17                      |
| 55, 56     | The index      | The two tables at its top |
| 57         | TD5            | AC46, AC47                |
| 58         | Slice S6       | AC48                      |
| 59         | `findings.tsv` | One row for each finding  |

Proposals without a source, the glossary words and the new words are in [part
11](11-proposals-and-words.md).
