import { constants, fstatSync, openSync, readSync } from "node:fs";
import type { LogRecord } from "@logtape/logtape";
import type {
  AttachedAddon,
  Diagnostics,
  DiagnosticsCapability,
  DiagnosticsLevel,
  JsonValue,
  RunAddon,
  RunControl,
} from "../../kernel/index.ts";
import {
  allocate,
  closeIfPossible,
  confirmClosed,
  locate,
  prepare,
} from "./custody.ts";
import type { Opened } from "./custody.ts";
import type { DiagnosticsIo } from "./io.ts";
import { limits } from "./limits.ts";
import { lineMaker, pipelineFor } from "./records.ts";
import type { Line, RunPipeline } from "./records.ts";

type Available = Extract<Diagnostics, { readonly status: "available" }>;
type SinkFailure = NonNullable<Available["sinkFailure"]>;
type Trusted = Extract<
  Diagnostics,
  { readonly status: "unavailable" }
>["trusted"];

// Interface: Which invocation inputs are secret (DIAG-12). Option names take the next
// token or `--name=value`; file options name a file whose contents are
// secret; environment names are variables whose values are secret.
export type SecretSources = {
  readonly options?: readonly string[];
  readonly fileOptions?: readonly string[];
  readonly environment?: readonly string[];
};
export type DiagnosticsOptions = {
  readonly cli: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  readonly secrets?: SecretSources;
};

export type StatusAttached = AttachedAddon<DiagnosticsCapability> & {
  // Interface: Once, after the result is frozen: stop input, flush and close within the
  // limit, then resolve the frozen status. It never rejects.
  readonly freeze: (limitMilliseconds: number) => Promise<Diagnostics>;
};
export type StatusAddon = {
  readonly reportsStatus: true;
  readonly attach: (run: RunControl) => StatusAttached;
};

const listedLevels: Readonly<Record<DiagnosticsLevel, true>> = {
  trace: true,
  debug: true,
  info: true,
  warning: true,
  error: true,
  fatal: true,
};

function optionValues(
  argv: readonly string[],
  names: readonly string[],
): string[] {
  const values: string[] = [];
  argv.forEach((token, index) => {
    for (const name of names) {
      const next = argv[index + 1];
      if (token === name && next !== undefined) values.push(next);
      else if (token.startsWith(`${name}=`))
        values.push(token.slice(name.length + 1));
    }
  });
  return values;
}

function fileSecret(path: string): string[] | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > limits.secretFileBytes) return undefined;
    const buffer = new Uint8Array(info.size);
    let filled = 0;
    while (filled < info.size) {
      const read = readSync(
        descriptor,
        buffer,
        filled,
        info.size - filled,
        filled,
      );
      if (read <= 0) return undefined;
      filled += read;
    }
    const text = new TextDecoder().decode(buffer);
    return [text, text.trim()];
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeIfPossible(descriptor);
  }
}

function secretValues(options: DiagnosticsOptions): string[] | undefined {
  const argv = options.argv ?? [];
  const sources = options.secrets ?? {};
  const files = optionValues(argv, sources.fileOptions ?? []).map(fileSecret);
  if (files.some((contents) => contents === undefined)) return undefined;
  return [
    ...optionValues(argv, sources.options ?? []),
    ...files.flatMap((contents) => contents ?? []),
    ...(sources.environment ?? []).flatMap((name) => {
      const value = options.environment[name];
      return value === undefined ? [] : [value];
    }),
  ].filter((value) => value.length > 0);
}

function budgetFor(milliseconds: number): number {
  return Number.isFinite(milliseconds)
    ? Math.min(
        Math.max(0, milliseconds - limits.flushMarginMilliseconds),
        limits.flushMilliseconds - limits.flushMarginMilliseconds,
      )
    : limits.flushMilliseconds - limits.flushMarginMilliseconds;
}

