# Untrusted Values

Declarations, argv, environment, files, and host-supplied objects are
untrusted until the boundary parser returns a frozen copy. Code past the
boundary trusts the types.

## Object model

- Check own data with `Object.hasOwn` where the lint does not reach: an
  index read such as `fields[key]` with a key from a payload, a key check
  in a test, and source kept in a string. Each also finds
  `Object.prototype` members such as `toString`. Witnessed: [r4580070968],
  [r4580070979], [r4580077776], [5cbff3a], [kernel#6 r4622839131] (a
  fixture's mode table ran `constructor`), [e766237] (the pattern
  worker's source, moved into a string in `input.ts`, still checked its
  message with `in` and read each field twice).
- Read each value once into the copy you validate, then check and use that
  same copy. A second read of an accessor, or a read after an `await`, can
  differ. Witnessed: [75b4bc0], [r4580077763], [3088c03], [r4606886521],
  [r4606943307] (the `no-in-operator` repair read a member expression
  twice), [0669e10] (a scenario reader read `stdoutIncludes` twice).
- Validate the same object you pass on. A spread drops non-enumerable
  properties, and a hidden `toJSON` rewrites serialised data. Witnessed:
  [r4580070938], [r4580077749], [8cbec55] (the standards check spread a
  parsed fault record after its file path, so a `file` key in the record
  replaced the path a problem names; Sol 6.1 review).
- Brand-check a platform object such as an `AbortSignal` or a typed array
  by reading its prototype's getter with the value as receiver, inside one
  catch with any `instanceof` test. `instanceof` and an own property both
  pass for `Object.create(AbortSignal.prototype)`, a real `Uint8Array` can
  shadow `byteLength`, and `instanceof` throws for a revoked Proxy.
  Witnessed: [r4622699406], [r4622733380], [r4622712159] (an input defining
  `byteLength` as 0 passed a size limit), [r4622824082].
- Return frozen copies of tables and stations, so a caller keeps the
  validator's reference data intact. Witnessed: [r4580070877],
  [r4580070890].
- Compare identifiers and keys by code unit. `localeCompare` treats distinct
  keys as equal and follows the runtime collation. Witnessed: [r4580077765],
  [57c8c8b].

## Paths and outputs

- Judge a path by where it really is: resolve symbolic links in the part
  that exists, the path itself included, before walking its parents.
  Witnessed: [480dec5] (a run folder reached through a link into a checkout
  passed the work-tree rule), [02311f4] (a run folder that was itself a link
  into another run's scratch walked from outside that run; Sol check of pull
  request 55).
- Compare another program's output by a hash of its bytes, not only its
  length, blanking only a field drawn anew on every run. Witnessed:
  [b2dcc8f] (same-length altered stdout passed the probe comparison;
  CodeRabbit on pull request 55).

## Bounds

- Check `NaN` explicitly. `Math.max` and `Math.min` pass it through, and a
  wait compared against it never ends. Witnessed: [6021454].
- Arm a delay above 2,147,483,647 ms in steps. A runtime timer fires a longer
  delay after 1 ms. Witnessed: [f00dc2a].
