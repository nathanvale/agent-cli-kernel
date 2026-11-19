import { appendFileSync } from "node:fs";
import { withoutRepositoryLocation } from "./process-runner.ts";

const judgedOnlyFolders = [
  "kernel/",
  "tests/",
  "docs/",
  ".agents/",
  ".claude/",
  ".codex/",
] as const;

// Interface: a path the commits jobs never read or run. A change there is
// judged, never trusted. Every other path, a new one included, is part of
// the checker tree.
export function judgedOnly(path: string): boolean {
  return (
    judgedOnlyFolders.some((folder) => path.startsWith(folder)) ||
    (!path.includes("/") && path.endsWith(".md"))
  );
}

// Interface: `listing` is `git ls-tree -r -z --full-tree <commit>`.
export function checkerTree(listing: string): string {
  return listing
    .split("\0")
    .filter((entry) => {
      const tab = entry.indexOf("\t");
      return tab !== -1 && !judgedOnly(entry.slice(tab + 1));
    })
    .join("\n");
}

export type Graph = ReadonlyMap<string, readonly string[]>;

export type MergeFacts = {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly tree: string;
  readonly headTree: string;
};

export type Refused = { readonly refused: string };

export type Decision = {
  readonly since: string | undefined;
  readonly judge: readonly string[];
  readonly reason: string;
};

function short(sha: string): string {
  return sha.slice(0, 7);
}

function behind(graph: Graph, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.pop() ?? "";
    if (seen.has(sha) || !graph.has(sha)) continue;
    seen.add(sha);
    queue.push(...(graph.get(sha) ?? []));
  }
  return seen;
}

function refusal(
  carried: MergeFacts,
  current: MergeFacts,
  graph: Graph,
): string | undefined {
  const [base, head] = current.parents as [string, string];
  if (carried.parents.length !== 2)
    return `the carried merge ${short(carried.sha)} has ${carried.parents.length} parents`;
  const [carriedBase, carriedHead] = carried.parents as [string, string];
  if (carriedHead === head)
    return `the carried head ${short(carriedHead)} is the current head`;
  if (!behind(graph, head).has(carriedHead))
    return `the carried head ${short(carriedHead)} is not behind ${short(head)}`;
  if (!behind(graph, base).has(carriedBase))
    return `the carried base ${short(carriedBase)} is not behind ${short(base)}`;
  if (carried.tree !== current.tree)
    return `the checker tree of the carried merge ${short(carried.sha)} differs from ${short(current.sha)}`;
  if (carried.headTree !== current.headTree)
    return `the checker tree of the carried head ${short(carriedHead)} differs from ${short(head)}`;
  const link = firstLink(current.tree) ?? firstLink(current.headTree);
  if (link !== undefined)
    return `the checker tree holds a symlink or submodule at ${link}`;
  return undefined;
}

function firstLink(tree: string): string | undefined {
  const entry = tree
    .split("\n")
    .find((each) => each.startsWith("120000 ") || each.startsWith("160000 "));
  return entry?.slice(entry.indexOf("\t") + 1);
}

// Interface: `graph` holds every commit behind the current head and the
// current base, each with its parents, in `git rev-list --parents
// --topo-order` order.
export function decide(
  current: MergeFacts,
  carried: MergeFacts | Refused,
  graph: Graph,
): Decision {
  if (current.parents.length !== 2)
    throw new Error(
      `The current merge ${short(current.sha)} has ${current.parents.length} parents, so it is not a pull request merge. Repair: run this on a pull_request event.`,
    );
  const [base, head] = current.parents as [string, string];
  const onBase = behind(graph, base);
  const onHead = behind(graph, head);
  const range = [...graph.keys()]
    .filter((sha) => !onBase.has(sha) && onHead.has(sha))
    .reverse();
  const cause =
    "refused" in carried ? carried.refused : refusal(carried, current, graph);
  if (cause !== undefined || "refused" in carried)
    return {
      since: undefined,
      judge: range,
      reason: `No carried verdict: ${cause}, so every commit in ${short(base)}..${short(head)} is judged.`,
    };
  const [carriedBase, carriedHead] = carried.parents as [string, string];
  const covered = behind(graph, carriedHead);
  const judge = range.filter((sha) => !covered.has(sha));
  return {
    since: carriedHead,
    judge,
    reason: `Carried ${short(carriedHead)}: the run of merge ${short(carried.sha)} judged every commit behind it against ${short(carriedBase)}. Judging ${judge.length} of ${range.length} commits.`,
  };
}

