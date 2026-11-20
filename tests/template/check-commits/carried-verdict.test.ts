import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import {
  carry,
  checkerTree,
  decide,
  judgedOnly,
  readToken,
  tokenFromHex,
  treeOf,
  type Graph,
  type MergeFacts,
} from "../../../scripts/carried-verdict.ts";

const root = resolve(import.meta.dir, "../../..");
const sha = (n: number) => n.toString(16).padStart(40, "a");
const short = (each: string) => each.slice(0, 7);

const B1 = sha(1);
const B2 = sha(2);
const B3 = sha(3);
const P1 = sha(11);
const P2 = sha(12);
const P3 = sha(13);
const graph: Graph = new Map([
  [P3, [P2]],
  [P2, [P1]],
  [P1, [B1]],
  [B3, [B2]],
  [B2, [B1]],
  [B1, []],
]);
const current: MergeFacts = {
  sha: sha(100),
  parents: [B3, P3],
  tree: "workflow",
  headTree: "scripts",
};
const carried: MergeFacts = {
  sha: sha(200),
  parents: [B2, P2],
  tree: "workflow",
  headTree: "scripts",
};
const all = `so every commit in ${short(B3)}..${short(P3)} is judged.`;

describe("decide", () => {
  test("a verified carried head leaves only the commits after it to judge", () => {
    expect(decide(current, carried, graph)).toEqual({
      since: P2,
      judge: [P3],
      reason: `Carried ${short(P2)}: the run of merge ${short(carried.sha)} judged every commit behind it against ${short(B2)}. Judging 1 of 3 commits.`,
    });
  });

  test.each([
    [
      "no token",
      "no carried token",
      `No carried verdict: no carried token, ${all}`,
    ],
  ])("a refused token (%s) judges every commit", (_, refused, reason) => {
    expect(decide(current, { refused }, graph)).toEqual({
      since: undefined,
      judge: [P1, P2, P3],
      reason,
    });
  });

  const refusals: [string, MergeFacts, string][] = [
    [
      "a carried merge without two parents",
      { ...carried, parents: [P2] },
      `the carried merge ${short(carried.sha)} has 1 parents`,
    ],
    [
      "a carried head equal to the current head, as on a rerun",
      { ...carried, parents: [B2, P3] },
      `the carried head ${short(P3)} is the current head`,
    ],
    [
      "a carried head not behind the current head, as after a rewrite",
      { ...carried, parents: [B2, sha(99)] },
      `the carried head ${short(sha(99))} is not behind ${short(P3)}`,
    ],
    [
      "a carried base not behind the current base, as after a retarget",
      { ...carried, parents: [sha(98), P2] },
      `the carried base ${short(sha(98))} is not behind ${short(B3)}`,
    ],
    [
      "a carried run whose merge ran another workflow or checker",
      { ...carried, tree: "edited workflow" },
      `the checker tree of the carried merge ${short(carried.sha)} differs from ${short(current.sha)}`,
    ],
    [
      "a carried head whose checker tree differs from the current head",
      { ...carried, headTree: "edited scripts" },
      `the checker tree of the carried head ${short(P2)} differs from ${short(P3)}`,
    ],
  ];

  test.each(refusals)("%s judges every commit", (_, facts, cause) => {
    expect(decide(current, facts, graph)).toEqual({
      since: undefined,
      judge: [P1, P2, P3],
      reason: `No carried verdict: ${cause}, ${all}`,
    });
  });

  test("a checker tree holding a symlink judges every commit", () => {
    const linked = `workflow\x00120000 blob ${sha(7)}\tscripts/lib.ts`;

    expect(
      decide({ ...current, tree: linked }, { ...carried, tree: linked }, graph),
    ).toEqual({
      since: undefined,
      judge: [P1, P2, P3],
      reason: `No carried verdict: the checker tree holds a symlink or submodule at scripts/lib.ts, ${all}`,
    });
  });

  test("a head checker tree holding a submodule judges every commit", () => {
    const linked = `scripts\x00160000 commit ${sha(8)}\tvendor/tool`;

    expect(
      decide(
        { ...current, headTree: linked },
        { ...carried, headTree: linked },
        graph,
      ).reason,
    ).toBe(
      `No carried verdict: the checker tree holds a symlink or submodule at vendor/tool, ${all}`,
    );
  });

  test("a current merge without two parents is refused before any judging", () => {
    expect(() => decide({ ...current, parents: [P3] }, carried, graph)).toThrow(
      `The current merge ${short(current.sha)} has 1 parents, so it is not a pull request merge. Repair: run this on a pull_request event.`,
    );
  });
});

