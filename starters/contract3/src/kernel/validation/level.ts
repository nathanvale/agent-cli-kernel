// One nesting rule for both writer limits (LIFE-7 step 2 at 64, LIFE-9 step 3
// at 8), as bound by Nathan on 16 November 2026 (B2): the root value is level
// 0, every value inside a container is one level deeper, scalars count, and a
// value above the limit is rejected.
export const rootLevel = 0;
export function childLevel(level: number): number {
  return level + 1;
}
export function withinLevel(level: number, limit: number): boolean {
  return level <= limit;
}
export const resultLevelLimit = 64;
export const fallbackLevelLimit = 8;
