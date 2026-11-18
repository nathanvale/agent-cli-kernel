import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertCompilerDocument,
  assertPacketPolicy,
  EXPECTED_FILES,
} from "../../support/static-admission-policy.ts";
import {
  createProjectFixture,
  readJson,
  ROOT,
  runAdmission,
  runNative,
} from "../../support/static-admission-project.ts";

const createProject = createProjectFixture();

test.each([
  ["no argument", [], "usage"],
  [
    "a CLI starter other than simple or complex",
    [".", "durable", "evidence"],
    "usage:profile",
  ],
])(
  "admission given %s refuses with the usage line as its detail",
  async (_given, args, cause) => {
    const invocation = await runNative(ROOT, process.execPath, [
      "run",
      "src/static-admission.ts",
      ...args,
    ]);

    expect({
      exitCode: invocation.exitCode,
      result: JSON.parse(invocation.stdout) as unknown,
    }).toEqual({
      exitCode: 1,
      result: {
        status: "refused",
        cause,
        detail:
          "Usage: bun run admit:static <repository> <simple|complex> <evidence folder>",
      },
    });
  },
  120_000,
);

test("admits simple and threshold-met complex projects through native gates", async () => {
  for (const profile of ["simple", "complex"] as const) {
    const root = await createProject(profile);
    await assertPacketPolicy(root, profile);
    const observed = await runAdmission(root, profile);
    expect(observed.result, JSON.stringify(observed.result)).toMatchObject({
      status: "admitted",
    });
    expect(observed.invocation.exitCode).toBe(0);
    expect(observed.invocation.stderr).toBe("");
    expect(observed.result.authoredFiles).toEqual(EXPECTED_FILES[profile]);
    expect(observed.result.wholeSemantic).toBe("unnecessary");
    expect(observed.result.productionSemantic).toBe("unnecessary");
    const showConfig = await readJson(
      join(observed.evidence, "compiler-config.json"),
    );
    assertCompilerDocument(
      root,
      profile,
      JSON.parse(String(showConfig.stdout)) as Record<string, unknown>,
    );
  }
}, 120_000);
