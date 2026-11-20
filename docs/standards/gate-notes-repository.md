# Repository Gate Notes

What the gates of the repository rows refuse and where, what stays with the reviewer, and which witnesses taught each note. The [rule table](../../CODING_STANDARDS.md#rule-table) links each note.

## Linux and macOS

- `.github/workflows/ci.yml` runs on every pull request.
- `R1.platform-outcomes-pinned` pins unproved diagnostics rows only.
- State `caseTest` and `supportingTest` cases can go unproved off their
  platform; only the in-process ones are pinned, as Platform Parity says
  (fault `a0d17cc-in-process-control`).
- `tests/kernel/approval/component.test.ts` still reports unproved cases
  through `test.skip`.
- `.github/workflows/macos-nightly.yml` runs on schedule once it reaches
  `main`.
- Lint `repository/no-host-path-literal` refuses a string, or the head of a
  template literal, that starts at `/private`, `/usr`, `/var`, `/tmp`,
  `/etc`, `/opt`, `/Users`, `/home`, `/Library` or `/System`, in every file
  `eslint.config.mjs` lints outside the kernel. `/dev/null`, `/bin/sh` and a
  shebang pass: both hosts have them.
- Fault `b79a4ac-platform-rules` drops `/private` from that list; the lint
  case for the [ff5fffe] shape kills it.
- Review only: a path built at run time, such as `"/" + "tmp"` or
  `join("/", "usr")`; a host path after a template expression; other roots,
  such as `/proc` or `/run`; and `kernel/` and `tests/kernel/`, which this
  lint skips.
- Witnessed: [8e4ec47], [ff5fffe].

## Glossary

- `tests/template/glossary/glossary.test.ts`, with its shrinking `known-hits.json`,
  checks the `scope` listed in `tests/template/glossary/term-table.json`.
- That scope is kernel source, kernel tests, and the kernel's lint config.
  `src/` and docs are review only.
- Witnessed: [2784de0], [356cce9].

## Untrusted values

- Review scopes and exceptions in [Untrusted-value lints](gate-coverage.md#untrusted-value-lints).
- Fault `b9e392f-payload-rules` lets an index signature declare every key;
  the lint case for the [r4580070979] shape kills it.
- Witnessed: [b456208], [5cbff3a], [r4580070968], [r4580070979],
  [r4580077776], [r4606943328].

## One owner

- Lint `repository/tests-use-test-folder` refuses `tmpdir()`, `mkdtemp()`
  and `mkdtempSync()` in `tests/`, outside `tests/support/test-folder.ts`.
  That shared `tests/support/` module owns test folders through
  `testFolder()`, which honours `STATE_TEST_DIR`.
- The lint traces a callee to the name it was imported or read as: a named,
  renamed, default or namespace import, `require()`, `import()`,
  destructuring, an alias, or a member with a string key. A key built at
  runtime, a function passed in as a parameter, and a helper module that
  re-exports one under another name stay review.
- Witnessed: [e7c771c], [c0b4bf5].

## Commits

- `bun run check:commits <base>` installs, type-checks and lints each commit
  in `<base>..HEAD` at its own head, in a temporary worktree. Four
  `commits-shard` jobs split a pull request's range; `commits` needs all.
- It never checks `f20777f` or an older commit. Some of those are red.
- Format and tests at each commit stay review.
- Witnessed: [2d0c390], [258365e], [59d45c1], [de45f44], [d3df03e],
  [4737c48], [e07d962].

## Comments

- The lint checks comment markers, directives and cast placement.
  Review the truth of `Platform:` and `Interface:` claims. See [the gate's coverage](gate-coverage.md#comments).
- Witnessed: [08284b7], [887b514].

## Recorded hits

Use the [recorded hits guide](gate-coverage.md#recorded-hits)
when adding, fixing, or pruning a lint hit.

[c0b4bf5]: https://github.com/nathanvale/bun-typescript-template/commit/c0b4bf5e77558cc08922d5b303f5d9ba0af87066
[b456208]: https://github.com/nathanvale/bun-typescript-template/commit/b456208a45baa1f912a27a60eb70353c1e64d251
[5cbff3a]: https://github.com/nathanvale/bun-typescript-template/commit/5cbff3a87746defffd2672320038c48fbd1ddbc6
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[2784de0]: https://github.com/nathanvale/bun-typescript-template/commit/2784de083f90d5f72f1b10037bfc64a8eeccff3f
[356cce9]: https://github.com/nathanvale/bun-typescript-template/commit/356cce90dd2c4a75c7462f5d8f789b52bdaefaed
[2d0c390]: https://github.com/nathanvale/bun-typescript-template/commit/2d0c3902e6ca538b1e9dfd64c97458bd4b4f88ae
[258365e]: https://github.com/nathanvale/bun-typescript-template/commit/258365ed51313b4b190361d79609bc93bfc13d6a
[59d45c1]: https://github.com/nathanvale/bun-typescript-template/commit/59d45c1b84d347e3a8b2d617ac73e36096790dc9
[de45f44]: https://github.com/nathanvale/bun-typescript-template/commit/de45f443c1c71221a29ae03c203bd00ef1a4bffb
[d3df03e]: https://github.com/nathanvale/bun-typescript-template/commit/d3df03eccd47e3054de9e442971f778d1f13e803
[4737c48]: https://github.com/nathanvale/bun-typescript-template/commit/4737c4869802bb53893387df9919171855e83b11
[e07d962]: https://github.com/nathanvale/bun-typescript-template/commit/e07d962f016dc07ca442724621fd0406084521cc
[08284b7]: https://github.com/nathanvale/bun-typescript-template/commit/08284b762cf58a08777c846637a427e84caf0fe9
[887b514]: https://github.com/nathanvale/bun-typescript-template/commit/887b5140efe57411a674f872c1269d40b7bf019b
[8e4ec47]: https://github.com/nathanvale/bun-typescript-template/commit/8e4ec47c9603f50548edb7d71087bd7f8d840819
[ff5fffe]: https://github.com/nathanvale/bun-typescript-template/commit/ff5fffe0718d64921d899aba35fca14b58d6f69a
[r4580070968]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070968
[r4580070979]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070979
[r4580077776]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077776
[r4606943328]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943328
