// In-process T4 approval component cases: non-consuming preflight, the
// hardened read, exact-item binding and the human-authority verifier.
// Consumption under coordination is proved in process.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, link, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  approval,
  authorityLocation,
  authorityVerifier,
  fileSeparation,
} from "../../../starters/contract3/src/addons/approval/index.ts";
import type {
  AuthoritySource,
  ClosureItem,
  StopItem,
} from "../../../starters/contract3/src/addons/approval/index.ts";
import { contractFor } from "../../../starters/contract3/src/kernel/index.ts";
import {
  createWorld,
  expectedFor,
  grant,
  grantPath,
  markerName,
  observation,
  removeAll,
  snapshot,
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
    store: { grants: world.grants, ledger: world.ledger },
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
    return error instanceof Error &&
      error.message === "Approval authority store is unavailable."
      ? "operational-failure"
      : "unexpected-error";
  }
}
async function observed(
  setup: () => Promise<void>,
  act: () => Promise<string>,
) {
  // Setup is the fixture before state; the denial must not rewrite it.
  await setup();
  const before = await snapshot(world);
  const outcome = await act();
  return observation(outcome, before, await snapshot(world));
}

test("A01.a-preflight-non-consuming", async () => {
  await writeGrant(world, grant);
  expect(await observed(async () => {}, preflight)).toEqual(
    expectedFor("A01.a-preflight-non-consuming"),
  );
  // Inspection is repeatable because nothing was consumed.
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
        join(world.ledger, markerName(["approval", grant.preview])),
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
    expect(observation("denied", before, await snapshot(world))).toEqual(
      expectedFor(id),
    );
    // Existing invalid state is preserved, not rewritten to look unused.
    expect(await snapshot(world)).toEqual(before);
  });

test("A03 valid twin of the denial variants admits", async () => {
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
    expect(await observed(setup, preflight)).toEqual(expectedFor(id));
  });

test("A04.h-invalid-utf8", async () => {
  // The request names U+FFFD, so lossy decoding of the 0xff byte would
  // otherwise turn the invalid bytes into a matching authority.
  const text = JSON.stringify({ ...grant, authority: "owner-?" });
  const bytes = Buffer.from(text, "utf8");
  bytes[bytes.indexOf("?")] = 0xff;
  const outcome = await observed(
    () => writeFile(grantPath(world, grant.preview), bytes),
    () => preflight({ authority: "owner-\uFFFD" }),
  );
  expect(outcome).toEqual(expectedFor("A04.h-invalid-utf8"));
});

test("A04.l-traversal-preview", async () => {
  // Names are digests, so a traversal identity addresses nothing else.
  await writeFile(
    join(world.root, "evil.json"),
    JSON.stringify({ ...grant, preview: "../evil" }),
  );
  await writeGrant(world, grant);
  const outcome = await observed(
    async () => {},
    () => preflight({ preview: "../evil" }),
  );
  expect(outcome).toEqual(expectedFor("A04.l-traversal-preview"));
  expect(basename(grantPath(world, "../evil"))).toMatch(/^[0-9a-f]{64}\.json$/);
});

test("A04 valid twins admit: bounded size, regular single-link file", async () => {
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
  expect(observation(fileOutcome, before, await snapshot(world))).toEqual(
    expectedFor("A04.m-unreadable"),
  );
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
    expect(await observed(setup, act)).toEqual(expectedFor(id));
    // Identical twin with every binding equal admits.
    await writeGrant(world, grant);
    expect(await preflight()).toBe("admitted");
  });

test("A05 effect sets compare as sets, not sequences", async () => {
  await writeGrant(world, { ...grant, effects: ["note.write", "note.index"] });
  expect(await preflight({ effects: ["note.write", "note.index"] })).toBe(
    "admitted",
  );
});