- Bound every wait, including the settle after a handler returns. Witnessed:
  [b54d325], [1d03d99], [8de7e09] (a test's ledger poll had no bound),
  [0ab74b8] (the verification skill's front door gave `Bun.spawnSync` a
  timeout that only sends SIGTERM, so a child that ignored it outlived the
  bound, and its output had no cap), [0669e10] (the check read a run's index
  before arming any watchdog, so a FIFO there could block it), [90162b3]
  (drive read an expected file whole and threw on a folder there),
  [6df13fd] (the check and report read evidence files the same unbounded
  way), [1e3ac9a] (the check signalled only its child, so the target's own
  child outlived it, and a stop waited out the whole limit).
- State a complexity bound for each traversal and append. Witnessed:
  [r4580077771] (a shared subgraph cost about 2^35 visits), [d972ded]
  (quadratic append).

## Failed reads

- Read a failure as absence only when it says so, such as `ENOENT` or git's
  "not a git repository", and report every other failure with its reason on
  every read. A record or checkout that exists but cannot be read is the
  reader's problem, never a missing one. Witnessed: [kernel#13 r4624230310],
  [ff852e8] (a closer whose moved target was unreadable or corrupt would
  have reported a missing case; the fix shares `readProblem` with the first
  read), [kernel#48 r4637879772], [69fc0bf] (the doctor read every
  `git rev-parse` failure as no checkout, so a malformed git configuration
  passed as ok), [5048d5e] (the pinned-commit test's working-tree copy
  skipped a tracked file on any `lstat` failure; it now skips only
  `ENOENT`), [0ab74b8] (the verification skill read an unreadable step file
  as a clean step with no unmet check, and an unreadable `package.json` as a
  missing dependency), [0669e10] (it read an unreadable `package.json` as no
  toolchain pin, and every evidence read failure as a missing file),
  [480dec5] (git's "not a git repository" also names a broken work tree
  pointer, so launch now decides absence by the `.git` entry).
- Read a required input as present or refused, never as empty, so a missing
  input cannot pass for one with nothing in it. Witnessed: [r4609956011]
  (a missing patch file read as an empty patch, so replay reported that it
  held no hunk and `--changed-since` skipped its fault), [r4638567056],
  [8309f88] (`cause-literal-owner` read a missing `src/kernel/causes.ts` in
  a generated repository as no cause code, so every free cause literal
  passed), [911189b] (an old `fault-records.json` that a merge left in the
  tree was read by no reader, so its records never replayed and every gate
  passed; Fable review of pull request 54).

[r4580070968]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070968
[r4580070979]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070979
[r4580077776]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077776
[r4580077763]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077763
[r4580070938]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070938
[r4580077749]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077749
[r4580070877]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070877
[r4580070890]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070890
[r4580077765]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077765
[r4580077771]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077771
[r4606886521]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606886521
[r4606943307]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943307
[75b4bc0]: https://github.com/nathanvale/bun-typescript-template/commit/75b4bc045d038970858b95b136f9f176fd3fc4cc
[57c8c8b]: https://github.com/nathanvale/bun-typescript-template/commit/57c8c8b881c66e967688d05a3a70e1ef487c5553
[5cbff3a]: https://github.com/nathanvale/bun-typescript-template/commit/5cbff3a87746defffd2672320038c48fbd1ddbc6
[6021454]: https://github.com/nathanvale/bun-typescript-template/commit/6021454e9d4a5426724b08a17fabec084eca3eac
[f00dc2a]: https://github.com/nathanvale/bun-typescript-template/commit/f00dc2af3e7ea13f694b4adcfe0404ad6e4d8e9b
[b54d325]: https://github.com/nathanvale/bun-typescript-template/commit/b54d3256aa2b5302eeea41f33649093a82c5410d
[1d03d99]: https://github.com/nathanvale/bun-typescript-template/commit/1d03d99aee3455127c218056db2added1410912e
[d972ded]: https://github.com/nathanvale/bun-typescript-template/commit/d972ded023d0558d9cf47e4e7e2ee5eb5f37b029
[3088c03]: https://github.com/nathanvale/bun-typescript-template/commit/3088c032c90df81d9d0e5f93700c0769daac5cff
[8de7e09]: https://github.com/nathanvale/bun-typescript-template/commit/8de7e09c322e1b40304bad9f9332cb976048102e
[r4622699406]: https://github.com/nathanvale/agent-cli-kernel/pull/3#discussion_r4622699406
[r4622733380]: https://github.com/nathanvale/agent-cli-kernel/pull/3#discussion_r4622733380
[r4622712159]: https://github.com/nathanvale/agent-cli-kernel/pull/4#discussion_r4622712159
[r4622824082]: https://github.com/nathanvale/agent-cli-kernel/pull/3#discussion_r4622824082
[kernel#6 r4622839131]: https://github.com/nathanvale/agent-cli-kernel/pull/6#discussion_r4622839131
[kernel#13 r4624230310]: https://github.com/nathanvale/agent-cli-kernel/pull/13#discussion_r4624230310
[ff852e8]: https://github.com/nathanvale/agent-cli-kernel/commit/ff852e8f0daed7dc23fc8b092043ab2ddff68c8d
[kernel#48 r4637879772]: https://github.com/nathanvale/agent-cli-kernel/pull/48#discussion_r4637879772
[69fc0bf]: https://github.com/nathanvale/agent-cli-kernel/commit/69fc0bf37518800b76c9e9b9e5b1cba6934172bd
[5048d5e]: https://github.com/nathanvale/agent-cli-kernel/commit/5048d5e01932fa8ab9c177e351f33423cb507c1e
[e766237]: https://github.com/nathanvale/agent-cli-kernel/commit/e76623703cff72cc32c30a97164243e2cc86f255
[0ab74b8]: https://github.com/nathanvale/agent-cli-kernel/commit/0ab74b894857b6b741be277e2f2fd41764e96cd2
[r4609956011]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956011
[r4638567056]: https://github.com/nathanvale/bun-typescript-template/pull/116#discussion_r4638567056
[8309f88]: https://github.com/nathanvale/agent-cli-kernel/commit/8309f887aeabeedebd4f559e01ef319d78d39efa
[8cbec55]: https://github.com/nathanvale/agent-cli-kernel/commit/8cbec55e65afbbba5650d447e00cac40ce0e01c3
[911189b]: https://github.com/nathanvale/agent-cli-kernel/commit/911189bb75fa97d60acaacfba6034417522804aa
[0669e10]: https://github.com/nathanvale/agent-cli-kernel/commit/0669e10e32c420aa077e8491818f1d1417f1a1c9
[90162b3]: https://github.com/nathanvale/agent-cli-kernel/commit/90162b36d83506c2ea27fe67a08a10b358718ee6
[6df13fd]: https://github.com/nathanvale/agent-cli-kernel/commit/6df13fd160de1b9236151991bfdf1d60011c0a99
[1e3ac9a]: https://github.com/nathanvale/agent-cli-kernel/commit/1e3ac9add31562f55f160263790001e91357d626
[480dec5]: https://github.com/nathanvale/agent-cli-kernel/commit/480dec562f5b95c329df84b3e3f69125e3b20131
[b2dcc8f]: https://github.com/nathanvale/agent-cli-kernel/commit/b2dcc8feba2b211d775f3cc22f1bb16a0ffc4a1c
[02311f4]: https://github.com/nathanvale/agent-cli-kernel/commit/02311f4b282fa2c1fd75b6cee9b1f03a045d2df0
