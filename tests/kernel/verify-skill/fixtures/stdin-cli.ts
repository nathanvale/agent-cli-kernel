import { bunSpawn } from "../../../../skills/verify-cli/verify.ts";

const ran = await bunSpawn(process.env)(
  [
    "-e",
    "const seen = require('node:fs').fstatSync(0); process.stdout.write(seen.isFIFO() ? 'pipe' : seen.isCharacterDevice() ? 'device' : 'other');",
  ],
  process.cwd(),
  10_000,
);
process.stdout.write(ran.stdout);
