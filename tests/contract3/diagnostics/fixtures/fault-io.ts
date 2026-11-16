// LABELLED TEST-ONLY FAULT ADAPTER for the diagnostics specimen. It wraps the
// production descriptor adapter to reach sink faults the real filesystem
// cannot produce on demand. Selected by DXS_FAULT; never ships.
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { nodeIo } from "../../../../starters/contract3/src/addons/diagnostics/io.ts";
import type { DiagnosticsIo } from "../../../../starters/contract3/src/addons/diagnostics/io.ts";

function waitFor(path: string): void {
  const until = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`Barrier ${path} never opened.`);
    Bun.sleepSync(2);
  }
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

// Faults, comma separated:
//   write-throws        every write rejects (EIO)
//   write-throws-after:N  writes after the first N records reject
//   write-stalls        every write never settles
//   write-stalls-after:N  writes after the first N records never settle
//   write-lies          each write claims one byte more than it was given
//   write-delays:MS     each write lands only after MS milliseconds
//   write-delays-first:MS  only the first write is delayed
//   close-throws        close throws
//   size-throws         fstat at finalisation throws
//   plant-file:BYTES    a regular file with BYTES already at the final name
//   plant-symlink:PATH  a symlink to PATH already at the final name
//   plant-fifo          a FIFO already at the final name
//   open-barrier:READY:GO  before open, create READY and wait for GO
export function faultIo(spec: string): DiagnosticsIo {
  const faults = spec.split(",").filter((entry) => entry.length > 0);
  const has = (name: string) => faults.includes(name);
  const after = (name: string) => {
    const entry = faults.find((item) => item.startsWith(`${name}:`));
    return entry === undefined
      ? undefined
      : Number(entry.slice(name.length + 1));
  };
  const valued = (name: string) =>
    faults.find((item) => item.startsWith(`${name}:`))?.slice(name.length + 1);
  let writes = 0;
  return {
    open(path, flags, mode) {
      const barrier = valued("open-barrier");
      if (barrier !== undefined) {
        const [ready, go] = barrier.split(":");
        if (ready === undefined || go === undefined)
          throw new Error("open-barrier needs READY:GO");
        writeFileSync(ready, "ready");
        waitFor(go);
      }
      const planted = valued("plant-file");
      if (planted !== undefined) writeFileSync(path, planted);
      const target = valued("plant-symlink");
      if (target !== undefined) symlinkSync(target, path);
      if (has("plant-fifo")) {
        const made = Bun.spawnSync(["/usr/bin/mkfifo", path]);
        if (made.exitCode !== 0) throw new Error("mkfifo failed");
      }
      if (has("plant-directory")) mkdirSync(path);
      return nodeIo.open(path, flags, mode);
    },
    write(descriptor, bytes) {
      writes += 1;
      const throwsAfter = after("write-throws-after");
      const stallsAfter = after("write-stalls-after");
      if (
        has("write-throws") ||
        (throwsAfter !== undefined && writes > throwsAfter)
      )
        return Promise.reject(new Error("EIO: injected write fault"));
      if (
        has("write-stalls") ||
        (stallsAfter !== undefined && writes > stallsAfter)
      )
        return never();
      const first = after("write-delays-first");
      const delay =
        first !== undefined && writes === 1 ? first : after("write-delays");
      if (delay !== undefined)
        return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(
          () => nodeIo.write(descriptor, bytes),
        );
      return nodeIo
        .write(descriptor, bytes)
        .then((count) => (has("write-lies") ? count + 1 : count));
    },
    size(descriptor) {
      if (has("size-throws")) throw new Error("EIO: injected fstat fault");
      return nodeIo.size(descriptor);
    },
    close(descriptor) {
      nodeIo.close(descriptor);
      if (has("close-throws")) throw new Error("EIO: injected close fault");
    },
  };
}
