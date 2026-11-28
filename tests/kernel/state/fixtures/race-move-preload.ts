import { mock } from "bun:test";
import * as fs from "node:fs";

const orig: typeof fs = { ...fs };
const trigger = process.env.SX_RACE_MOVE_TRIGGER ?? "";
const from = process.env.SX_RACE_MOVE_FROM ?? "";
const to = process.env.SX_RACE_MOVE_TO ?? "";
let moved = false;

function openSync(...args: Parameters<typeof fs.openSync>): number {
  const [path] = args;
  if (
    !moved &&
    trigger !== "" &&
    from !== "" &&
    to !== "" &&
    path === trigger
  ) {
    moved = true;
    orig.renameSync(from, to);
  }
  return Reflect.apply(orig.openSync, orig, args);
}

void mock.module("node:fs", () => ({ ...orig, openSync }));
