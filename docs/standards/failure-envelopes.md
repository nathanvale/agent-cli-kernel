# Failure Envelopes

Every run ends with exactly one valid envelope, or with the documented crash
outcome. Review each new throw site, stream write, and early exit against this
list. The lessons recur across pull requests #4, #5, and #6.

- Register the stdout failure handler before any output, built-in inspection
  included. A failed write still ends in one result, with the repair on
  stderr. Witnessed: [#4 r4023874167], [#5 r4575438112].
- Turn a failure while loading a domain or attaching an add-on before handler
  entry into one structured internal result (`INTERNAL_PREPARATION` in
  Contract 3). Witnessed: [#5 r4575427486], [1a93f4b].
- Report a refusal after a completed transaction with its completed effects.
  Witnessed: [2b6ff5f], [75b4bc0].
- Let a handoff replace the default next action, so one envelope carries one
  guidance path. Witnessed: [#5 r4575427505].
- Name the exact restriction that refused the input in the repair message.
  Witnessed: [#4 r4024233462], [4afda36] (the recipe table's last refusal
  was reached by elimination, not by a check of its own condition),
  [8cbec55] (a fault record file that could not be read was reported as
  bad JSON with a JSON repair; Sol 6.1 review).
- Give each result an entry can return a case of its own, the one with no
  envelope included. Witnessed: [kernel#6 r4622774177] (`runInProcess`
  returned `no-envelope` when the result and the fallback both failed, and
  no case reached it).

[#4 r4023874167]: https://github.com/nathanvale/bun-typescript-template/pull/4#discussion_r4023874167
[#4 r4024233462]: https://github.com/nathanvale/bun-typescript-template/pull/4#discussion_r4024233462
[#5 r4575438112]: https://github.com/nathanvale/bun-typescript-template/pull/5#discussion_r4575438112
[#5 r4575427486]: https://github.com/nathanvale/bun-typescript-template/pull/5#discussion_r4575427486
[#5 r4575427505]: https://github.com/nathanvale/bun-typescript-template/pull/5#discussion_r4575427505
[1a93f4b]: https://github.com/nathanvale/bun-typescript-template/commit/1a93f4b2146443c7dd042e0ebe0b9d430d946a51
[2b6ff5f]: https://github.com/nathanvale/bun-typescript-template/commit/2b6ff5f68d91326f7f51f67710e0f81a1b8377f6
[75b4bc0]: https://github.com/nathanvale/bun-typescript-template/commit/75b4bc045d038970858b95b136f9f176fd3fc4cc
[4afda36]: https://github.com/nathanvale/bun-typescript-template/commit/4afda36976516ad56087d6afc2ae6a69ca01e68d
[kernel#6 r4622774177]: https://github.com/nathanvale/agent-cli-kernel/pull/6#discussion_r4622774177
[8cbec55]: https://github.com/nathanvale/agent-cli-kernel/commit/8cbec55e65afbbba5650d447e00cac40ce0e01c3
