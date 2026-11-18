import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRepository } from "../../../scripts/repository.ts";
import { testFolder } from "../../support/test-folder.ts";

const valid = {
  web: "https://github.com/owner/fixture",
  checkCommitsSince: "0123456789abcdef0123456789abcdef01234567",
  testAreas: [{ name: "template", folder: "tests", holds: "files" }],
};

function refusalFor(file: string | undefined): string {
  const root = testFolder("repository-");
  try {
    if (file !== undefined) writeFileSync(join(root, "repository.json"), file);
    readRepository(root);
    return "no refusal";
  } catch (error) {
    return String(error).replaceAll(root, "<root>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a valid description is read without a refusal", () => {
  expect(refusalFor(JSON.stringify(valid))).toBe("no refusal");
});

test.each([
  [
    "an unknown key",
    { ...valid, owner: "fixture" },
    'Error: repository.json: the file has key "owner". Repair: use only web, checkCommitsSince, testAreas, citableOrigins, recordedOrigin.',
  ],
  [
    "a missing key",
    { web: valid.web, testAreas: valid.testAreas },
    'Error: repository.json: the file needs key "checkCommitsSince". Repair: add that key.',
  ],
  [
    "a commit that is not a full SHA",
    { ...valid, checkCommitsSince: "0123456" },
    'Error: repository.json: checkCommitsSince is "0123456", which does not match /^[0-9a-f]{40}$/. Repair: write a value that pattern matches.',
  ],
  [
    "a web address that is not a GitHub repository page",
    { ...valid, web: "http://github.com/owner/fixture" },
    'Error: repository.json: web is "http://github.com/owner/fixture", which does not match /^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+$/. Repair: write a value that pattern matches.',
  ],
  [
    "a missing file",
    undefined,
    "Error: repository.json is missing at <root>. Each repository that runs these gates describes itself there. Repair: start from the template's repository.json, and set its web address and test areas.",
  ],
])("%s is refused with its exact message", (_case, description, expected) => {
  expect(
    refusalFor(
      description === undefined ? undefined : JSON.stringify(description),
    ),
  ).toBe(expected);
});

test.each(["./tests", "tests/", "tests/../src", "/tests"])(
  'a test area folder written as "%s" is refused, so the area runner and the names check read one spelling',
  (folder) => {
    const area = { name: "template", folder, holds: "files" };
    expect(refusalFor(JSON.stringify({ ...valid, testAreas: [area] }))).toBe(
      `Error: repository.json: testAreas[0].folder is "${folder}", which is not a plain path from the repository root. Repair: write it with no ./ prefix, no trailing slash, and no . or .. part, such as "tests/template".`,
    );
  },
);
