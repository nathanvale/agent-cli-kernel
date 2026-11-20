import type { CommandDeclaration } from "./declarations.ts";
const programStops = new WeakMap<CommandDeclaration, string>();
export function recordProgramStop(
  declaration: CommandDeclaration,
  cause: string,
): void {
  programStops.set(declaration, cause);
}
export function programStopOf(
  declaration: CommandDeclaration,
): string | undefined {
  return programStops.get(declaration);
}
