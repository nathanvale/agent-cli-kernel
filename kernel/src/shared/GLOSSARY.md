# Shared kernel modules glossary

This file holds the words of the shared kernel modules; `GLOSSARY-MAP.md` lists every glossary.

### Internal kernel names

**Rooted file**:
A path derived or given from outside under a folder root, read with
`readRootedFile` from `agent-cli-kernel/rooted-file` (implemented in
`kernel/src/shared/rooted-file.ts`). It reads regular files inside the
resolved root up to a byte limit, and refuses paths with a `..` segment
(`parent-step`), paths outside the root, symbolic links, linked folders, hard
links, non-regular files, over-limit files and post-open swaps, returning a
`RootedRefusal` whose message ends with a `Repair:` line.
_Avoid_: safe path, guard (unqualified), helper (for a rooted-file module)

**RootedFileResult**:
What `readRootedFile` returns: `{ kind: "read", bytes, facts }` for a file it
read, `{ kind: "missing" }` when the path does not exist, or a
`RootedRefusal`. Exported from `agent-cli-kernel/rooted-file`.

**XDG base folder**:
A user-scoped base folder for config, data, state, cache or runtime files,
resolved with `xdgBaseFolder` from `agent-cli-kernel/xdg-base` (implemented in
`kernel/src/shared/xdg-base.ts`).
