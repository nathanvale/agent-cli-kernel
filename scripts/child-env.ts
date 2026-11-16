import { basename, delimiter, dirname } from "node:path";

// `bun run` prepends the caller's node_modules/.bin folders to PATH. Drop
// them so a child process sees only what its own tree installs.
export const ownTools = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(delimiter)
    .filter(
      (entry) =>
        basename(entry) !== ".bin" ||
        basename(dirname(entry)) !== "node_modules",
    )
    .join(delimiter),
};