describe("checkerTree", () => {
  const entry = (path: string, blob = "1") =>
    `100644 blob ${sha(Number(blob))}\t${path}\0`;

  test("leaves out judged-only folders and root markdown, and keeps the rest", () => {
    const listing = [
      ".env",
      ".github/workflows/ci.yml",
      ".githooks/post-checkout",
      "README.md",
      "docs/agents/README.md",
      "kernel/run.ts",
      "package.json",
      "scripts/check-commits.ts",
      "scripts/notes.md",
      "tests/kernel/run.test.ts",
    ]
      .map((path) => entry(path))
      .join("");

    expect(checkerTree(listing)).toBe(
      [
        ".env",
        ".github/workflows/ci.yml",
        ".githooks/post-checkout",
        "package.json",
        "scripts/check-commits.ts",
        "scripts/notes.md",
      ]
        .map((path) => `100644 blob ${sha(1)}\t${path}`)
        .join("\0"),
    );
  });

  test("a file name holding a newline never reads as two entries", () => {
    const twoEntries = entry("x", "1") + entry("y", "2");
    const oneCrafted = entry(`x\n100644 blob ${sha(2)}\ty`, "1");

    expect(checkerTree(oneCrafted)).not.toBe(checkerTree(twoEntries));
  });

  test("a changed blob outside the judged-only folders changes the tree", () => {
    expect(checkerTree(entry("bun.lock", "1"))).not.toBe(
      checkerTree(entry("bun.lock", "2")),
    );
  });

  test("a changed blob inside a judged-only folder leaves the tree alone", () => {
    expect(checkerTree(entry("kernel/run.ts", "1"))).toBe(
      checkerTree(entry("kernel/run.ts", "2")),
    );
  });
});

describe("judged-only folders", () => {
  const entries = ["scripts/check-commits.ts", "scripts/carried-verdict.ts"];

  function imports(file: string): string[] {
    const text = readFileSync(file, "utf8");
    return [
      ...text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g),
    ].map((match) => realpathSync(resolve(dirname(file), match[1] ?? "")));
  }

  test("nothing the commits jobs run imports a file from a judged-only folder", () => {
    const seen = new Set<string>();
    const queue = entries.map((each) => join(root, each));
    while (queue.length > 0) {
      const file = queue.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      expect(existsSync(file)).toBe(true);
      queue.push(...imports(file));
    }
    const read = [...seen].map((file) => relative(root, file));
    expect(read.filter(judgedOnly)).toEqual([]);
    expect(read).toContain("scripts/process-runner.ts");
  });
});

const audience = "nathanvale/agent-cli-kernel commits verdict";
const expected = {
  audience,
  repositoryId: "1462197427",
  workflow: "nathanvale/agent-cli-kernel/.github/workflows/ci.yml",
};
const merge = sha(300);
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: audience,
  repository_id: "1462197427",
  event_name: "pull_request",
  workflow_ref: `${expected.workflow}@refs/pull/7/merge`,
  job_workflow_ref: `${expected.workflow}@refs/pull/7/merge`,
  runner_environment: "github-hosted",
  sha: merge,
};

