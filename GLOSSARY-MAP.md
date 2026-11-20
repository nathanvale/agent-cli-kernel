# Glossary map

Each word has one owner. Find the glossary that owns the word you need, and
use its word.

The template's `GLOSSARY.md` is the source of truth for every word it
defines. This repository's `GLOSSARY.md` is the copy carried from the
template, and the names check here reads it. Where the two differ, the
template's is right and this copy is out of date.

| Glossary        | Owns                                                                                                                                                                                                                                                           | Where                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template        | Every word that `GLOSSARY.md` defines: recipes, the kernel split with its pin, the installed kernel and the kernel lockfile, the checks carried with the gate tools, the repo gardener's words, and the words Template, Foundation, Add-on and Recorded origin | [GLOSSARY.md on the template's main](https://github.com/nathanvale/bun-typescript-template/blob/main/GLOSSARY.md). The copy here is [GLOSSARY.md](GLOSSARY.md) |
| Kernel          | No word. It is a dated copy of the names of Contract 3 terms from the Agent ecosystem glossary, with the patterns that the kernel's glossary test refuses in kernel files                                                                                      | [tests/template/glossary/term-table.json](tests/template/glossary/term-table.json)                                                                             |
| Agent ecosystem | Words shared across projects that no repository glossary defines yet: Kernel, Bootstrap, Repository profile, Template provenance and Template upgrade among them. Private, so only its name and owner here                                                     | "Agent ecosystem glossary (living)" in Linear. Owner: Engineering, through Linear MAG-64                                                                       |
| Design words    | Module, Interface, Seam and Adapter, with Implementation, Depth, Leverage and Locality                                                                                                                                                                         | The codebase-design skill, under "Glossary" in its `SKILL.md`. The skill is not in this repository                                                             |

Add-on selection lives only in a generated repository's `installedAddons`.
Template provenance holds no add-on list.

Use **CLI kernel** in contributor guidance. Use **Command Contract 3** when
citing the frozen specification named in the [CLI kernel authority](docs/agents/cli-kernel.md).
