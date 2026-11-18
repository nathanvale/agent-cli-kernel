import {
  type Receipt,
  nativeEnvironment,
  execute,
  parseOptions,
  parseReceipt,
  successful,
} from "../src/static-admission.ts";
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  causeOf,
  createAdmissionFolder,
  evidenceOptions,
  stubTool,
  stubChildMilliseconds,
  fields,
} from "./support/static-admission-in-process-fixture.ts";

const folder = createAdmissionFolder();

function receipt(stdout: string): Receipt {
  return {
    name: "probe",
    argv: ["probe"],
    cwd: "/",
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

test("nativeEnvironment refuses each fallow variable that changes the pinned run", async () => {
  for (const name of [
    "FALLOW_PRODUCTION",
    "FALLOW_PRODUCTION_DEAD_CODE",
    "FALLOW_CHANGED_SINCE",
    "FALLOW_DIFF_FILE",
    "FALLOW_ROOT",
    "FALLOW_EXTRA_ARGS",
    "FALLOW_MAX_FILE_SIZE",
  ])
    expect(await causeOf(() => nativeEnvironment({ [name]: "1" }))).toBe(
      `environment:${name}`,
    );
});

test("nativeEnvironment forces plain output, keeps the rest and leaves its input alone", () => {
  const input = {
    FALLOW_PRODUCTION: "",
    FORCE_COLOR: "3",
    NO_COLOR: undefined,
    KEPT: "yes",
  };
  expect(nativeEnvironment(input)).toEqual({
    FALLOW_PRODUCTION: "",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    KEPT: "yes",
  });
  expect(input.FORCE_COLOR).toBe("3");
});

test("execute records the command, its folder, exit code and both streams", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const argv = ["/bin/sh", "-c", "printf out; printf err >&2; exit 3"];
  const result = await execute(options, "probe", argv);
  expect(result).toEqual({
    name: "probe",
    argv,
    cwd: project,
    exitCode: 3,
    stdout: "out",
    stderr: "err",
  });
  expect(readFileSync(join(options.evidence, "probe.json"), "utf8")).toBe(
    JSON.stringify(result, null, 2) + "\n",
  );
});

test("execute runs in the project folder with plain colour settings and the given environment", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const result = await execute(options, "env", [
    "/bin/sh",
    "-c",
    'pwd; printf "%s%s%s" "$NO_COLOR" "$FORCE_COLOR" "$MARKER"',
  ]);
  expect(result.stdout).toBe(`${project}\n10`);
  const marked = parseOptions([project, "simple", options.evidence], {
    MARKER: "m",
  });
  const second = await execute(marked, "marker", [
    "/bin/sh",
    "-c",
    'printf "%s" "$MARKER"',
  ]);
  expect(second.stdout).toBe("m");
});

test("execute kills a command that outlives its time limit and refuses with the timeout cause", async () => {
  const project = folder();
  const options = evidenceOptions(project, 300);
  stubTool(project, "stall", "sleep 30");
  const started = Date.now();
  expect(
    await causeOf(() =>
      execute(options, "stall", [join(project, "node_modules/.bin/stall")]),
    ),
  ).toBe("stall:timeout");
  expect(Date.now() - started).toBeLessThan(stubChildMilliseconds);
  expect(existsSync(join(options.evidence, "stall.json"))).toBe(true);
});

test("execute gives the command no standard input", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const result = await execute(options, "stdin", [
    "/bin/sh",
    "-c",
    "cat; printf done",
  ]);
  expect(result.stdout).toBe("done");
});

test("execute refuses a forbidden fallow variable before it starts the command", async () => {
  const project = folder();
  const options = parseOptions([project, "simple", join(project, "e")], {
    FALLOW_ROOT: "/",
  });
  expect(await causeOf(() => execute(options, "probe", ["/bin/true"]))).toBe(
    "environment:FALLOW_ROOT",
  );
  expect(existsSync(join(project, "e"))).toBe(false);
});

test("parseReceipt returns the document a command printed", () => {
  expect(parseReceipt(receipt('{"a":1}'))).toEqual({ a: 1 });
});

test("parseReceipt names the command when its output is not JSON or not a document", async () => {
  expect(await causeOf(() => parseReceipt(receipt("plain text")))).toBe(
    "probe:non-json",
  );
  expect(await causeOf(() => parseReceipt(receipt("")))).toBe("probe:non-json");
  for (const stdout of ["[]", "5", "null", '"text"'])
    expect(await causeOf(() => parseReceipt(receipt(stdout)))).toBe(
      "probe:non-object",
    );
});

test("successful returns the receipt of a command that exits zero", async () => {
  const options = evidenceOptions(folder());
  const result = await successful(options, "good", [
    "/bin/sh",
    "-c",
    "printf fine",
  ]);
  expect(result).toMatchObject({ name: "good", exitCode: 0, stdout: "fine" });
});

test("successful refuses a failing command and still records its receipt", async () => {
  const options = evidenceOptions(folder());
  expect(
    await causeOf(() =>
      successful(options, "bad", ["/bin/sh", "-c", "printf why >&2; exit 2"]),
    ),
  ).toBe("bad:exit");
  expect(
    fields(
      JSON.parse(readFileSync(join(options.evidence, "bad.json"), "utf8")),
    ),
  ).toMatchObject({ exitCode: 2, stderr: "why" });
});