const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const pair = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const published = [
  { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" },
];

const part = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

async function token(
  body: Record<string, unknown>,
  { kid = "k1", alg = "RS256", key = pair.privateKey } = {},
): Promise<string> {
  const signed = `${part({ alg, kid, typ: "JWT" })}.${part(body)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

describe("tokenFromHex", () => {
  test("hex from commits-cache decodes to the token it encodes", () => {
    expect(tokenFromHex(Buffer.from("a.b.c").toString("hex"))).toBe("a.b.c");
  });

  test("no hex is no token", () => {
    expect([tokenFromHex(undefined), tokenFromHex("")]).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("text that is not hex passes through for readToken to refuse", () => {
    expect(tokenFromHex("not hex")).toBe("not hex");
  });
});

describe("readToken", () => {
  test("a token GitHub signed for this workflow names its merge commit", async () => {
    expect(await readToken(await token(claims), published, expected)).toEqual({
      merge,
    });
  });

  test("a token past its expiry still names its merge commit, because it proves what a past run executed", async () => {
    expect(
      await readToken(await token({ ...claims, exp: 1 }), published, expected),
    ).toEqual({ merge });
  });

  test("an audience given as a list holds when it names ours", async () => {
    expect(
      await readToken(
        await token({ ...claims, aud: ["other", audience] }),
        published,
        expected,
      ),
    ).toEqual({ merge });
  });

  test("a signature from another key is refused", async () => {
    expect(
      await readToken(
        await token(claims, { key: other.privateKey }),
        published,
        expected,
      ),
    ).toEqual({ refused: "the carried token's signature does not verify" });
  });

  test("a key id GitHub does not publish is refused", async () => {
    expect(
      await readToken(await token(claims, { kid: "k9" }), published, expected),
    ).toEqual({
      refused: "the carried token names key k9, which GitHub does not publish",
    });
  });

  test("an algorithm other than RS256 is refused", async () => {
    expect(
      await readToken(
        await token(claims, { alg: "none" }),
        published,
        expected,
      ),
    ).toEqual({ refused: "the carried token uses none, not RS256" });
  });

  test("a header that decodes to null is refused", async () => {
    expect(
      await readToken(
        `${part(null)}.${part(claims)}.c2ln`,
        published,
        expected,
      ),
    ).toEqual({ refused: "the carried token uses undefined, not RS256" });
  });

  test("a token that is not three parts is refused", async () => {
    expect(await readToken("one.two", published, expected)).toEqual({
      refused: "the carried token is not a signed JWT",
    });
  });

  test.each([
    ["iss", "https://example.com"],
    ["aud", "another audience"],
    ["repository_id", "1"],
    ["event_name", "push"],
    ["workflow_ref", `${expected.workflow}@refs/heads/main`],
    [
      "workflow_ref",
      "nathanvale/agent-cli-kernel/.github/workflows/evil.yml@refs/pull/7/merge",
    ],
    [
      "job_workflow_ref",
      "nathanvale/other/.github/workflows/ci.yml@refs/heads/main",
    ],
    ["runner_environment", "self-hosted"],
    ["sha", "abc"],
  ])("a claim %s of %s is refused", async (claim, value) => {
    expect(
      await readToken(
        await token({ ...claims, [claim]: value }),
        published,
        expected,
      ),
    ).toEqual({
      refused: `the carried token's ${claim} claim is ${JSON.stringify(value)}`,
    });
  });
});

