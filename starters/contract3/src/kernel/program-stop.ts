// The station the kernel selects when the deadline passed and an owned
// program was not confirmed stopped (accepted decisions of 17:06 and 17:24,
// form H): command()'s `programStopCause`, kept here rather than on
// CommandDeclaration, or a raw declaration's own `programStopCause` string.
const programStops = new WeakMap<object, string>();
export function recordProgramStop(declaration: object, cause: string): void {
  programStops.set(declaration, cause);
}
export function programStopOf(declaration: object): string | undefined {
  const own: unknown = Reflect.get(declaration, "programStopCause");
  return (
    programStops.get(declaration) ?? (typeof own === "string" ? own : undefined)
  );
}
