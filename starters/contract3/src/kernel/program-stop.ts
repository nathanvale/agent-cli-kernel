// The station the kernel selects when the deadline passed and an owned
// program was not confirmed stopped (accepted decisions of 17:06 and 17:24,
// form H): command()'s `programStopCause`, kept here rather than on
// CommandDeclaration. A raw declaration has none (contractFor refuses one
// that would need it).
const programStops = new WeakMap<object, string>();
export function recordProgramStop(declaration: object, cause: string): void {
  programStops.set(declaration, cause);
}
export function programStopOf(declaration: object): string | undefined {
  return programStops.get(declaration);
}
