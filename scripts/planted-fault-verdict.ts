export type Verdict =
  | { kind: "KILLED"; failing: readonly string[] }
  | { kind: "SURVIVED" }
  | { kind: "STALE"; output: string }
  | { kind: "UNPARSED"; files: readonly string[]; output: string }
  | { kind: "UNMATCHED"; failing: readonly string[]; output: string }
  | { kind: "BROKEN"; output: string }
  | { kind: "TIMEOUT"; step: string };

function failingTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
    (match) => match[1] ?? "",
  );
}

function parseError(path: string, text: string): string | undefined {
  const parse = /\.(?:m?ts|m?js)$/.test(path)
    ? () => {
        new Bun.Transpiler({
          loader: /\.m?ts$/.test(path) ? "ts" : "js",
        }).transformSync(text);
      }
    : /\.json$/.test(path)
      ? () => {
          JSON.parse(text);
        }
      : undefined;
  if (parse === undefined) return undefined;
  try {
    parse();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function unparsedFiles(
  files: ReadonlyMap<string, string>,
): { files: string[]; output: string } | undefined {
  const failed: string[] = [];
  const details: string[] = [];
  for (const [path, text] of files) {
    const message = parseError(path, text);
    if (message === undefined) continue;
    failed.push(path);
    details.push(`${path}: ${message}`);
  }
  return failed.length === 0
    ? undefined
    : { files: failed, output: details.join("\n") };
}

function matchesTitle(failing: readonly string[], title: string): boolean {
  const pattern = new RegExp(title);
  return failing.some((name) => pattern.test(name.replaceAll(" > ", " ")));
}

export function faultedVerdict(
  output: string,
  title: string,
): Extract<Verdict, { kind: "KILLED" | "UNMATCHED" }> {
  const failing = failingTests(output);
  if (!matchesTitle(failing, title))
    return { kind: "UNMATCHED", failing, output };
  return { kind: "KILLED", failing };
}