// Platform: the runner drops a job output that looks like a token ("Skip
// output since it may contain secret"), so commits-cache hands the token
// over as hex.
export function tokenFromHex(hex: string | undefined): string | undefined {
  if (hex === undefined || hex === "") return undefined;
  return /^(?:[0-9a-f]{2})+$/.test(hex)
    ? Buffer.from(hex, "hex").toString("utf8")
    : hex;
}

export type Expected = {
  readonly audience: string;
  readonly repositoryId: string;
  readonly workflow: string;
};

type Claims = Record<string, unknown>;

function decoded(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function wrongClaim(claims: Claims, expected: Expected): string | undefined {
  const workflowRef = new RegExp(
    `^${expected.workflow.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@refs/pull/[0-9]+/merge$`,
  );
  const audience = claims.aud;
  const checks: [string, boolean][] = [
    ["iss", claims.iss === "https://token.actions.githubusercontent.com"],
    [
      "aud",
      audience === expected.audience ||
        (Array.isArray(audience) && audience.includes(expected.audience)),
    ],
    ["repository_id", claims.repository_id === expected.repositoryId],
    ["event_name", claims.event_name === "pull_request"],
    [
      "workflow_ref",
      typeof claims.workflow_ref === "string" &&
        workflowRef.test(claims.workflow_ref),
    ],
    ["job_workflow_ref", claims.job_workflow_ref === claims.workflow_ref],
    ["runner_environment", claims.runner_environment === "github-hosted"],
    [
      "sha",
      typeof claims.sha === "string" && /^[0-9a-f]{40}$/.test(claims.sha),
    ],
  ];
  const wrong = checks.find(([, holds]) => !holds)?.[0];
  return wrong === undefined
    ? undefined
    : `the carried token's ${wrong} claim is ${JSON.stringify(claims[wrong])}`;
}

// Interface: `keys` is the `keys` list GitHub publishes at
// https://token.actions.githubusercontent.com/.well-known/jwks. Expiry is not
// read: the token proves what a past run executed, not who holds it now.
export async function readToken(
  token: string,
  keys: readonly JsonWebKey[],
  expected: Expected,
): Promise<{ readonly merge: string } | Refused> {
  const parts = token.trim().split(".");
  if (parts.length !== 3)
    return { refused: "the carried token is not a signed JWT" };
  const [header, body, signature] = parts as [string, string, string];
  let head: Claims;
  let claims: Claims;
  try {
    head = { ...(decoded(header) as Claims) };
    claims = { ...(decoded(body) as Claims) };
  } catch {
    return { refused: "the carried token is not a signed JWT" };
  }
  if (head.alg !== "RS256")
    return { refused: `the carried token uses ${String(head.alg)}, not RS256` };
  const key = keys.find(
    (each) =>
      (each as { kid?: unknown }).kid === head.kid && each.kty === "RSA",
  );
  if (key === undefined)
    return {
      refused: `the carried token names key ${String(head.kid)}, which GitHub does not publish`,
    };
  const verifier = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifier,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${body}`),
  );
  if (!verified)
    return { refused: "the carried token's signature does not verify" };
  const wrong = wrongClaim(claims, expected);
  return wrong === undefined
    ? { merge: claims.sha as string }
    : { refused: wrong };
}

const gitMilliseconds = 60_000;

function git(root: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: withoutRepositoryLocation(process.env),
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  return {
    ok: result.exitCode === 0 && !result.exitedDueToTimeout,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  };
}

function present(root: string, sha: string): boolean {
  return (
    git(root, ["cat-file", "-e", `${sha}^{commit}`]).ok ||
    (git(root, ["fetch", "--no-tags", "--quiet", "origin", sha]).ok &&
      git(root, ["cat-file", "-e", `${sha}^{commit}`]).ok)
  );
}

function treeOf(root: string, sha: string): string {
  const listed = git(root, ["ls-tree", "-r", "-z", "--full-tree", sha]);
  if (!listed.ok) throw new Error(listed.stderr);
  return checkerTree(listed.stdout);
}

function factsOf(root: string, sha: string): MergeFacts {
  const listed = git(root, ["rev-list", "--parents", "-n", "1", sha]);
  if (!listed.ok) throw new Error(listed.stderr);
  const parents = listed.stdout.trim().split(" ").slice(1);
  const head = parents[1];
  return {
    sha,
    parents,
    tree: treeOf(root, sha),
    headTree:
      head === undefined || !present(root, head) ? "" : treeOf(root, head),
  };
}

function graphOf(root: string, tips: readonly string[]): Graph {
  const listed = git(root, ["rev-list", "--parents", "--topo-order", ...tips]);
  if (!listed.ok) throw new Error(listed.stderr);
  return new Map(
    listed.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [sha = "", ...parents] = line.split(" ");
        return [sha, parents] as const;
      }),
  );
}

export type Environment = {
  readonly root: string;
  readonly current: string;
  readonly head: string;
  readonly token: string | undefined;
  readonly keys: () => Promise<readonly JsonWebKey[]>;
  readonly expected: Expected;
};

async function carriedFacts(env: Environment): Promise<MergeFacts | Refused> {
  if (env.token === undefined || env.token.trim() === "")
    return { refused: "no carried token" };
  let keys: readonly JsonWebKey[];
  try {
    keys = await env.keys();
  } catch (error) {
    return {
      refused: `GitHub's OIDC keys could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const read = await readToken(env.token, keys, env.expected);
  if ("refused" in read) return read;
  if (!present(env.root, read.merge))
    return {
      refused: `the carried merge ${short(read.merge)} could not be fetched`,
    };
  try {
    return factsOf(env.root, read.merge);
  } catch (error) {
    return {
      refused: `the carried merge ${short(read.merge)} could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

// Interface: `current` is the merge commit this pull_request run executes
// (GITHUB_SHA). Every failure to prove a carried head is a refusal, which
// judges every commit; only a current merge that cannot be read throws.
export async function carry(env: Environment): Promise<Decision> {
  if (!present(env.root, env.current))
    throw new Error(
      `The current merge ${short(env.current)} is not in this clone and could not be fetched. Repair: check out with fetch-depth 0 and rerun.`,
    );
  const current = factsOf(env.root, env.current);
  if (current.parents[1] !== env.head)
    throw new Error(
      `The current merge ${short(env.current)} merges ${short(current.parents[1] ?? "nothing")}, not the checked-out head ${short(env.head)}. Repair: check out the pull request head and rerun.`,
    );
  const carried = await carriedFacts(env).catch((error: unknown) => ({
    refused: `the carried token could not be read (${error instanceof Error ? error.message : String(error)})`,
  }));
  const tips = current.parents.slice(0, 2);
  return decide(current, carried, graphOf(env.root, tips));
}

async function publishedKeys(): Promise<readonly JsonWebKey[]> {
  const response = await fetch(
    "https://token.actions.githubusercontent.com/.well-known/jwks",
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { keys: JsonWebKey[] }).keys;
}

if (import.meta.main) {
  const {
    GITHUB_SHA,
    GITHUB_REPOSITORY,
    GITHUB_REPOSITORY_ID,
    GITHUB_OUTPUT,
    CARRIED_TOKEN_HEX,
  } = process.env;
  if (
    GITHUB_SHA === undefined ||
    GITHUB_REPOSITORY === undefined ||
    GITHUB_REPOSITORY_ID === undefined
  ) {
    process.stderr.write(
      "Usage: GITHUB_SHA=<merge> GITHUB_REPOSITORY=<owner/name> GITHUB_REPOSITORY_ID=<id> [CARRIED_TOKEN_HEX=<hex of the jwt>] bun scripts/carried-verdict.ts\n",
    );
    process.exit(2);
  }
  const root = process.cwd();
  try {
    const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const decision = await carry({
      root,
      current: GITHUB_SHA,
      head,
      token: tokenFromHex(CARRIED_TOKEN_HEX),
      keys: publishedKeys,
      expected: {
        audience: `${GITHUB_REPOSITORY} commits verdict`,
        repositoryId: GITHUB_REPOSITORY_ID,
        workflow: `${GITHUB_REPOSITORY}/.github/workflows/ci.yml`,
      },
    });
    process.stdout.write(`${decision.reason}\n`);
    const base = factsOf(root, GITHUB_SHA).parents[0] ?? "";
    if (GITHUB_OUTPUT !== undefined)
      appendFileSync(
        GITHUB_OUTPUT,
        `since=${decision.since ?? ""}\nbase=${base}\n`,
      );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}
