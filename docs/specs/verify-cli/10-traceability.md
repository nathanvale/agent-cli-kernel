# `verify-cli` specification, part 10 of 11: traceability

This part belongs to Further Notes. The source letters are in the
[map](00-map.md#sources). `RF` and `RS` are cited by axis and number, as the
reviews number their findings. Shortened paths:

| Short            | Full                                                 |
| ---------------- | ---------------------------------------------------- |
| `E/16` to `E/27` | The evidence file whose name starts with that number |
| `KR/src/`        | `KR/kernel/src/`                                     |
| `KR/std/`        | `KR/docs/standards/`                                 |
| `KR/author/`     | `KR/skills/agent-cli-kernel/`                        |
| `KR/lint`        | `KR/kernel/config/kernel/eslint.mjs`                 |
| `TP/vt/`         | `TP/.agents/skills/verify-template/`                 |
| `R/unit-b/`      | `R/generated-unit-b/`                                |
| `BW/skill/`      | `BW/skills/verify-cli/`                              |
| `BW/tests/`      | `BW/tests/kernel/verify-skill/`                      |
| `BE/mac`         | `BE/mac-transcript.txt`                              |
| `BE/linux`       | `BE/linux/linux-transcript.txt`                      |
| `BE/faults`      | `BE/kernel-faults/kernel-faults-transcript.txt`      |
| `BE/check`       | `BE/checks/check-0d7c96b.txt`                        |
| `BE/replay`      | `BE/checks/replay-changed-0d7c96b.txt`               |

## Implementation decisions

| Decision                                    | Sources                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 name and placement                       | `D:47`, `D:7`, `D:16`, `B:13`, `B:52`, `P:27`, `BW/skill/SKILL.md:3`                                                                                                                                                                                                                                                                |
| I2 source in the skill folder               | `D:50`, `B:15`, `BW/tests/portable.test.ts:29`, `:48`, `:67`, `E/21:3` to `:18`                                                                                                                                                                                                                                                     |
| I3 no `bin`                                 | `D:51`, `B:46`, `C:11`, `BW/skill/SKILL.md:168`, `BE/mac:76`, `BE/linux:99`                                                                                                                                                                                                                                                         |
| I4 built on the kernel                      | `D:8`, `B:19`, `C:12`, `IF:29`, `CR:8`, `CB:5`, `KR/src/kernel/declaration-checks.ts:199`, `KR/src/addons/programs/index.ts:15`, `BW/skill/helper/launch.ts:274`, `BW/skill/helper/drive.ts:147`, `:305`, `BW/skill/helper/cleanup.ts:29`, `BW/docs/standards/single-witness.md:15`, `BW/kernel/src/kernel/validation/result.ts:97` |
| I5 judged from outside                      | `B:21`, `C:13`, `IF:39`, `P:29`; a search of `KR/src/` for a terminal check found none                                                                                                                                                                                                                                              |
| I6 commands                                 | `B:19`, `IF:19` to `:27`, `IF:40`, `KR/author/references/commands.md:120`, `BW/skill/SKILL.md:171` to `:181`, `BW/skill/helper/pending.ts:22`, `CB:6`, `CB:8`, `RS` and `CR:19` on AC9                                                                                                                                              |
| I7 target binding                           | `RS` Spec 2, `RF` Spec 3, `B:21`, `BW/skill/verify.ts:87` to `:135`, `BW/skill/helper/place.ts:52`, `BW/tests/ready.test.ts:128`, `:145`, `E/22`                                                                                                                                                                                    |
| I8 exit and cause codes                     | `BW/skill/helper/causes.ts:21` to `:62`, `CR:7`, `CB:11`, `BW/kernel/src/kernel/validation/result.ts:118` to `:128`, `E/07-discover.txt:3`, `BE/mac:244` to `:246`, `KR/std/failure-envelopes.md:17`                                                                                                                                |
| I9 `ready`                                  | `IF:43`, `D:18`, `BW/skill/helper/ready.ts:26`, `:80` to `:96`, `BW/skill/helper/place.ts:11`, `BE/mac:92` to `:107`, `E/18:14` to `:29`, `KR/GLOSSARY.md:113`                                                                                                                                                                      |
| I10 the sweep                               | `D:10`, `C:27`, `IF:37`, `BW/skill/helper/target.ts:68` to `:101`, `BW/skill/helper/sweep.ts:81` to `:224`, `BE/mac:215` to `:238`, `BW/tests/sweep.test.ts:92`                                                                                                                                                                     |
| I11 scenarios and the report                | `D:10`, `C:23`, `IS:50`, `IF:44`, `IF:48`, `BW/skill/helper/target.ts:99`, `BW/skill/helper/report.ts:151`, `BE/mac:130` to `:157`                                                                                                                                                                                                  |
| I12 formats                                 | `IS:30`, `IF:44`, `BW/skill/helper/place.ts:7` to `:9`, `:81` to `:104`, `:207`, `BW/skill/helper/verdict.ts:108` to `:150`, `BW/skill/features/changing-command.md:34`, `BE/mac-run/evidence/`                                                                                                                                     |
| I13 scenario rules, bounds, contract checks | `D:10`, `E/12-check-through-bun-cwd.txt:1` to `:9`, `BW/skill/helper/scenario.ts:8` to `:13`, `BW/skill/helper/verdict.ts:35` to `:58`, `BW/skill/helper/target.ts:5`, `BW/skill/helper/drive.ts:128` to `:134`, `CB:7`, `KR/CODING_STANDARDS.md:59`                                                                                |
| I14 the verification run                    | `B:22`, `P:33`, `TP/vt/SKILL.md:41`, `TP/vt/scripts/session.sh:93` to `:100`, `BW/skill/helper/launch.ts:142` to `:185`, `BW/skill/helper/cleanup.ts:120`, `KR/src/addons/programs/index.ts:22`, `BE/mac:159` to `:183`                                                                                                             |
| I15 where state lives                       | `RF` Spec 2, `B:34`, `BW/skill/SKILL.md:44`, `BW/tests/drive.test.ts:237`, `E/19:15` to `:17`                                                                                                                                                                                                                                       |
| I16 an interrupted change                   | `B:34`, `CB:10`, `BW/tests/report.test.ts:280`, `:307`, `BW/tests/drive.test.ts:205`, `E/17:21` to `:42`, `KR/src/addons/state/capability-qualification-table.ts:8`                                                                                                                                                                 |
| I17 diagnostics is not the evidence         | `B:19`, `B:22`, `C:24`, `IF:29`, `KR/src/addons/diagnostics/limits.ts:8`, `:17`, `BW/skill/helper/drive.ts:312`                                                                                                                                                                                                                     |
| I18 the trust model                         | `B:20`, `B:39`, `C:10`, `C:32`, `RS` Spec 1, `RF` Spec 1, `RF` Standards 9, `KR/std/failure-envelopes.md:3`, `BW/skill/verify.ts:29` to `:76`, `:391` to `:446`, `:527` to `:539`, `BE/faults`, `PB`, `E/16`, `E/18:31` to `:35`                                                                                                    |
| I19 fit with the kernel repository          | `D:32`, `D:49`, `B:41`, `C:33`, `KR/GLOSSARY.md:247`, `KR/std/gate-coverage.md:151`, `KR/lint:231`, `:377`, `:387`, `BW/config/verify-skill-lint.mjs`, `BW/.fallowrc.json:35`, `:114`, `BW/tsconfig.json:7`, `BW/skill/verify.ts:588`, `CB:9`, `BE/check`                                                                           |
| I20 without the parked unit                 | `D:48`, `D:11`, `D:27`, `C:15`, `BW/tests/drive.test.ts:256`, `:301`, `E/12-check-through-bun-cwd.txt:43` to `:44`                                                                                                                                                                                                                  |
| I21 skill document and map                  | `B:13`, `B:34`, `P:27` to `:38`, `KR/GLOSSARY.md:270`, `BW/skill/SKILL.md`, `BW/skill/features/README.md`, `BW/tests/document.test.ts:37`, `CB:13`, `E/19:19` to `:23`                                                                                                                                                              |

## Testing decisions

| Decision                | Sources                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TD1 the process surface | `D:51`, `KR/CODING_STANDARDS.md:47`, `KR/std/test-proof.md:81`, `:87`, `KR/tests/kernel/author-guide/author-guide.test.ts:44`, `BW/tests/install.test.ts:63`                                      |
| TD2 in-process tests    | `D:53`, `KR/CODING_STANDARDS.md:48`, `KR/std/test-proof.md:93`, `:98`, `KR/author/references/testing.md:8`, `RS` Standards 1, `RF` Standards 1, `TS:15`, `BW/tests/in-process.test.ts:61`, `CB:9` |
| TD3 a good test         | `KR/std/test-proof.md:12`, `:27`, `:32`, `:52`, `:59`, `KR/CODING_STANDARDS.md:49` to `:51`, `D:49`                                                                                               |
| TD4 planted faults      | `KR/CODING_STANDARDS.md:46`, `KR/std/test-proof.md:104`, `:118`, `RS` Standards 2, `RF` Standards 2, `IF:41`, `B:39`, `BW/tests/planted-faults/fault-records/`, `BE/replay`                       |
| TD5 platforms           | `B:38`, `KR/CODING_STANDARDS.md:61`, `KR/std/platform-parity.md:3`, `:22`, `BE/linux`, `E/26`                                                                                                     |
| TD6 prior art           | `KR/tests/kernel/author-guide/author-guide.test.ts:44`, `KR/author/references/testing.md:47`, `TP/vt/SKILL.md:80`, `R/unit-b/tests/state.test.ts:67`, `:111`, `:147`, `E/26`                      |

## Acceptance criteria

Each criterion, the decisions it shows, and the run behind its last column.
`E/26` is this round's run of the build's tests, which lists every title.

| Criteria                     | Decisions               | Evidence                                                                   |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| AC1, AC2                     | I10                     | `BE/linux:224`, `BE/mac:215` to `:238`, `E/26`                             |
| AC3                          | I10                     | `E/26`, `E/18:37` to `:41`                                                 |
| AC4                          | I9                      | `BE/linux:100`, `BE/mac:92` to `:107`                                      |
| AC5 to AC10                  | I6, I9, I10, I18        | `E/26`                                                                     |
| AC11                         | I18                     | `BE/faults:1` to `:260`, `E/26`                                            |
| AC12 to AC18, AC49           | I2, I7, I18             | `E/26`; `BE/faults:263` to `:375` for AC13                                 |
| AC19                         | I14                     | `BE/mac:76` to `:89`, `BE/linux:81` to `:96`                               |
| AC20, AC21, AC22             | I8, I14                 | `E/26`                                                                     |
| AC23                         | I11, I12                | `BE/mac:110` to `:127`, `:248` to `:252`, `BE/linux:118`, `:257`           |
| AC24 to AC30, AC50, AC51     | I12, I13, I15, I16, I20 | `E/26`                                                                     |
| AC31                         | I11                     | `BE/mac:131`, `BE/linux:138`                                               |
| AC32, AC34, AC35, AC52, AC53 | I11, I14, I16           | `E/26`                                                                     |
| AC33                         | I14                     | `BE/mac:159` to `:212`, `:244` to `:246`, `BE/linux:166` to `:220`, `:253` |
| AC36                         | I19                     | `BE/check:220`. The hosted result was not read                             |
| AC37, AC38, AC42, AC45       | I19, I21, TD1           | `E/26`                                                                     |
| AC39                         | I1, I19                 | `BE/check`, and `E/27` for this folder's own paths                         |
| AC40, AC43                   | I19, TD2                | `BE/check:3`, `:207` to `:220`                                             |
| AC41                         | I19                     | A search of `BW/skill/` and `BW/tests/` in this round found none           |
| AC44                         | TD4                     | `BE/replay`: 148 of 148 killed. 145 of the records are this skill's        |
| AC46                         | TD5, I21                | `BE/mac`, `BE/linux`, `BE/linux/mini-cleanup.txt`, `PB`                    |
| AC47                         | I21                     | `BE/cold/run/command-ledger.md`                                            |
| AC48                         | Slice S6                | Not run. `E/20` holds two seed trials. Sources `D:9`, `B:56` to `:65`      |

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

| Stories    | Decisions      | Criteria                 |
| ---------- | -------------- | ------------------------ |
| 1, 2       | I1, I3         | AC42, AC45               |
| 3, 4       | I7             | AC18                     |
| 5 to 9     | I18            | AC11 to AC16             |
| 10, 11     | I9             | AC5, AC6, AC7            |
| 12, 13     | I9             | AC4, AC8                 |
| 14 to 17   | I6, I10        | AC1, AC2, AC9, AC10      |
| 18, 19     | I10, I11       | AC3, AC32                |
| 20 to 24   | I7, I14        | AC19 to AC21             |
| 25 to 29   | I12, I13       | AC23 to AC25, AC27       |
| 30, 31, 32 | I15, I16       | AC28, AC29               |
| 33, 34     | I20, I21       | AC30, AC24               |
| 35, 36     | I13            | AC24, AC26               |
| 37, 38     | I11            | AC31, AC34               |
| 39, 40, 41 | I8, I14        | AC33                     |
| 42         | I18            | AC15                     |
| 43, 44     | I16, I8        | AC35, AC22               |
| 45, 46     | I21            | AC45                     |
| 47, 48     | TD4            | AC11, AC44               |
| 49         | TD2            | AC43                     |
| 50         | I19            | AC37, AC38               |
| 51         | I6, I8, I12    | AC45                     |
| 52         | I19            | AC41                     |
| 53         | I20            | AC36                     |
| 54         | I2             | AC17                     |
| 55, 56     | The map        | The tables at its top    |
| 57         | TD5            | AC46, AC47               |
| 58         | Slice S6       | AC48                     |
| 59         | `findings.tsv` | One row for each finding |
| 60, 61     | I14            | AC20, AC21               |
| 62, 63     | I13            | AC50, AC25               |
| 64         | I18            | AC49                     |
| 65         | I8             | AC52                     |
| 66         | I18            | AC11                     |

Proposals without a source, the words, and this folder's place and sizes are
in [part 11](11-proposals-and-words.md).
