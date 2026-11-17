self.onmessage = (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (
    typeof value !== "object" ||
    value === null ||
    !("pattern" in value) ||
    !("input" in value) ||
    typeof value.pattern !== "string" ||
    (value.input !== null && typeof value.input !== "string")
  ) {
    self.postMessage("invalid");
    return;
  }
  try {
    const pattern = new RegExp(`^(?:${value.pattern})$`, "u");
    self.postMessage(
      value.input === null || pattern.test(value.input) ? "match" : "mismatch",
    );
  } catch {
    self.postMessage("invalid");
  }
};
