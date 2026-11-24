const lineBreak = /[\r\n\u2028\u2029]/;
const eslintRule =
  "(?:@[a-z0-9_-]+/)?[a-z0-9][A-Za-z0-9_-]*(?:/[a-z0-9][A-Za-z0-9_-]*)*";
const eslintRuleList = `(?:\\s+${eslintRule}(?:\\s*,\\s*${eslintRule})*)?`;
const eslintReason = "(?:\\s+--\\s+\\S.*)?";
const eslintLineDirective = new RegExp(
  `^eslint-disable(?:-next)?-line${eslintRuleList}${eslintReason}$`,
);
const eslintBlockDirective = new RegExp(
  `^(?:eslint-(?:disable|enable)${eslintRuleList}${eslintReason}|eslint\\s+${eslintRule}\\s*:\\s*\\S.*|globals?\\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*:\\s*(?:readonly|writable|off|true|false))?(?:\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*:\\s*(?:readonly|writable|off|true|false))?)*|exported\\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$]*)*)$`,
);
const tsLineOnlyDirective = /^@ts-(?:no)?check$/;
const tsCommentDirective = /^@ts-(?:expect-error|ignore)(?:$|[\s:])/;
const biomeDirective =
  /^biome-ignore(?:-all|-start|-end)?\s+(?:format|parse|(?:lint|assist)(?:\/[A-Za-z][A-Za-z0-9]*){0,2}(?:\([^()]+\))?):\s*\S/;
const fallowTarget =
  "(?:policy-violation:[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*|[a-z]+(?:-[a-z]+)+)";
const fallowDirective = new RegExp(
  `^fallow-ignore-(?:next-line|file)(?:\\s+${fallowTarget}(?:(?:\\s*,\\s*|\\s+)${fallowTarget})*)?(?:\\s+--\\s+\\S.*)?$`,
);

function isDirectiveComment(comment) {
  if (lineBreak.test(comment.value)) return false;
  const text = comment.value.trim();
  if (comment.type === "Line" && tsLineOnlyDirective.test(text)) return true;
  if (
    tsCommentDirective.test(text) ||
    biomeDirective.test(text) ||
    fallowDirective.test(text) ||
    eslintLineDirective.test(text)
  ) {
    return true;
  }
  return comment.type === "Block" && eslintBlockDirective.test(text);
}

export function isDirectiveBlock(block) {
  return block.every(isDirectiveComment);
}