async function race(work: Promise<void>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function session(
  options: DiagnosticsOptions,
  io: DiagnosticsIo,
  run: RunControl,
): StatusAttached {
  const started = performance.now();
  let sequence = 0;
  let handed = 0;
  let arrived = 0;
  let dropped = 0;
  let admitted = 0;
  let written = 0;
  let truncated = 0;
  let writtenBytes = 0;
  let reservedBytes = 0;
  let full = false;
  let failure: SinkFailure | null = null;
  let inputClosed = false;
  let frozen = false;
  let state: "idle" | "pending" | "open" | "failed" = "idle";
  let accounting: "ok" | "invalid" | "unavailable" = "ok";
  let opened: Opened | undefined;
  let closed = false;
  let pipeline: RunPipeline | undefined;
  let setup: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let freezing: Promise<Diagnostics> | undefined;
  const queue: Line[] = [];
  let queuedBytes = 0;
  let selfReports = 0;

  function fail(kind: SinkFailure) {
    failure ??= kind;
  }

  function admit(line: Line) {
    const charge = line.bytes.length + limits.recordOverheadBytes;
    if (inputClosed || state === "failed" || full) dropped += 1;
    else if (
      queue.length >= limits.bufferRecords ||
      queuedBytes + charge > limits.bufferBytes
    )
      dropped += 1;
    else if (reservedBytes + line.bytes.length > limits.runBytes) {
      full = true;
      fail("capacity");
      dropped += 1;
    } else {
      queue.push(line);
      queuedBytes += charge;
      reservedBytes += line.bytes.length;
      admitted += 1;
      if (line.truncated) truncated += 1;
      pump();
    }
  }

  async function writeHead(descriptor: number, line: Line) {
    let offset = 0;
    while (offset < line.bytes.length) {
      const remaining = line.bytes.length - offset;
      const accepted = await io.write(descriptor, line.bytes.subarray(offset));
      if (!Number.isSafeInteger(accepted) || accepted <= 0)
        throw new Error("The file descriptor accepted no bytes.");
      if (accepted > remaining) accounting = "invalid";
      writtenBytes += accepted;
      offset += accepted;
    }
  }

  async function drainQueue(descriptor: number) {
    try {
      for (let head = queue[0]; head && !frozen; head = queue[0]) {
        await writeHead(descriptor, head);
        queue.shift();
        queuedBytes -= head.bytes.length + limits.recordOverheadBytes;
        written += 1;
      }
    } catch {
      fail("write");
      state = "failed";
    }
  }

  function pump() {
    if (pumping || state !== "open" || !opened || frozen || !queue.length)
      return;
    pumping = drainQueue(opened.descriptor).finally(() => {
      pumping = undefined;
    });
  }

  async function prepareSink() {
    const directory = locate(options.environment, options.cli);
    const place = directory === undefined ? undefined : prepare(directory);
    if (!place) {
      fail("setup");
      state = "failed";
      return;
    }
    const result = await allocate(place, run.runId, io, () => frozen);
    if (typeof result === "string") {
      if (result !== "abandoned") fail(result);
      state = "failed";
      return;
    }
    opened = result;
    state = "open";
    pump();
  }

  function pipelineWith(secrets: readonly string[]): RunPipeline | undefined {
    try {
      const make = lineMaker(secrets);
      const sink = (record: LogRecord) => {
        arrived += 1;
        try {
          admit(make(record));
        } catch {
          dropped += 1;
        }
      };
      return pipelineFor([options.cli, "diagnostics"], sink, () => {
        selfReports += 1;
      });
    } catch {
      return undefined;
    }
  }

  function begin() {
    if (state !== "idle") return;
    state = "pending";
    const secrets = secretValues(options);
    pipeline = secrets === undefined ? undefined : pipelineWith(secrets);
    if (!pipeline) {
      fail("setup");
      state = "failed";
      return;
    }
    setup = prepareSink();
  }

  function record(
    event: string,
    facts: JsonValue,
    level: DiagnosticsLevel = "info",
  ) {
    if (frozen) return;
    sequence += 1;
    if (
      inputClosed ||
      run.signal.aborted ||
      !Object.hasOwn(listedLevels, level)
    ) {
      dropped += 1;
      return;
    }
    begin();
    if (!pipeline) {
      dropped += 1;
      return;
    }
    handed += 1;
    pipeline(level, {
      runId: run.runId,
      commandIdentity: run.commandIdentity,
      event,
      facts,
      seq: sequence,
      elapsedMilliseconds: Math.round(performance.now() - started),
    });
  }

  function checkedSize(descriptor: number): number | undefined {
    let size: number;
    try {
      size = io.size(descriptor);
    } catch {
      accounting = "unavailable";
      return undefined;
    }
    if (size !== writtenBytes && accounting === "ok") accounting = "invalid";
    return accounting === "ok" ? size : undefined;
  }

  function closeSink() {
    if (!opened) return;
    const size = checkedSize(opened.descriptor);
    try {
      io.close(opened.descriptor);
      closed = true;
    } catch {
      fail("close");
    }
    if (closed && size !== undefined) confirmClosed(opened, size);
  }

  async function finishWork() {
    if (setup) await setup;
    while (state === "open" && queue.length > 0 && !frozen) {
      pump();
      await pumping;
    }
    if (!frozen) closeSink();
  }

  function finish(limitMilliseconds: number) {
    inputClosed = true;
    finishing ??= finishWork();
    return race(finishing, budgetFor(limitMilliseconds));
  }

  function facts(complete: boolean): Available {
    return {
      status: "available",
      file: opened?.file ?? null,
      sinkFailure: failure,
      droppedRecords: dropped + Math.max(0, handed - arrived),
      unflushedRecords: queue.length,
      truncatedRecords: truncated,
      countsComplete: complete,
      closed,
    };
  }

  function build(): Diagnostics {
    const available = facts(selfReports === 0);
    const consistent =
      [
        available.droppedRecords,
        available.unflushedRecords,
        available.truncatedRecords,
        admitted,
        written,
      ].every(counter) &&
      admitted === written + queue.length &&
      truncated <= admitted &&
      arrived <= handed;
    if (accounting === "ok" && consistent) return available;
    const base: Trusted = {
      file: available.file,
      sinkFailure: failure,
      closed,
      countsComplete: false,
    };
    const trusted: Trusted = consistent
      ? {
          ...base,
          droppedRecords: available.droppedRecords,
          truncatedRecords: available.truncatedRecords,
        }
      : base;
    return {
      status: "unavailable",
      reason:
        accounting === "unavailable" ? "status-unavailable" : "status-invalid",
      trusted,
    };
  }

  async function freezeOnce(limitMilliseconds: number) {
    const done = await finish(limitMilliseconds);
    frozen = true;
    if (!done) fail("flush-timeout");
    return build();
  }

  return {
    capability: Object.freeze({ record }),
    freeze(limitMilliseconds) {
      freezing ??= freezeOnce(limitMilliseconds).catch(
        (): Diagnostics => ({
          status: "unavailable",
          reason: "status-unavailable",
          trusted: { file: opened?.file ?? null },
        }),
      );
      return freezing;
    },
    async settle(limitMilliseconds) {
      await finish(limitMilliseconds ?? limits.flushMilliseconds);
      return true;
    },
    killNow() {
      inputClosed = true;
      frozen = true;
    },
  };
}

export function createDiagnostics(
  options: DiagnosticsOptions,
  io: DiagnosticsIo,
): StatusAddon {
  const addon: StatusAddon = {
    reportsStatus: true,
    attach: (run) => session(options, io, run),
  };
  const seam: RunAddon<DiagnosticsCapability> = addon;
  void seam;
  return addon;
}
