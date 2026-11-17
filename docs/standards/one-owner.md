# One Owner

The shared rule "One owner per sealed vocabulary and per test fake" applies.
This repository also drifted on constants and helpers, so the rule covers them
here.

- Import a cause code, route token, or built-in identity from its owner
  module. Witnessed: [56aee86], [e7c771c].
- Run a format or shape rule through its one helper. A second copy of a
  constructor's shape rule gave admission a different refusal text.
  Witnessed: [892a700], [f2270b3].
- Import shared test fakes and fixtures from
  `tests/kernel/kernel-repair/handlers.ts` and `shapes.ts`. Witnessed:
  [810345d], [cf72627].
- Isolate a test's git from the caller's configuration with `gitEnv` from
  `tests/support/git-fixture.ts`, and set it on `process.env` around an
  in-process subject that runs git. It disables the global and system files
  and clears runtime configuration (`GIT_CONFIG_COUNT`, its `KEY_n` and
  `VALUE_n` pairs, and `GIT_CONFIG_PARAMETERS`). A user's `diff.orderFile`
  changed what the staged readers listed. Witnessed: [f929eb7], [7a62deb].

[56aee86]: https://github.com/nathanvale/bun-typescript-template/commit/56aee86bf059fb2629819fa2b6a1664d776629d5
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[892a700]: https://github.com/nathanvale/bun-typescript-template/commit/892a7005ab00d6ffb24b8d760e9d4a2dc9e0b081
[f2270b3]: https://github.com/nathanvale/bun-typescript-template/commit/f2270b3916114f0d693544fb1dfb3ed190c92288
[810345d]: https://github.com/nathanvale/bun-typescript-template/commit/810345d01ab28f5b3108ea4b5420fb05743ec6b4
[cf72627]: https://github.com/nathanvale/bun-typescript-template/commit/cf726279ccbe1fa540745be879343c379390fdd1
[f929eb7]: https://github.com/nathanvale/bun-typescript-template/commit/f929eb7fe9fbba24f5990269c27cddf302deb9de
[7a62deb]: https://github.com/nathanvale/bun-typescript-template/commit/7a62deb4233ecad8b18fb1206b03f70e0d1262f3
