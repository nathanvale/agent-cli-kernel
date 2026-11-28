import { mock } from "bun:test";
import * as fs from "node:fs";

const orig: typeof fs = { ...fs };
const mode = process.env.SX_SWAP_MODE ?? "";
const trigger = process.env.SX_SWAP_TRIGGER ?? "";
const folder = process.env.SX_SWAP_FOLDER ?? "";
const outside = process.env.SX_SWAP_OUTSIDE ?? "";
let swapped = false;

function swapFolder(): void {
  orig.renameSync(folder, outside);
  orig.symlinkSync(outside, folder);
}

function swapAfterOpen(): void {
  const bytes = orig.readFileSync(trigger);
  orig.renameSync(trigger, outside);
  orig.writeFileSync(trigger, bytes, { mode: 0o600 });
}

function shouldSwap(path: Parameters<typeof fs.openSync>[0]): boolean {
  return !swapped && trigger !== "" && outside !== "" && path === trigger;
}

function openSync(...args: Parameters<typeof fs.openSync>): number {
  if (!shouldSwap(args[0])) return Reflect.apply(orig.openSync, orig, args);
  swapped = true;
  if (mode === "before-open" && folder !== "") {
    swapFolder();
    return Reflect.apply(orig.openSync, orig, args);
  }
  const descriptor: number = Reflect.apply(orig.openSync, orig, args);
  if (mode === "after-open") swapAfterOpen();
  else if (mode === "after-open-folder" && folder !== "") swapFolder();
  return descriptor;
}

void mock.module("node:fs", () => ({ ...orig, openSync }));
