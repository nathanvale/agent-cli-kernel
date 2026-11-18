import {
  type Document as Fields,
  semanticState,
  fallowPass,
} from "../../../src/static-admission.ts";
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  causeOf,
  fields,
  packet,
  createAdmissionFolder,
  grow,
  evidenceOptions,
} from "../../support/static-admission-in-process-fixture.ts";

const folder = createAdmissionFolder();

function semanticReport(semantic: Fields = {}, identity: Fields = {}): Fields {
  return {
    _meta: {
      type_aware: {
        required_completeness: "complete",
        executed: true,
        candidate_count: 1,
        selected_tsconfigs: ["tsconfig.json"],
        queries: [{ status: "complete" }],
        identity: {
          completeness: "complete",
          project_config_hash: "abc123",
          ...identity,
        },
        ...semantic,
      },
    },
  };
}

function deferredReport(semantic: Fields = {}, identity: Fields = {}): Fields {
  return semanticReport(
    {
      executed: false,
      candidate_count: 0,
      selected_tsconfigs: undefined,
      queries: undefined,
      ...semantic,
    },
    { project_config_hash: "deferred:no-semantic-queries", ...identity },
  );
}

test("semanticState reports a complete semantic run when every query finished", () => {
  expect(semanticState(semanticReport(), "pass")).toBe("complete");
  expect(
    semanticState(
      semanticReport({
        queries: [{ status: "complete" }, { status: "complete" }],
      }),
      "pass",
    ),
  ).toBe("complete");
});

test("semanticState reports an unnecessary semantic run when none was needed", () => {
  expect(semanticState(deferredReport(), "pass")).toBe("unnecessary");
  expect(semanticState(deferredReport({ queries: [] }), "pass")).toBe(
    "unnecessary",
  );
});

test("semanticState names the pass when the semantic evidence is absent", async () => {
  expect(await causeOf(() => semanticState({}, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(await causeOf(() => semanticState({ _meta: {} }, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(await causeOf(() => semanticState({ _meta: 5 }, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ identity: undefined }), "whole"),
    ),
  ).toBe("whole:semantic-identity-missing");
});

test("semanticState refuses a run that was not required or did not complete", async () => {
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport({ required_completeness: "best-effort" }),
        "p",
      ),
    ),
  ).toBe("p:semantic-policy");
  expect(
    await causeOf(() =>
      semanticState(semanticReport({}, { completeness: "partial" }), "p"),
    ),
  ).toBe("p:semantic-incomplete");
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport(
          { required_completeness: "best-effort" },
          { completeness: "partial" },
        ),
        "p",
      ),
    ),
  ).toBe("p:semantic-policy");
});

test("semanticState refuses an unnecessary run that carries evidence of a query", async () => {
  expect(
    await causeOf(() =>
      semanticState(deferredReport({}, { project_config_hash: "abc" }), "p"),
    ),
  ).toBe("p:unnecessary-evidence");
  expect(
    await causeOf(() =>
      semanticState(deferredReport({ candidate_count: 1 }), "p"),
    ),
  ).toBe("p:unnecessary-candidates");
  expect(
    await causeOf(() =>
      semanticState(deferredReport({ queries: [{ status: "complete" }] }), "p"),
    ),
  ).toBe("p:unnecessary-queries");
});

test("semanticState refuses an executed run without projects, queries or complete answers", async () => {
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ executed: undefined }), "p"),
    ),
  ).toBe("p:execution-missing");
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ executed: "true" }), "p"),
    ),
  ).toBe("p:execution-missing");
  for (const projects of [undefined, [], "tsconfig.json"])
    expect(
      await causeOf(() =>
        semanticState(semanticReport({ selected_tsconfigs: projects }), "p"),
      ),
    ).toBe("p:projects-missing");
  for (const queries of [undefined, [], {}])
    expect(
      await causeOf(() => semanticState(semanticReport({ queries }), "p")),
    ).toBe("p:queries-missing");
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport({
          queries: [{ status: "complete" }, { status: "partial" }],
        }),
        "p",
      ),
    ),
  ).toBe("p:query-incomplete");
  expect(
    await causeOf(() => semanticState(semanticReport({ queries: [{}] }), "p")),
  ).toBe("p:query-incomplete");
  expect(
    await causeOf(() => semanticState(semanticReport({ queries: [5] }), "p")),
  ).toBe("p:query");
});

