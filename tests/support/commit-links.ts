const shortSha = /^[0-9a-f]{7,40}$/;

export type Citable = {
  page: string;
  pages: string[];
  isThread: (target: string) => boolean;
};

export type Ancestry = Citable & {
  isAncestor: (sha: string) => boolean;
  fetch: string;
};

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function notAncestor(sha: string, { fetch }: Ancestry): string {
  return `${sha}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.${fetch}`;
}

export function commitLinkProblems(
  file: string,
  text: string,
  history: Ancestry,
): { defined: Set<string>; problems: string[] } {
  const problems: string[] = [];
  const defined = new Set<string>();
  const links = [
    ...[...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)/gm)].map((match) => ({
      match,
      definition: true,
    })),
    ...[...text.matchAll(/\[([^\]]+)\]\(([^()\s]+)\)/g)].map((match) => ({
      match,
      definition: false,
    })),
  ];
  for (const { match, definition } of links) {
    const [, label = "", target = ""] = match;
    if (!shortSha.test(label) && !target.includes("/commit/")) continue;
    const where = `${file}:${lineOf(text, match.index)}: [${label}]`;
    if (definition) defined.add(label);
    const page = history.pages.find((each) => target.startsWith(each));
    const sha = page === undefined ? "" : target.slice(page.length);
    if (!/^[0-9a-f]{40}$/.test(sha))
      problems.push(
        `${where} links ${target}, which is not a commit page of this repository. Repair: link ${history.page}<full sha>.`,
      );
    else if (shortSha.test(label) && !sha.startsWith(label))
      problems.push(
        `${where} links commit ${sha}. Repair: make the label the start of that SHA.`,
      );
    else if (!history.isAncestor(sha))
      problems.push(`${where} cites ${notAncestor(sha, history)}`);
  }
  return { defined, problems };
}
