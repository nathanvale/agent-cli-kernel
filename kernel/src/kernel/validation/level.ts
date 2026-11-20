export const rootLevel = 0;
export function childLevel(level: number): number {
  return level + 1;
}
export function withinLevel(level: number, limit: number): boolean {
  return level <= limit;
}
export const resultLevelLimit = 64;
export const fallbackLevelLimit = 8;
