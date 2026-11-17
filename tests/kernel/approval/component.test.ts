import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import {
  ApprovalRejection,
  approval,
  authorityLocation,
  authorityVerifier,
  fileSeparation,
} from "../../../kernel/src/addons/approval/index.ts";
import type {
  AuthoritySource,
  ClosureItem,
  RecordFacts,
  StopItem,
} from "../../../kernel/src/addons/approval/index.ts";
import { contractFor } from "../../../kernel/src/kernel/index.ts";
import {
  adversarialSource,
  authorityRecordPath,
  closureItem,
  closureRecord,
  createWorld,
  expectCase,
  grant,
  grantPath,
  markerName,
  foreignFile,
  observation,
  platformPaths,
  removeAll,
  snapshot,
  stopItem,
  stopRecord,
  unorderedStopItem,
  writeGrant,
} from "./harness.ts";
import type { World } from "./harness.ts";

const boundary = contractFor({ cli: "boundary", commands: [] }).boundary;
let world: World;
beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await chmod(world.grants, 0o700);
  await chmod(world.authority, 0o700);
  await removeAll(world.root);
});

type RequestShape = {
  readonly preview?: string;
  readonly authority?: string;
  readonly resource?: string;
  readonly resourceRevision?: string;
  readonly effects?: readonly string[];
};
function request(change: RequestShape = {}) {
  return {
    authority: boundary.authority(change.authority ?? grant.authority),
    resource: boundary.resource(change.resource ?? grant.resource),
    resourceRevision: change.resourceRevision ?? grant.resourceRevision,
    effects: change.effects ?? grant.effects,
    preview: change.preview ?? grant.preview,
  };
}
function capability(operation: string = grant.operation) {
  return approval({
    operation,
    runId: "component",
    store: { grants: world.grants, consumed: world.consumed },
    now: () => 1000,
  }).capability;
}
async function preflight(
  change: RequestShape = {},
  operation?: string,
): Promise<string> {
  try {
    return (await capability(operation).check(request(change)))
      ? "admitted"
      : "denied";
  } catch (error) {
    return error instanceof ApprovalRejection &&
      error.reason === "store-unavailable" &&
      !error.consumed &&
      error.message === "Approval authority store is unavailable."
      ? "operational-failure"
      : "unexpected-error";
  }
}
async function observed(
  setup: () => Promise<void>,
  act: () => Promise<string>,
) {
  await setup();
  const before = await snapshot(world);
  const outcome = await act();
  return observation(outcome, before, await snapshot(world));
}

test("A01.a-preflight-non-consuming", async () => {
  await writeGrant(world, grant);
  expectCase(
    "A01.a-preflight-non-consuming",
    await observed(async () => {}, preflight),
  );
  expect(await preflight()).toBe("admitted");
});

const denials: readonly (readonly [string, () => Promise<void>])[] = [
  ["A03.a-missing", async () => {}],
  [
    "A03.b-stale-expired",
    () => writeGrant(world, { ...grant, expiresAt: 1000 }),
  ],
  [
    "A03.c-stale-revision",
    () => writeGrant(world, { ...grant, resourceRevision: "r-old" }),
  ],
  [
    "A03.d-consumed",
    async () => {
      await writeGrant(world, grant);
      await writeFile(
        join(world.consumed, markerName(["approval", grant.preview])),
        "prior\n",
      );
    },
  ],
  [
    "A03.e-mismatched",
    () => writeGrant(world, { ...grant, operation: "fixture.other" }),
  ],
];
for (const [id, setup] of denials)
  test(id, async () => {
    await setup();
    const before = await snapshot(world);
    const results = [
      await capability().check(request()),
      await capability().check(request()),
    ];
    expect(results).toEqual([false, false]);
    expectCase(id, observation("denied", before, await snapshot(world)));
    expect(await snapshot(world)).toEqual(before);
  });

test("A03 valid twin of the denial variants passes preflight", async () => {
  await writeGrant(world, grant);
  expect(await preflight()).toBe("admitted");
});

