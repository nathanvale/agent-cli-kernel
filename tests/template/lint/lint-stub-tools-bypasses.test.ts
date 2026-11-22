import { expect, test } from "bun:test";
import { hits } from "../../support/template-lint.ts";

const stubToolBypasses = [
  [
    'import { symlinkSync } from "node:fs";\nsymlinkSync("/bin/sh", "node_modules/.bin/fallow");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    'import { symlink as makeLink } from "node:fs/promises";\nawait makeLink("/usr/bin/env", "node_modules/.bin/tsc");',
    'fs/promises.symlink() links or copies system binary "/usr/bin/env"',
  ],
  [
    'import * as fs from "fs";\nfs["copyFileSync"]("/bin/echo", "node_modules/.bin/tsc");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    'import { linkSync } from "node:fs";\nconst target = `/usr/local/bin/tool`;\nlinkSync(target, "node_modules/.bin/tool");',
    'fs.linkSync() links or copies system binary "/usr/local/bin/tool"',
  ],
  [
    'const { symlinkSync } = require("node:fs");\nsymlinkSync("/sbin/nologin", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/sbin/nologin"',
  ],
  [
    'const { copyFile } = await import("fs/promises");\nawait copyFile("/bin/sh", "bin/tool");',
    'fs/promises.copyFile() links or copies system binary "/bin/sh"',
  ],
  [
    'import fs from "node:fs";\nfs.symlinkSync("/usr/sbin/tool", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/usr/sbin/tool"',
  ],
  [
    'import fs from "node:fs";\nconst { symlinkSync } = fs;\nsymlinkSync("/usr/local/sbin/tool", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/usr/local/sbin/tool"',
  ],
  [
    'import fs from "node:fs";\nawait fs.promises.symlink("/bin/sh", "bin/tool");',
    'fs/promises.symlink() links or copies system binary "/bin/sh"',
  ],
  [
    'import { promises as fsp } from "node:fs";\nawait fsp.link("/bin/sh", "bin/tool");',
    'fs/promises.link() links or copies system binary "/bin/sh"',
  ],
  [
    'const { default: fs } = await import("node:fs");\nfs.symlinkSync("/bin/sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    'import * as fs from "fs";\nfs[`copyFileSync`]("/bin/echo", "bin/tool");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    'import * as fs from "fs";\nconst method = "copyFileSync";\nfs[method]("/bin/echo", "bin/tool");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    'import * as fs from "fs";\nconst { [`symlinkSync`]: s } = fs;\ns("/bin/sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    'const { symlinkSync } = require(`node:fs`);\nsymlinkSync("/bin/" + "sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    'const { copyFile } = await import(`fs/promises`);\nconst dir = "/usr/bin";\nawait copyFile(`${dir}/env`, "bin/tool");',
    'fs/promises.copyFile() links or copies system binary "/usr/bin/env"',
  ],
  [
    'import { symlinkSync } from "node:fs";\nsymlinkSync("//usr/./bin/env", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "//usr/./bin/env"',
  ],
  [
    'import { symlinkSync } from "node:fs";\nsymlinkSync("./fixture.sh", "node_modules/.bin/tool");',
    undefined,
  ],
  [
    'import { symlinkSync } from "node:fs";\n{ const symlinkSync = (src: string, dst: string) => [src, dst]; symlinkSync("/bin/sh", "bin/tool"); }',
    undefined,
  ],
  [
    'import { symlinkSync } from "node:fs";\nconst target = "/bin/sh";\nexport const run = (target: string) => symlinkSync(target, "bin/tool");',
    undefined,
  ],
] as const;

for (const [code, fix] of stubToolBypasses)
  test(`tests-stub-tools ${fix ? "refuses" : "admits"} ${code} and names the fix`, async () => {
    const found = await hits(
      "tests-stub-tools",
      "tests/template/doctor/doctor.test.ts",
      code,
    );
    expect(
      found.map(({ message }) => fix !== undefined && message.includes(fix)),
    ).toEqual(fix ? [true] : []);
  });
