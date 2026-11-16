import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Where test state roots live: STATE_TEST_DIR when set (a run on a chosen
// filesystem, such as the Linux volume run), else the system temporary
// folder.
export function testFolder(prefix: string): string {
  return realpathSync.native(
    mkdtempSync(join(process.env.STATE_TEST_DIR ?? tmpdir(), prefix)),
  );
}
