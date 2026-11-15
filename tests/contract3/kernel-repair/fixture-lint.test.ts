import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  lintTree,
  materialise,
  materialisedFixtures,
  typecheckTree,
} from "./harness.ts";

// N3 / SF-1: the state fixtures run from a materialised tree, so they are
// linted and type-checked there with the contract3 configuration, as the
// approval suite does. Not a frozen case identity: a standards control.
let root = "";
beforeAll(async () => {
  root = await materialise();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("materialised kernel-repair fixtures pass contract3 lint", async () => {
  const linted = await lintTree(root);
  expect({ exit: linted.exit, stderr: linted.stderr }).toEqual({
    exit: 0,
    stderr: "",
  });
  for (const file of materialisedFixtures)
    expect(linted.files).toContainEqual({ file, messages: 0, rules: [] });
}, 120_000);

test("materialised kernel-repair fixtures type-check", async () => {
  expect(await typecheckTree(root)).toEqual({
    stdout: "",
    stderr: "",
    exit: 0,
  });
}, 120_000);
