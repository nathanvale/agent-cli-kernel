// One owner for the shapes every kernel-repair test reuses (SF-3). No
// dependencies, so the materialised fixture tree can copy it unchanged.
export const emptyInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
export const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
