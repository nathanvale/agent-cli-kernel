# Agent CLI kernel

The kernel repository: the canonical owner of the CLI kernel, its four
add-ons (approval, diagnostics, programs and state) and their tests.

It was carried from
[bun-typescript-template](https://github.com/nathanvale/bun-typescript-template)
with that repository's full history. `repository.json` records the template
commit it was carried from.

## Layout

| Path              | Holds                                                         |
| ----------------- | ------------------------------------------------------------- |
| `kernel/`         | The kernel, the add-ons, their lint files and the declaration |
| `tests/kernel/`   | The kernel's tests                                            |
| `scripts/`        | The gate tools                                                |
| `tests/template/` | The gate tools' tests                                         |

## Checks

```sh
bun install --frozen-lockfile
bun run check
```

This repository uses Bun 1.4.4, TypeScript 7.1.0-beta for compilation,
TypeScript 6.0.2 for ESLint 10.15.0 with typescript-eslint 8.73.0, Biome 2.6.7
for formatting only, and native Fallow plus its semantic companion at 3.43.2.
Formatting checks never rewrite files.

Agents start at [AGENTS.md](AGENTS.md).
