// The one owner of the add-on's numbers. Each says where it comes from or
// what it bounds; the contract values are DIAG-9 and DIAG-10.
export const limits = {
  // DIAG-9: aggregate per CLI including active logs, per run, and files.
  aggregateBytes: 10_000_000,
  runBytes: 1_000_000,
  files: 50,
  // DIAG-9: the buffer, whichever bound comes first.
  bufferBytes: 1_000_000,
  bufferRecords: 256,
  // DIAG-9 counts queue overhead. A queued record holds an array slot, its
  // byte array and a line object: 64 bytes is a deliberate overestimate of
  // that per-record bookkeeping on a 64-bit runtime.
  recordOverheadBytes: 64,
  // DIAG-9: one record, newline included, with visible truncation.
  recordBytes: 64_000,
  // DIAG-12 over-depth and oversized payloads. Depth and entry counts are
  // not in the contract: 16 levels and 1,000 entries per object or array
  // keep one record's traversal small while every real fact fits.
  depth: 16,
  entries: 1_000,
  // LogTape's field redaction must traverse at least as deep and as wide as
  // the record keeps, so it never silently drops entries the record would
  // have shown (its own defaults are 20 levels and 1,000 entries).
  redactionDepth: 17,
  redactionEntries: 1_000_000,
  // A shortened record keeps its header and marker inside the record bound.
  // The header is under 600 bytes (a 128-byte command identity at most), so
  // 2,048 bytes of room always suffices; each retry keeps 80 per cent.
  shortenedReserveBytes: 2_048,
  shortenedKeepRatio: 0.8,
  // DIAG-14: the normal-shutdown flush bound.
  flushMilliseconds: 500,
  // Finalisation resolves 50 ms before the caller's limit so the kernel's
  // own race of the same limit never pre-empts a finished status; 50 ms is
  // above one event-loop turn on a loaded host.
  flushMarginMilliseconds: 50,
  // DIAG-10: closed logs older than seven days prune first.
  pruneAgeMilliseconds: 7 * 24 * 60 * 60 * 1000,
  // The shared allocation lock (diagnostics only: it orders pruning and
  // file creation, never domain work) is held only for a prune and one
  // exclusive create. Waiting at most 200 ms (in 10 ms retries) keeps
  // allocation well inside the 450 ms flush budget, so a busy lock is
  // disclosed as `capacity`, never mistaken for a flush timeout.
  lockWaitMilliseconds: 200,
  lockRetryMilliseconds: 10,
  // A shared allocation lock owned by another host cannot be liveness
  // checked. A live holder keeps it for milliseconds, so one older than a
  // minute is abandoned. This age rule is for this diagnostics-only lock
  // alone; it is never a REC-7 reclaim of a coordination lock. It compares
  // this host's clock with an mtime stamped by the other host (or its file
  // server), so it assumes the clocks agree within the minute.
  foreignLockStaleMilliseconds: 60_000,
  // DIAG-12a: logger self-reporting stays bounded and in memory.
  metaReports: 8,
  metaReportCharacters: 200,
  // A declared secret file is read whole before the first record so its
  // contents can be redacted. Above 64 KiB, or unreadable, the run's
  // diagnostics stop (DIAG-12: never log a declared secret in clear).
  secretFileBytes: 65_536,
} as const;
