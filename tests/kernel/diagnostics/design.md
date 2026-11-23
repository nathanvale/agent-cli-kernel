# T5 diagnostics add-on: design note

Frozen 16 November 2026 before production code; the section "Seam decision"
was completed by the foundation coordinator's ruling the same day. Case identities are
in `t5-cases.json` beside this note and do not change after this commit.

Authority: accepted contract manifest
`c162c9850ca506fd839ce36b2b1a8172f064516b0f229dd34a5678b366b02b9d`
(DIAG-1 to DIAG-17, CMD-16, CMD-17, LIFE-7, LIFE-9, DISC-6, V-24); oracle
`tests/contract3/expectations.json` in the `agent-engineering` repository at
published commit `83ac9b4186841c89914281c097ed524fd62a5919` (frozen as
`719c89e0cd9e35629d6fb3ee918ed729166b7b57`, mapped by
`references/contract-3/redaction-2026-11-16.md`; SHA-256
`16e02a3ea6ba1420b1d6e47bfb6cd1327758bca161d8ddd1d818f60f544460e4`); T5
test-design brief (SHA-256
`257f4d8a6cc32e57160c3b08fd1ccc86e14c1c28abacfca5592d05013c3d274f`) and its
foundation coordinator review. Expected values come from those sources, never from the
add-on.

## Accepted decisions and provisional readings

- Trigger (foundation coordinator review note 1): diagnostics are triggered when the
  add-on is installed (`installedAddons` lists `diagnostics` and
  `runProcess` receives `addons.diagnostics`) and the command at handler entry
  declares `capabilities.diagnostics`. No global switch, command option or
  environment toggle exists. A run that never reached handler entry for a declaring command
  (routing refusal, usage refusal, deadline before start) is not triggered
  and carries no key.
- Location: `$XDG_STATE_HOME/my-agent-dojo/<cli>/diagnostics` when
  `XDG_STATE_HOME` is an absolute path, otherwise
  `$HOME/.local/state/my-agent-dojo/<cli>/diagnostics`. Nothing else moves
  it. See "Corrections, 24 November 2026" for the `my-agent-dojo` level.
- Raw program stream retention stays disabled. No destination other than the
  one private file.
- Dependencies: `@logtape/logtape` and `@logtape/redaction` at exactly
  `2.4.2`, imported only under `addons/diagnostics/**`. LogTape supplies the
  logger, categories, explicit context (`withContext` over an
  `AsyncLocalStorage`) and field redaction; the add-on's own sink owns the
  descriptor. LogTape's path-opening file sink is not used (DIAG-8).

## Module (`kernel/src/addons/diagnostics/`)

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
- allocation: under the allocation lock (exclusively created lock file in
  the directory, holder pid inside, stale only when that pid is not alive),
  remove old logs and reserve. Confirmed-closed logs are those whose last line is the
  add-on's closure record; anything else is ambiguous and never removed.
  Each non-closed log is charged at `max(size, 1,000,000)` so concurrent
  growth cannot pass the aggregate cap. Remove closed logs whose mtime is
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

## Seam decision

Ruled 16 November 2026 by the foundation coordinator: Option A. The kernel
owner (`c3-t2-lifecycle`) adds a status seam in its own labelled commit; this
unit never edits the kernel. The add-on side follows the interface note
`seam-interface-needs.md` in the evidence owner: a status-reporting
`RunAddon` (`reportsStatus: true`) is attached, effect-free, when its
declaring command reaches handler entry, and its `AttachedAddon.freeze(limit)` is
called once after the result is frozen; the kernel validates the value alone.
Results refused before handler entry carry no key: Nathan's accepted decision of 16 November
2026, 14:19 (no `diagnostics` key on a result refused before handler entry).

The gap as found at `d1db0d5`, kept for the record:

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

Each needs `kernel/lifecycle.ts`, which this unit may not edit.

## Test design