// Adversarial test authority: claims separation so verifier logic can be
// exercised. It never qualifies production authority (REC-5).
function fixtureSource(): AuthoritySource {
  return { directory: world.authority, separated: () => Promise.resolve(true) };
}
const closureRecord = {
  format: "contract3.closure-authority",
  version: 1,
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
  expiresAt: 5000,
} as const;
const closureItem: ClosureItem = {
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
};
const stopRecord = {
  format: "contract3.stop-attestation",
  version: 1,
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  expiresAt: 5000,
} as const;
const stopItem: StopItem = {
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-2", "w-1"],
  scope: "resource-1",
  liveConflict: false,
};
function verifier(source: AuthoritySource | "none" = fixtureSource()) {
  return authorityVerifier({
    runId: "component",
    ledger: world.ledger,
    now: () => 1000,
    ...(source === "none" ? {} : { closure: source, stop: source }),
  });
}
async function place(
  kind: "closure" | "stop",
  parts: readonly string[],
  record: unknown,
): Promise<void> {
  await writeFile(
    authorityLocation(fixtureSource(), kind, parts),
    JSON.stringify(record),
  );
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
    expect(outcome).toEqual(expectedFor(id));
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

const humanHandoff = {
  status: "unavailable",
  handoff: { owner: "human" },
};

test("C03.a-same-user-file", async () => {
  const source = {
    directory: world.authority,
    separated: fileSeparation(world.authority),
  };
  await place("closure", ["op-1"], closureRecord);
  await writeFile(
    authorityLocation(source, "closure", ["op-2"]),
    JSON.stringify({ ...closureRecord, operation: "op-2", grantedBy: "human" }),
  );
  const before = await snapshot(world);
  const verdicts = [
    await verifier(source).closure.preflight(closureItem),
    await verifier(source).closure.preflight({
      ...closureItem,
      operation: "op-2",
    }),
  ];
  for (const verdict of verdicts) expect(verdict).toMatchObject(humanHandoff);
  expect(observation("unavailable", before, await snapshot(world))).toEqual(
    expectedFor("C03.a-same-user-file"),
  );
});

test("C03.b-caller-created-record", async () => {
  const source = {
    directory: world.authority,
    separated: fileSeparation(world.authority),
  };
  const before = await snapshot(world);
  // Caller creates the record, then drops its own write permissions.
  await place("closure", ["op-1"], closureRecord);
  await chmod(authorityLocation(source, "closure", ["op-1"]), 0o444);
  await chmod(world.authority, 0o555);
  const verdict = await verifier(source).closure.preflight(closureItem);
  await chmod(world.authority, 0o700);
  expect(verdict).toMatchObject(humanHandoff);
  expect(observation(verdict.status, before, await snapshot(world))).toEqual(
    expectedFor("C03.b-caller-created-record"),
  );
});

test("C04.a-no-source", async () => {
  await place("closure", ["op-1"], closureRecord);
  await place("stop", ["op-1", "owner-1"], stopRecord);
  // A fixture verifier passing first is not an enablement signal.
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
  expect(observation("unavailable", before, await snapshot(world))).toEqual(
    expectedFor("C04.a-no-source"),
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
        join(world.ledger, markerName(["stop", "op-1", "owner-1"])),
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
    expect(outcome).toEqual(expectedFor(id));
  });

test("S02 valid twin verifies without consuming", async () => {
  await place("stop", ["op-1", "owner-1"], stopRecord);
  expect((await verifier().stop.preflight(stopItem)).status).toBe("verified");
  expect(await snapshot(world)).toMatchObject({ markers: [] });
});

test("S06.a-stop-not-closure", async () => {
  await place("closure", ["op-1"], stopRecord);
  const outcome = await observed(
    async () => {},
    async () => (await verifier().closure.preflight(closureItem)).status,
  );
  expect(outcome).toEqual(expectedFor("S06.a-stop-not-closure"));
});

test("S06.b-closure-not-stop", async () => {
  await place("stop", ["op-1", "owner-1"], closureRecord);
  const outcome = await observed(
    async () => {},
    async () => (await verifier().stop.preflight(stopItem)).status,
  );
  expect(outcome).toEqual(expectedFor("S06.b-closure-not-stop"));
});
