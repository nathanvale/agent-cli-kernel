export type Verdict =
  | { kind: "KILLED"; failing: readonly string[] }
  | { kind: "SURVIVED" }
  | { kind: "STALE"; output: string }
  | { kind: "UNPARSED"; files: readonly string[]; output: string }
  | { kind: "UNMATCHED"; failing: readonly string[]; output: string }
  | { kind: "BROKEN"; output: string }
  | { kind: "TIMEOUT"; step: string };

const xmlEntities = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

type XmlTag = {
  closing: boolean;
  selfClosing: boolean;
  name: string;
  attributes: string;
};

function decodeXml(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,
    (_full, entity: string) => {
      const named = xmlEntities.get(entity);
      if (named !== undefined) return named;
      const radix = entity.startsWith("#x") ? 16 : 10;
      const digits = entity.slice(radix === 16 ? 2 : 1);
      return String.fromCodePoint(Number.parseInt(digits, radix));
    },
  );
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

function recordSuite(suites: string[], tag: XmlTag): void {
  if (tag.closing) suites.pop();
  else if (!tag.selfClosing)
    suites.push(xmlAttribute(tag.attributes, "name") ?? "");
}

function openTestCase(
  suites: readonly string[],
  attributes: string,
): { name: string; failed: boolean } | undefined {
  const name = xmlAttribute(attributes, "name");
  if (name === undefined) return undefined;
  return { name: [...suites.slice(1), name].join(" > "), failed: false };
}

type ParserState = {
  suites: string[];
  failing: string[];
  current: { name: string; failed: boolean } | undefined;
};

function stepTestCase(state: ParserState, tag: XmlTag): void {
  if (tag.closing && state.current?.failed)
    state.failing.push(state.current.name);
  if (tag.closing || tag.selfClosing) {
    state.current = undefined;
    return;
  }
  state.current = openTestCase(state.suites, tag.attributes);
}

function stepTag(state: ParserState, tag: XmlTag): void {
  if (tag.name === "testsuite") {
    recordSuite(state.suites, tag);
    return;
  }
  if (tag.name === "testcase") {
    stepTestCase(state, tag);
    return;
  }
  if (!tag.closing && state.current !== undefined) state.current.failed = true;
}

function parseTag(match: RegExpExecArray): XmlTag {
  return {
    closing: match[1] === "/",
    name: match[2] ?? "",
    attributes: match[3] ?? "",
    selfClosing: match[4] === "/",
  };
}

function failingTests(report: string | undefined): string[] {
  if (report === undefined || report === "") return [];
  const state: ParserState = { suites: [], failing: [], current: undefined };
  for (const match of report.matchAll(
    /<(\/?)(testsuite|testcase|failure|error)\b([^>]*?)(\/?)>/g,
  ))
    stepTag(state, parseTag(match));
  return state.failing;
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
  report: string | undefined,
  title: string,
): Extract<Verdict, { kind: "KILLED" | "UNMATCHED" }> {
  const failing = failingTests(report);
  if (!matchesTitle(failing, title))
    return { kind: "UNMATCHED", failing, output };
  return { kind: "KILLED", failing };
}
