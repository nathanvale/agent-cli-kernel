const lineDirective =
  /^(?:eslint-disable(?:-next)?-line|biome-ignore(?:-all|-start|-end)?|fallow-ignore(?:-next-line|-file)?)(?:\s|$)|^@ts-(?:expect-error|ignore|nocheck|check)(?:$|[\s:])/;
const blockDirective =
  /^(?:eslint(?:-disable|-enable)?|globals?|exported)(?:\s|$)/;

function isDirectiveComment(comment) {
  const text = comment.value.trim();
  if (/[\r\n]/.test(text)) return false;
  return (
    lineDirective.test(text) ||
    (comment.type === "Block" && blockDirective.test(text))
  );
}

export function isDirectiveBlock(block) {
  return block.every(isDirectiveComment);
}
