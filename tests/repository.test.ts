import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRepository } from "../scripts/repository.ts";
import { testFolder } from "./support/test-folder.ts";

const valid = {
  web: "https://github.com/owner/fixture",
  checkCommitsSince: "0123456789abcdef0123456789abcdef01234567",
  testAreas: [{ name: "template", folder: "tests", holds: "files" }],
};

function refusalFor(description: object | undefined): string {
  const root = testFolder("repository-");
  try {
    if (description !== undefined)
      writeFileSync(join(root, "repository.json"), JSON.stringify(description));
    readRepository(root);
    return "no refusal";
  } catch (error) {
    return String(error).replaceAll(root, "<root>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a valid description is read without a refusal", () => {
  expect(refusalFor(valid)).toBe("no refusal");
});

test.each([
  [
    "an unknown key",
    { ...valid, owner: "fixture" },
    'Error: repository.json: the file has key "owner". Use only: web, checkCommitsSince, testAreas, citableOrigins, recordedOrigin.',
  ],
  [
    "a missing key",
    { web: valid.web, testAreas: valid.testAreas },
    'Error: repository.json: the file needs key "checkCommitsSince".',
  ],
  [
    "a commit that is not a full SHA",
    { ...valid, checkCommitsSince: "0123456" },
    'Error: repository.json: checkCommitsSince is "0123456", which does not match /^[0-9a-f]{40}$/.',
  ],
  [
    "a web address that is not a GitHub repository page",
    { ...valid, web: "http://github.com/owner/fixture" },
    'Error: repository.json: web is "http://github.com/owner/fixture", which does not match /^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+$/.',
  ],
  [
    "a missing file",
    undefined,
    "Error: repository.json is missing at <root>. Each repository that runs these gates describes itself there: copy the template's and set its web address and test areas.",
  ],
])("%s is refused with its exact message", (_case, description, expected) => {
  expect(refusalFor(description)).toBe(expected);
});
