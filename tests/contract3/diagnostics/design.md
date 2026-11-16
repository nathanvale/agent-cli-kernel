# T5 diagnostics add-on: design note

Frozen 16 November 2026 before production code, except the section "Seam
decision", which is open with the foundation coordinator. Case identities are
in `t5-cases.json` beside this note and do not change after this commit.

Authority: accepted contract manifest
`c162c9850ca506fd839ce36b2b1a8172f064516b0f229dd34a5678b366b02b9d`
(DIAG-1 to DIAG-17, CMD-16, CMD-17, LIFE-7, LIFE-9, DISC-6, V-24); oracle
`tests/contract3/expectations.json` (SHA-256
`16e02a3ea6ba1420b1d6e47bfb6cd1327758bca161d8ddd1d818f60f544460e4`); T5
test-design brief (SHA-256
`257f4d8a6cc32e57160c3b08fd1ccc86e14c1c28abacfca5592d05013c3d274f`) and its
coordinator review. Expected values come from those sources, never from the
add-on.

## Settled bindings

- Trigger (coordinator review note 1): diagnostics are triggered when the
  add-on is installed (`installedAddons` lists `diagnostics` and
  `runProcess` receives `addons.diagnostics`) and the dispatched command
  declares `capabilities.diagnostics`. No global switch, command option or
  environment toggle exists. A run that never dispatched a declaring command
  (routing refusal, usage refusal, deadline before start) is not triggered
  and carries no key.
- Location: `$XDG_STATE_HOME/<cli>/diagnostics` when `XDG_STATE_HOME` is an
  absolute path, otherwise `$HOME/.local/state/<cli>/diagnostics`. Nothing
  else moves it.
- Raw program stream retention stays disabled. No destination other than the
  one private file.
- Dependencies: `@logtape/logtape` and `@logtape/redaction` at exactly
  `2.4.2`, imported only under `addons/diagnostics/**`. LogTape supplies the
  logger, categories, explicit context (`withContext` over an
  `AsyncLocalStorage`) and field redaction; the add-on's own sink owns the
  descriptor. LogTape's path-opening file sink is not used (DIAG-8).

## Module (`starters/contract3/src/addons/diagnostics/`)

One deep module behind `diagnosticsAddon(options)`, returning the kernel's
`RunAddon<DiagnosticsCapability>`. Internal pieces, none exported past the
folder index:

- custody: resolve the directory, create or verify ancestors, refuse
  symlinks, FIFOs, non-directories and group or world writable ancestors
  without the sticky bit, verify `0700` and owner by `lstat` and `fstat`,
  then create the final file with `O_CREAT | O_EXCL | O_NOFOLLOW |
  O_NONBLOCK` at `0600` (mode enforced with `fchmod` on the descriptor
  before the first byte, so umask cannot widen or narrow it). Every write
  goes to that descriptor; nothing reopens by path.
- allocation: under a coordination lock (exclusively created lock file in
  the directory, holder pid inside, stale only when that pid is not alive),
  prune and reserve. Confirmed-closed logs are those whose last line is the
  add-on's closure record; anything else is ambiguous and never pruned.
  Each non-closed log is charged at `max(size, 1,000,000)` so concurrent
  growth cannot pass the aggregate cap. Prune closed logs whose mtime is
  older than seven days, then oldest closed first, until this run's
  1,000,000 bytes and one file fit. No room: no file, `sinkFailure:
  "capacity"`, counts kept.
- buffer and sink: admission bound of 256 records or 1,000,000 serialised
  bytes; records serialised and redacted before admission; a record above
  64,000 bytes is truncated with a visible marker; the per-run cap stops
  writes and counts the rest. Counters: dropped (rejected before the
  buffer), unflushed (admitted, not confirmed written at freeze),
  truncated; first sink failure in time kept, later loss still counted.
- finalisation: stop input, flush and close within 500 ms on the add-on's
  own clamped timer (never a caller-supplied duration passed to
  `setTimeout`), freeze counters, append the closure record only when every
  admitted record was written and close succeeded, then hand back one
  status object. A late completion after freeze is ignored.
- secrets: argv values, the contents of files a command declares secret and
  environment values matching the declared secret names are collected into a
  redaction set before the first record; records pass LogTape field
  redaction plus exact-value replacement. Coverage named for D15: exact
  value, JSON-escaped form, and values inside nested objects up to the depth
  bound. Not covered: other encodings (base64, URL, hex), fragments,
  free-text paraphrase, and values split across records.

## Seam decision (open)

The kernel at `d1db0d5` has no path from an attached add-on to the envelope:

1. `writer.emit` receives a candidate built by `buildResult` or
   `buildKernelStation`, neither of which carries `diagnostics`; LIFE-7 step
   1 is not implemented, and `TrustedRun` has no diagnostics for LIFE-9
   step 2 (T2 case `F02.diagnostics-in-fallback`).
2. `afterHandler` in `kernel/lifecycle.ts` turns any `settle` that resolves
   `false` into the candidate `owned program survived`, which takes the
   fallback. A diagnostics flush timeout would therefore invoke LIFE-9,
   contrary to DIAG-4 and LIFE-7 (T2 case
   `W06.diagnostics-fault-no-fallback`).
3. The same `settleAll` runs the diagnostics flush concurrently with program
   settling, before the result is frozen, which inverts DIAG-14 steps 1 and
   2.

Each needs `kernel/lifecycle.ts`, which this unit may not edit. Production
code waits for the coordinator's decision.

## Test design

- Real CLI processes of a synthetic host specimen composed with
  `contractFor` and `runProcess`, run against a test-owned `HOME` and
  `XDG_STATE_HOME` tree. A labelled test-only fault fixture composes the same
  add-on with an injected sink fault; it adds no production option.
- An independent reader in the test harness (`lstat`, mode bits, inode,
  listing and byte counts) that does not import the add-on judges custody
  and caps. Domain truth comes from the diagnostics-intact twin and canonical
  comparison, never from a diagnostics record or status.
- Barriers (named files the specimen waits on) instead of sleeps for D04,
  D07, D08 and D10.
- Every case has a valid twin and a named RED perturbation in
  `t5-cases.json`; each RED is shown failing and the restored code passing.
- Platform: Darwin arm64 here; `ubuntu-latest` in hosted CI. A
  platform-bound case fails with an explicit `UNPROVED on this host` reason;
  none is skipped.