describe("carry", () => {
  const folder = ownedFolders();

  test("checker trees whose paths differ only in bytes that are not UTF-8 never compare equal", () => {
    const root = folder("carried-verdict-bytes-");
    initRepository(root);
    commitIn(root, "base", { "package.json": "{}" });
    const blob = git(root, "rev-parse", "HEAD:package.json");
    const withPath = (byte: number) => {
      git(root, "read-tree", "--empty");
      const record = Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tscripts/bad`),
        Buffer.from([byte, 0]),
      ]);
      const added = Bun.spawnSync(
        ["git", "update-index", "-z", "--index-info"],
        {
          cwd: root,
          env: { ...inherited(), ...gitEnv },
          stdin: record,
        },
      );
      expect(added.exitCode).toBe(0);
      return git(root, "commit-tree", git(root, "write-tree"), "-m", "path");
    };

    expect(treeOf(root, withPath(0xff))).not.toBe(treeOf(root, withPath(0xfe)));
  });

  const workflow = ".github/workflows/ci.yml";

  function repositoryWithTwoRuns(carriedWorkflow = "jobs: commits") {
    const root = folder("carried-verdict-");
    initRepository(root);
    const b1 = commitIn(root, "base", {
      [workflow]: "jobs: commits",
      "package.json": "{}",
      "kernel/run.ts": "1",
    }).sha;
    const b2 = commitIn(root, "main moves", { "docs/a.md": "2" }).sha;
    const b3 = commitIn(root, "main moves again", { "docs/a.md": "3" }).sha;
    git(root, "checkout", "--quiet", "-b", "branch", b1);
    const p1 = commitIn(root, "one", { "kernel/run.ts": "p1" }).sha;
    const p2 = commitIn(root, "two", { "kernel/run.ts": "p2" }).sha;
    const p3 = commitIn(root, "three", { "kernel/run.ts": "p3" }).sha;
    git(root, "checkout", "--quiet", "--detach", p2);
    const ran = commitIn(root, "what the carried run executed", {
      [workflow]: carriedWorkflow,
    }).sha;
    const mergeOf = (tree: string, base: string, head: string) =>
      git(
        root,
        "commit-tree",
        `${tree}^{tree}`,
        "-p",
        base,
        "-p",
        head,
        "-m",
        "merge",
      );
    return {
      root,
      p1,
      p2,
      p3,
      carried: mergeOf(ran, b2, p2),
      current: mergeOf(p3, b3, p3),
    };
  }

  async function carried(root: string, current: string, carriedMerge: string) {
    return carry({
      root,
      current,
      head: git(root, "rev-parse", `${current}^2`),
      token: await token({ ...claims, sha: carriedMerge }),
      keys: () => Promise.resolve(published),
      expected,
    });
  }

  test("a token whose merge ran the current checker tree leaves only newer commits to judge", async () => {
    const { root, p2, p3, carried: merge, current } = repositoryWithTwoRuns();

    const decision = await carried(root, current, merge);

    expect(decision.since).toBe(p2);
    expect(decision.judge).toEqual([p3]);
  });

  test("a token whose merge ran an edited workflow judges every commit", async () => {
    const {
      root,
      p1,
      p2,
      p3,
      carried: merge,
      current,
    } = repositoryWithTwoRuns("jobs: commits\n  forged: true");

    expect(await carried(root, current, merge)).toEqual({
      since: undefined,
      judge: [p1, p2, p3],
      reason: `No carried verdict: the checker tree of the carried merge ${short(merge)} differs from ${short(current)}, so every commit in ${short(git(root, "rev-parse", `${current}^1`))}..${short(p3)} is judged.`,
    });
  });

  test("a current merge of another head than the one checked out is refused", async () => {
    const { root, p2, carried: merge, current } = repositoryWithTwoRuns();

    const stopped = await carry({
      root,
      current,
      head: p2,
      token: await token({ ...claims, sha: merge }),
      keys: () => Promise.resolve(published),
      expected,
    }).catch((error: unknown) => String(error));

    expect(stopped).toBe(
      `Error: The current merge ${short(current)} merges ${short(git(root, "rev-parse", `${current}^2`))}, not the checked-out head ${short(p2)}. Repair: check out the pull request head and rerun.`,
    );
  });

  test("a carried merge this clone cannot fetch judges every commit", async () => {
    const { root, p1, p2, p3, current } = repositoryWithTwoRuns();
    const missing = sha(404);

    expect(await carried(root, current, missing)).toEqual({
      since: undefined,
      judge: [p1, p2, p3],
      reason: `No carried verdict: the carried merge ${short(missing)} could not be fetched, so every commit in ${short(git(root, "rev-parse", `${current}^1`))}..${short(p3)} is judged.`,
    });
  });
});
