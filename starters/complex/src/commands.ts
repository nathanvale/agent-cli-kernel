import type { CommandDefinition } from "./commands-contract.ts";
import { stationsFor } from "./branch-station-catalog.ts";

export const commands: CommandDefinition[] = [
  {
    commandIdentity: "example.status",
    effectClass: "inspect",
    route: ["status"],
    summary: "Inspect current state.",
    execute: async (args) =>
      (await import("./domains/state.ts")).execute("status", args),
    stations: () => stationsFor("example.status"),
  },
  {
    commandIdentity: "example.set",
    effectClass: "repository-local",
    route: ["set"],
    summary: "Preview or apply a local state change.",
    execute: async (args) =>
      (await import("./domains/state.ts")).execute("set", args),
    stations: () => stationsFor("example.set"),
  },
  {
    commandIdentity: "example.recover",
    effectClass: "inspect",
    route: ["recover"],
    summary: "Inspect an interrupted state change without replaying it.",
    execute: async (args) =>
      (await import("./domains/state.ts")).execute("recover", args),
    stations: () => stationsFor("example.recover"),
  },
];
