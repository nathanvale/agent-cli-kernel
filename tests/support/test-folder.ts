import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testFolder(
  prefix: string,
  base = process.env.STATE_TEST_DIR ?? tmpdir(),
): string {
  return realpathSync.native(mkdtempSync(join(base, prefix)));
}