const hostile: readonly (readonly [string, () => Promise<void>])[] = [
  [
    "A04.a-malformed-json",
    () => writeFile(grantPath(world, grant.preview), "{not json"),
  ],
  [
    "A04.b-truncated",
    () =>
      writeFile(
        grantPath(world, grant.preview),
        JSON.stringify(grant).slice(0, -6),
      ),
  ],
  [
    "A04.c-forged-field",
    () => writeGrant(world, { ...grant, grantedBy: "human" }),
  ],
  [
    "A04.d-wrong-type",
    () => writeGrant(world, { ...grant, expiresAt: "5000" }),
  ],
  [
    "A04.e-oversized",
    () =>
      writeFile(
        grantPath(world, grant.preview),
        `${JSON.stringify(grant)}${" ".repeat(17 * 1024)}`,
      ),
  ],
  [
    "A04.f-symlink",
    async () => {
      const target = join(world.root, "elsewhere.json");
      await writeFile(target, JSON.stringify(grant));
      await symlink(target, grantPath(world, grant.preview));
    },
  ],
  [
    "A04.g-non-regular",
    async () => {
      await mkdir(grantPath(world, grant.preview));
      const fifo = grantPath(world, "p-fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      expect(await preflight({ preview: "p-fifo" })).toBe("denied");
    },
  ],
  [
    "A04.i-excess-depth",
    () =>
      writeFile(
        grantPath(world, grant.preview),
        `{"nested":${"[".repeat(2000)}${"]".repeat(2000)}}`,
      ),
  ],
  [
    "A04.j-hard-link",
    async () => {
      const original = join(world.root, "original.json");
      await writeFile(original, JSON.stringify(grant));
      await link(original, grantPath(world, grant.preview));
    },
  ],
  [
    "A04.k-prototype-key",
    () =>
      writeFile(
        grantPath(world, grant.preview),
        `{"__proto__":{"admin":true},${JSON.stringify(grant).slice(1)}`,
      ),
  ],
];
for (const [id, setup] of hostile)
  test(id, async () => {
    expectCase(id, await observed(setup, preflight));
  });

test("A04.h-invalid-utf8", async () => {
  // Platform: The request names U+FFFD, so lossy decoding of the 0xff byte would
  // otherwise turn the invalid bytes into a matching authority.
  const text = JSON.stringify({ ...grant, authority: "owner-?" });
  const bytes = Buffer.from(text, "utf8");
  bytes[bytes.indexOf("?")] = 0xff;
  const outcome = await observed(
    () => writeFile(grantPath(world, grant.preview), bytes),
    () => preflight({ authority: "owner-\uFFFD" }),
  );
  expectCase("A04.h-invalid-utf8", outcome);
});

test("A04.l-traversal-preview", async () => {
  await writeFile(
    join(world.root, "evil.json"),
    JSON.stringify({ ...grant, preview: "../evil" }),
  );
  await writeGrant(world, grant);
  const outcome = await observed(
    async () => {},
    () => preflight({ preview: "../evil" }),
  );
  expectCase("A04.l-traversal-preview", outcome);
  expect(basename(grantPath(world, "../evil"))).toMatch(/^[0-9a-f]{64}\.json$/);
});

test("A04 valid twins pass preflight: bounded size, regular single-link file", async () => {
  await writeFile(
    grantPath(world, grant.preview),
    `${JSON.stringify(grant)}${" ".repeat(1024)}`,
  );
  expect(await preflight()).toBe("admitted");
});

test("A04.m-unreadable", async () => {
  await writeGrant(world, grant);
  const before = await snapshot(world);
  await chmod(grantPath(world, grant.preview), 0o000);
  const fileOutcome = await preflight();
  await chmod(grantPath(world, grant.preview), 0o600);
  await chmod(world.grants, 0o000);
  const directoryOutcome = await preflight();
  await chmod(world.grants, 0o700);
  expect([fileOutcome, directoryOutcome]).toEqual([
    "operational-failure",
    "operational-failure",
  ]);
  expectCase(
    "A04.m-unreadable",
    observation(fileOutcome, before, await snapshot(world)),
  );
});

test("T4S.r7-no-preview-preflight: a request without a preview denies", async () => {
  await writeGrant(world, grant);
  const { preview, ...withoutPreview } = request();
  expect(preview).toBe(grant.preview);
  expect(await capability().check(withoutPreview)).toBe(false);
  expect(await capability().check(request())).toBe(true);
});

test("T4S.r6-operational-cause: a store failure keeps its cause and fixed message", async () => {
  await writeGrant(world, grant);
  await chmod(world.grants, 0o000);
  const failure = await capability()
    .check(request())
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await chmod(world.grants, 0o700);
  expect(failure).toBeInstanceOf(ApprovalRejection);
  expect(failure).toMatchObject({
    reason: "store-unavailable",
    consumed: false,
    message: "Approval authority store is unavailable.",
    cause: { code: "EACCES" },
  });
});

const noSetup = () => Promise.resolve();
const bindings: readonly (readonly [
  string,
  () => Promise<void>,
  () => Promise<string>,
])[] = [
  [
    "A05.a-preview",
    () => writeFile(grantPath(world, "p-2"), JSON.stringify(grant)),
    () => preflight({ preview: "p-2" }),
  ],
  ["A05.b-revision", noSetup, () => preflight({ resourceRevision: "r1" })],
  ["A05.c-authority", noSetup, () => preflight({ authority: "owner-b" })],
  [
    "A05.d-effect-subset",
    () =>
      writeGrant(world, { ...grant, effects: ["note.index", "note.write"] }),
    () => preflight({ effects: ["note.write"] }),
  ],
  [
    "A05.e-effect-superset",
    noSetup,
    () => preflight({ effects: ["note.write", "note.index"] }),
  ],
  ["A05.f-operation", noSetup, () => preflight({}, "fixture.other")],
  ["A05.g-resource", noSetup, () => preflight({ resource: "resource-2" })],
  [
    "A05.h-effect-duplicate",
    noSetup,
    () => preflight({ effects: ["note.write", "note.write"] }),
  ],
];
for (const [id, setup, act] of bindings)
  test(id, async () => {
    await writeGrant(world, grant);
    expectCase(id, await observed(setup, act));
    await writeGrant(world, grant);
    expect(await preflight()).toBe("admitted");
  });

test("A05 effect sets compare as sets, not sequences", async () => {
  await writeGrant(world, { ...grant, effects: ["note.write", "note.index"] });
  expect(await preflight({ effects: ["note.write", "note.index"] })).toBe(
    "admitted",
  );
});

function verifier(
  source: AuthoritySource | "none" = adversarialSource(world.authority),
) {
  const options = {
    runId: "component",
    consumed: world.consumed,
    now: () => 1000,
  };
  return authorityVerifier(
    source === "none" ? options : { ...options, closure: source, stop: source },
  );
}
async function place(
  kind: "closure" | "stop",
  parts: readonly string[],
  record: unknown,
): Promise<void> {
  await writeFile(
    authorityRecordPath(world, kind, parts),
    JSON.stringify(record),
  );
}
function fileSource(directory: string): AuthoritySource {
  return { directory, separated: fileSeparation(directory) };
}

const closureMismatches: readonly (readonly [string, ClosureItem, unknown])[] =
  [
    ["C02.a-operation", { ...closureItem, operation: "op-2" }, closureRecord],
    [
      "C02.b-disposition",
      closureItem,
      { ...closureRecord, disposition: "not-applied" },
    ],
    ["C02.c-evidence", { ...closureItem, evidence: "ev-2" }, closureRecord],
    ["C02.d-scope", { ...closureItem, scope: "resource-2" }, closureRecord],
  ];
for (const [id, item, record] of closureMismatches)
  test(id, async () => {
    await place("closure", [item.operation], record);
    const outcome = await observed(
      async () => {},
      async () => (await verifier().closure.preflight(item)).status,
    );
    expectCase(id, outcome);
  });

test("C02 valid twin verifies without consuming", async () => {
  await place("closure", ["op-1"], closureRecord);
  const outcome = await observed(
    async () => {},
    async () => (await verifier().closure.preflight(closureItem)).status,
  );
  expect(outcome).toEqual({
    outcome: "verified",
    consumeDelta: 0,
    effectDelta: 0,
    grantUnchanged: true,
  });
});

test("T4S.r7-closure-expiry: an expired closure grant refuses", async () => {
  await place("closure", ["op-1"], { ...closureRecord, expiresAt: 1000 });
  expect((await verifier().closure.preflight(closureItem)).status).toBe(
    "refused",
  );
  await place("closure", ["op-1"], { ...closureRecord, expiresAt: 1001 });
  expect((await verifier().closure.preflight(closureItem)).status).toBe(
    "verified",
  );
});

test("T4S.r6-authority-location: records are addressed by their item", () => {
  const source = adversarialSource(world.authority);
  expect(authorityLocation(source, "closure", closureItem)).toBe(
    authorityRecordPath(world, "closure", ["op-1"]),
  );
  expect(authorityLocation(source, "stop", stopItem)).toBe(
    authorityRecordPath(world, "stop", ["op-1", "owner-1"]),
  );
});

const humanHandoff = {
  status: "unavailable",
  handoff: { owner: "human" },
};

test("C03.a-same-user-file", async () => {
  const source = fileSource(world.authority);
  await place("closure", ["op-1"], closureRecord);
  await place("closure", ["op-2"], {
    ...closureRecord,
    operation: "op-2",
    grantedBy: "human",
  });
  const before = await snapshot(world);
  const verdicts = [
    await verifier(source).closure.preflight(closureItem),
    await verifier(source).closure.preflight({
      ...closureItem,
      operation: "op-2",
    }),
  ];
  for (const verdict of verdicts) expect(verdict).toMatchObject(humanHandoff);
  expectCase(
    "C03.a-same-user-file",
    observation("unavailable", before, await snapshot(world)),
  );
});

test("C03.b-caller-created-record", async () => {
  const source = fileSource(world.authority);
  const before = await snapshot(world);
  await place("closure", ["op-1"], closureRecord);
  await chmod(authorityRecordPath(world, "closure", ["op-1"]), 0o444);
  await chmod(world.authority, 0o555);
  const verdict = await verifier(source).closure.preflight(closureItem);
  await chmod(world.authority, 0o700);
  expect(verdict).toMatchObject(humanHandoff);
  expectCase(
    "C03.b-caller-created-record",
    observation(verdict.status, before, await snapshot(world)),
  );
});

const paths = await platformPaths();
function testWhen(
  found: unknown,
  name: string,
  missing: string,
  body: () => Promise<void>,
): void {
  if (found) test(name, body);
  else test.skip(`${name} [UNPROVED on this host: ${missing}]`, body);
}
async function factsOf(path: string, override: Partial<RecordFacts> = {}) {
  const { uid, gid, mode, dev, ino } = await lstat(path);
  return { path, uid, gid, mode, dev, ino, ...override };
}
const noForeignFile = paths.foreignFileMissing;

testWhen(
  paths.foreignFile,
  "T4S.r4-probe-positive-control: a foreign read-only path separates",
  noForeignFile,
  async () => {
    const file = paths.foreignFile ?? "";
    const root = dirname(file);
    const probe = fileSeparation(root);
    expect(await probe()).toBe(true);
    expect(await probe(await factsOf(file))).toBe(true);
    expect(
      (await verifier(fileSource(root)).closure.preflight(closureItem)).status,
    ).toBe("refused");
  },
);

testWhen(
  paths.writableRoot,
  "T4S.r4-foreign-writable-root: a world-writable foreign root never separates",
  "no foreign, world-writable resolved temp root (/tmp or the system temp directory)",
  async () => {
    const root = paths.writableRoot ?? "";
    expect(await fileSeparation(root)()).toBe(false);
    expect(
      await verifier(fileSource(root)).closure.preflight(closureItem),
    ).toMatchObject(humanHandoff);
  },
);

testWhen(
  paths.foreignFile,
  "T4S.r4-caller-owned-record: a caller-owned or writable record in a foreign root never separates",
  noForeignFile,
  async () => {
    const file = paths.foreignFile ?? "";
    const probe = fileSeparation(dirname(file));
    const caller = process.getuid?.() ?? -1;
    expect(await probe(await factsOf(file, { uid: caller }))).toBe(false);
    expect(await probe(await factsOf(file, { mode: 0o100666 }))).toBe(false);
    expect(await probe(await factsOf(file, { ino: 1 }))).toBe(false);
    expect(
      await probe(await factsOf(file, { path: join(sep, basename(file)) })),
    ).toBe(false);
  },
);

testWhen(
  paths.foreignFile,
  "T4S.r4-symlink-swap: a swapped symlinked source cannot verify a self-issued record",
  noForeignFile,
  async () => {
    const mine = join(world.root, "mine");
    await mkdir(mine);
    await writeFile(
      join(mine, basename(authorityRecordPath(world, "closure", ["op-1"]))),
      JSON.stringify(closureRecord),
    );
    const linked = join(world.root, "authority-link");
    await symlink(dirname(paths.foreignFile ?? ""), linked);
    const probe = fileSeparation(linked);
    const source: AuthoritySource = {
      directory: linked,
      separated: async (record) => {
        const verdict = await probe(record);
        await unlink(linked);
        await symlink(mine, linked);
        return verdict;
      },
    };
    const verdict = await verifier(source).closure.preflight(closureItem);
    expect(verdict).toMatchObject(humanHandoff);
    expect(await fileSeparation(linked)()).toBe(false);
  },
);

test("T4S.l1-search-diagnostics: an unproved file search reports counts, not paths", async () => {
  await mkdir(join(world.root, "nested"));
  await writeFile(join(world.root, "nested", "mine.json"), "{}");
  const result = await foreignFile([world.root]);
  expect(result.found).toBeUndefined();
  expect(result.missing).toMatch(/^no qualifying file in 1 roots /);
  expect(result.missing).toMatch(/caller-owned [1-9]\d*,/);
  expect(result.missing).not.toContain(world.root);
  expect(result.missing).not.toContain("/");
});

test("T4S.f2-descriptor-wiring: the verifier judges the opened record even when the path check passes", async () => {
  await place("closure", ["op-1"], closureRecord);
  const realProbe = fileSeparation(world.authority);
  const source: AuthoritySource = {
    directory: world.authority,
    separated: (record) =>
      record === undefined ? Promise.resolve(true) : realProbe(record),
  };
  expect(await verifier(source).closure.preflight(closureItem)).toMatchObject(
    humanHandoff,
  );
});

testWhen(
  paths.foreignFile,
  "T4S.f2-caller-ancestor-link: a caller symlink above an otherwise foreign directory never separates",
  noForeignFile,
  async () => {
    const target = dirname(paths.foreignFile ?? "");
    const linked = join(world.root, "ancestor-link");
    await symlink(dirname(target), linked);
    expect(await fileSeparation(target)()).toBe(true);
    expect(await fileSeparation(join(linked, basename(target)))()).toBe(false);
  },
);

testWhen(
  paths.symlinked,
  "T4S.f2-system-ancestor-link: a foreign directory judged through a system symlink never separates",
  "no root-owned symlink near / (macOS /etc, merged-usr /lib) with a foreign child directory",
  async () => {
    const { viaLink, resolved } = paths.symlinked ?? {
      viaLink: "",
      resolved: "",
    };
    expect(await fileSeparation(resolved)()).toBe(true);
    expect(await fileSeparation(viaLink)()).toBe(false);
  },
);

test("C04.a-no-source", async () => {
  await place("closure", ["op-1"], closureRecord);
  await place("stop", ["op-1", "owner-1"], stopRecord);
  expect((await verifier().closure.preflight(closureItem)).status).toBe(
    "verified",
  );
  const before = await snapshot(world);
  const unqualified = verifier("none");
  const verdicts = [
    await unqualified.closure.preflight(closureItem),
    await unqualified.stop.preflight(stopItem),
  ];
  for (const verdict of verdicts) expect(verdict).toMatchObject(humanHandoff);
  expect(verdicts[0]).toEqual(verdicts[1]);
  expectCase(
    "C04.a-no-source",
    observation("unavailable", before, await snapshot(world)),
  );
});

const stopProblems: readonly (readonly [
  string,
  StopItem,
  unknown,
  (() => Promise<void>)?,
])[] = [
  ["S02.a-forged", stopItem, { ...stopRecord, grantedBy: "human" }],
  ["S02.b-stale", stopItem, { ...stopRecord, expiresAt: 1000 }],
  [
    "S02.c-consumed",
    stopItem,
    stopRecord,
    () =>
      writeFile(
        join(world.consumed, markerName(["stop", "op-1", "owner-1"])),
        "",
      ),
  ],
  ["S02.d-wrong-owner", { ...stopItem, owner: "owner-2" }, stopRecord],
  ["S02.e-wrong-operation", { ...stopItem, operation: "op-2" }, stopRecord],
  ["S02.f-wrong-writers", { ...stopItem, writers: ["w-1"] }, stopRecord],
  ["S02.g-wrong-scope", { ...stopItem, scope: "resource-2" }, stopRecord],
  ["S02.h-live-conflict", { ...stopItem, liveConflict: true }, stopRecord],
];
for (const [id, item, record, prior] of stopProblems)
  test(id, async () => {
    await place("stop", [item.operation, item.owner], record);
    await prior?.();
    const outcome = await observed(
      async () => {},
      async () => (await verifier().stop.preflight(item)).status,
    );
    expectCase(id, outcome);
  });

test("S02 valid twins verify without consuming, writers as a set", async () => {
  await place("stop", ["op-1", "owner-1"], stopRecord);
  expect((await verifier().stop.preflight(stopItem)).status).toBe("verified");
  expect((await verifier().stop.preflight(unorderedStopItem)).status).toBe(
    "verified",
  );
  expect(await snapshot(world)).toMatchObject({ markers: [] });
});

test("S06.a-stop-not-closure", async () => {
  await place("closure", ["op-1"], stopRecord);
  const outcome = await observed(
    async () => {},
    async () => (await verifier().closure.preflight(closureItem)).status,
  );
  expectCase("S06.a-stop-not-closure", outcome);
});

test("S06.b-closure-not-stop", async () => {
  await place("stop", ["op-1", "owner-1"], closureRecord);
  const outcome = await observed(
    async () => {},
    async () => (await verifier().stop.preflight(stopItem)).status,
  );
  expectCase("S06.b-closure-not-stop", outcome);
});
