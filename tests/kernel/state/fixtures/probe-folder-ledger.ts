import { mock } from "bun:test";
import * as fs from "node:fs";

const named = process.env.PROBE_FOLDER_LEDGER;
if (named === undefined)
  throw new Error(
    "PROBE_FOLDER_LEDGER names no ledger file. Repair: set it to the file that should list each folder this run makes.",
  );
const ledger: string = named;
const { appendFileSync, mkdirSync, mkdtempSync } = fs;

function recorded<A extends unknown[], R>(
  make: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    const made = make(...args);
    if (typeof made === "string") appendFileSync(ledger, `${made}\n`);
    return made;
  };
}

await mock.module("node:fs", () => ({
  ...fs,
  mkdirSync: recorded(mkdirSync),
  mkdtempSync: recorded(mkdtempSync),
}));
