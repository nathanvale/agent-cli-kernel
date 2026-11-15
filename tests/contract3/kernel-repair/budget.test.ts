import { expect } from "bun:test";
import { resolve } from "node:path";
import { envelope, envelopeContract } from "./envelope-fixture.ts";
import { runFamily } from "./harness.ts";

// Harness watchdog, not a contract number: a validation that has not answered
// twice within it counts as unbounded work (R08).
const watchdogMilliseconds = 10000;
const fixture = resolve(import.meta.dir, "envelope-fixture.ts");

async function dagAnswers(levels: number) {
  const source = `
const { envelope, envelopeContract } = await import(${JSON.stringify(fixture)});
let shared = null;
for (let level = 0; level < ${levels}; level++) shared = { a: shared, b: shared };
const contract = envelopeContract();
const answers = [];
for (let round = 0; round < 2; round++)
  answers.push((await contract.validate(envelope(shared))).ok);
process.stdout.write(JSON.stringify(answers));
`;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, watchdogMilliseconds);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { timedOut, stderr, answers: timedOut ? [] : stdout };
}
async function bounded(levels: number) {
  const observed = await dagAnswers(levels);
  expect(observed.timedOut).toBe(false);
  expect(observed.stderr).toBe("");
  const answers: unknown = JSON.parse(String(observed.answers));
  expect(Array.isArray(answers) && answers.length === 2).toBe(true);
  if (Array.isArray(answers)) expect(answers[1]).toBe(answers[0]);
}
function nest(levels: number): unknown {
  let value: unknown = null;
  for (let level = 0; level < levels; level++) value = { a: value };
  return value;
}

runFamily(
  "R08",
  {
    "R08.dag-20": () => bounded(20),
    "R08.dag-35": () => bounded(35),
    "R08.dag-64": () => bounded(64),
    "R08.tree-twin-and-guards": async () => {
      const contract = envelopeContract();
      // envelope (1) > result (2) > data (3): 61 data levels put the deepest
      // value at nesting level 64 even counting the envelope as level 1.
      expect((await contract.validate(envelope(nest(61)))).ok).toBe(true);
      expect((await contract.validate(envelope(nest(64)))).ok).toBe(false);
      const cycle: Record<string, unknown> = { a: null };
      cycle.a = { back: cycle };
      expect((await contract.validate(envelope(cycle))).ok).toBe(false);
    },
  },
  watchdogMilliseconds * 2,
);