const pinnedFallow = fields(
  fields(JSON.parse(readFileSync(join(packet, "simple/package.json"), "utf8")))
    .devDependencies,
).fallow;

function fallowProject(report: Fields | string, exitCode = 0): string {
  const project = folder();
  grow(project, {
    "report.json": typeof report === "string" ? report : JSON.stringify(report),
    "pass.sh": `cat report.json\nexit ${exitCode}\n`,
  });
  return project;
}

function deadCode(extra: Fields = {}): Fields {
  return {
    kind: "dead-code",
    version: pinnedFallow,
    ...deferredReport(),
    ...extra,
  };
}

test("fallowPass returns the report with its exit code and semantic state", async () => {
  const project = fallowProject(deadCode());
  const options = evidenceOptions(project);
  const result = await fallowPass(options, "whole", "/bin/sh pass.sh");
  expect(result).toEqual({
    name: "whole",
    exitCode: 0,
    report: deadCode(),
    semantic: "unnecessary",
  });
  expect(existsSync(join(options.evidence, "whole.json"))).toBe(true);
});

test("fallowPass reports findings through the exit code instead of refusing", async () => {
  const project = fallowProject(deadCode({ unused_files: [{}] }), 1);
  const result = await fallowPass(
    evidenceOptions(project),
    "production",
    "/bin/sh pass.sh",
  );
  expect(result).toMatchObject({
    name: "production",
    exitCode: 1,
    semantic: "unnecessary",
  });
});

test("fallowPass reports a complete semantic run", async () => {
  const project = fallowProject({
    kind: "dead-code",
    version: pinnedFallow,
    ...semanticReport(),
  });
  const result = await fallowPass(
    evidenceOptions(project),
    "whole",
    "/bin/sh pass.sh",
  );
  expect(result.semantic).toBe("complete");
});

test("fallowPass refuses a command that is not text", async () => {
  const options = evidenceOptions(folder());
  for (const command of [undefined, 5, null, ["fallow"]])
    expect(await causeOf(() => fallowPass(options, "whole", command))).toBe(
      "whole:command",
    );
  expect(existsSync(join(options.evidence, "whole.json"))).toBe(false);
});

test("fallowPass refuses output that is not a JSON document", async () => {
  for (const output of ["plain", "[]"]) {
    const options = evidenceOptions(fallowProject(output));
    expect(
      await causeOf(() => fallowPass(options, "whole", "/bin/sh pass.sh")),
    ).toBe(output === "plain" ? "whole:non-json" : "whole:non-object");
  }
});

test("fallowPass names a native error and refuses an error report that exited zero", async () => {
  const native = fallowProject({ error: true, message: "boom" }, 2);
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(native), "whole", "/bin/sh pass.sh"),
    ),
  ).toBe("whole:native-error");
  const silent = fallowProject({ error: true, message: "boom" }, 0);
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(silent), "whole", "/bin/sh pass.sh"),
    ),
  ).toBe("whole:invalid-error-exit");
});

test("fallowPass refuses a report of another kind or another fallow version", async () => {
  for (const extra of [
    { kind: "health" },
    { version: "0.0.0" },
    { kind: undefined },
    { version: undefined },
  ]) {
    const options = evidenceOptions(fallowProject(deadCode(extra)));
    expect(
      await causeOf(() => fallowPass(options, "whole", "/bin/sh pass.sh")),
    ).toBe("whole:identity");
  }
});

test("fallowPass refuses a report whose semantic evidence fails, naming the pass", async () => {
  const project = fallowProject(
    deadCode(semanticReport({ required_completeness: "best-effort" })),
  );
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(project), "production", "/bin/sh pass.sh"),
    ),
  ).toBe("production:semantic-policy");
});
