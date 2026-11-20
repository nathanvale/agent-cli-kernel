# Glossary map

Each word has one owner. Find the glossary that owns the word you need, and
use its word.

This repository's `GLOSSARY.md` is the source of truth for the kernel's words.
The template's glossary owns the template's words. A word that only the kernel
needs is added here and never to the template's glossary.

| Glossary        | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Kernel          | Every word that `GLOSSARY.md` defines outside its shared tool words: the kernel repository and its ancestry (Carry-out, Prepared parent, Carry-out identity, Kernel repository alignment, Recorded origin), installation (Pin, Pinned commit, Installed kernel, Kernel package, Add-on, the State, Programs, Approval and Diagnostics add-ons, Add-on selection, Add-on requirement, Kernel declaration), the words of verify-cli, and Fault timing | [GLOSSARY.md](GLOSSARY.md)                                                                                        |
| Template        | Words about creating and keeping repositories from the template: Template, Foundation, Bootstrap, Recipe, Recipe table, Generated repository, Pointer skill, Template version, Kernel split, Sibling repository, Kernel migration, Pin verification, Pin move, Pin move report, Kernel trial, Kernel lockfile, Kernel reader and Kernel seam. It also owns the shared tool words, which `GLOSSARY.md` here copies                                   | [GLOSSARY.md on the template's main](https://github.com/nathanvale/bun-typescript-template/blob/main/GLOSSARY.md) |
| Contract words  | No word. It is a dated copy of the names of Contract 3 terms from the Agent ecosystem glossary, with the patterns that the kernel's glossary test refuses in kernel files. Each pattern follows the glossary that owns its word                                                                                                                                                                                                                     | [tests/template/glossary/term-table.json](tests/template/glossary/term-table.json)                                |
| Agent ecosystem | Words shared across projects that no repository glossary defines yet: Kernel, Template provenance and Template upgrade among them. Private, so only its name and owner here                                                                                                                                                                                                                                                                         | "Agent ecosystem glossary (living)" in Linear. Owner: Engineering, through Linear MAG-64                          |
| Design words    | Module, Interface, Seam and Adapter, with Implementation, Depth, Leverage and Locality                                                                                                                                                                                                                                                                                                                                                              | The codebase-design skill, under "Glossary" in its `SKILL.md`. The skill is not in this repository                |

## Shared tool words

The tool words that both repositories carry (names check, recorded hit, gate and the rest of the section "Shared tool words") belong to the template. This
repository holds a copy, recorded in `tests/template/naming/shared-tool-words.txt` and
named by `glossary-ownership.json` with the template commit it came from. A test fails when
the section in `GLOSSARY.md` differs from that copy. Fault replay and Gate
note are worded here for both repositories; the template adopts them in its own
cleanup, and until then `glossary-ownership.json` lists them as rewritten here.

## Accepted transfer

This repository accepts the `glossary-split-20261120` transfer. The entries listed in
`glossary-ownership.json` are now owned here. The template's glossary defines
none of them. This rule replaces every older statement that the template's glossary is right where the
two differ.

Add-on selection lives only in a consuming repository's `installedAddons`.
An add-on requirement is declared in this repository's `package.json` as an
ordinary dependency.

Use **CLI kernel** in contributor guidance. Use **Command Contract 3** when
citing the frozen specification named in the [CLI kernel authority](docs/agents/cli-kernel.md).

## The skills the kernel package ships

The kernel package carries two skills: the author skill, `skills/agent-cli-kernel/`,
and verify-cli, `skills/verify-cli/`. A generated repository installs the
package at its Pin, which makes the installed kernel. Bootstrap then writes a
pointer skill (a template word) for each of them into the generated repository,
and each pointer sends the reader to the full skill under `node_modules/agent-cli-kernel/`.
The [author guide upkeep](docs/agents/author-guide.md) keeps the author skill's path.