- Real CLI processes of a synthetic host specimen built with
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
- Platform: Darwin arm64 here; `ubuntu-latest` in Hosted check. A
  platform-bound case fails with an explicit `UNPROVED on this host` reason;
  none is skipped.

## Corrections, 16 November 2026 (repair round 1)

The sections above were frozen before code. Where the built add-on differs,
this section is the record; the case identities do not change.

- Closure is confirmed by a sibling `0700` marker directory named
  `<log>.closed-<device>-<inode>-<size>`, created after a successful close
  with the file's identity unchanged, not by a closure record line.
- The allocation lock is a populated directory (`.allocation-lock` holding
  one `owner-<pid>-<host hash>` file) moved onto the path by rename, not a
  lock file. Its owner is proven gone when its pid is dead on this host, or,
  for another host, when the lock is older than one minute. The lock wait is
  at most 200 ms, inside the flush budget; a lock still held is disclosed as
  `capacity`.
- Secrets: exact values and their JSON-escaped forms are concealed in every
  string and key of the event and facts before any cut. The header (time,
  sequence, run and command identities, elapsed time, level) holds only
  add-on values and is never concealed, so lines stay valid JSON. LogTape's
  `redactByPattern` second pass over the finished line was removed: it
  rewrote numbers and identities when a secret was short. A declared secret
  file that cannot be read whole (missing, unreadable, not regular, above
  64 KiB) stops diagnostics for the run with `sinkFailure: "setup"`.
- Platform-bound cases: none is skipped. A case this host cannot exercise
  runs as an explicit `UNPROVED` outcome that prints one line, and the case
  ledger pins the list per platform (`platform.ts`).
- Every number has one owner with its source: `addons/diagnostics/limits.ts`.
- Accepted decisions, 16 November 2026: a result refused before handler
  entry carries no `diagnostics` key (14:19), and the host, not the kernel or
  this add-on, owns redaction of public output (14:37); this add-on redacts
  at its own sink only.

## Corrections, 19 November 2026 (in-process runs)

Nathan's decision of 19 November 2026, 13:22 AEDT: the add-on stops changing
LogTape's process-wide configuration and gives each run its own pipeline.

- The add-on no longer calls `configureSync` or `getLogger`. Each run builds
  its own LogTape record and passes it through `redactByField` to that run's
  sink (`pipelineFor` in `records.ts`). Overlapping in-process runs keep their
  log lines apart, and a tool's own LogTape configuration is left as it was
  found.
- LogTape reports its own trouble only to the process-wide meta logger. The
  run now counts its own self reports instead: a redaction that throws (the
  record is dropped) and a redaction limit, read from LogTape's replacement
  of an unmapped message placeholder. Either still makes `countsComplete`
  false. A tool's own LogTape warnings no longer count against a run.
- LogTape's redaction still sends its limit warning to the process-wide meta
  logger, so a tool that routes `["logtape", "meta"]` to its own sink sees
  that warning. It carries the limit's name and size, never record values.
- A `configureSync` refusal (for example, a tool's LogTape configuration
  with async disposables still active) can no longer stop a run's
  diagnostics with `sinkFailure: "setup"`, because the add-on never calls it.
  Setup failure still comes from secret collection and the sink's custody.

## Corrections, 24 November 2026 (my-agent-dojo location)

Nathan's rule of 24 November 2026, 08:52: any folder that code writes under a
per-user base goes under `<base>/my-agent-dojo/<tool>/`.

- The log moves from `<base>/<cli>/diagnostics` to
  `<base>/my-agent-dojo/<cli>/diagnostics`. `<base>` is still
  `$XDG_STATE_HOME` when it is absolute, otherwise `$HOME/.local/state`.
- The `my-agent-dojo` folder gets the checks the `<cli>` folder gets. When it
  is missing, custody creates it at `0700`. When it exists, it must be a real
  directory, not a symlink, owned by the current user, and not group or world
  writable. Other tools may share it, so custody does not require `0700`.
- Logs are disposable. Custody neither reads, moves, nor removes logs in the
  old folder, so a tool's old log folders stay where they were.
