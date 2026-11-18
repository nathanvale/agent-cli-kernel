# Glossary map

Each word has one owner. Find the glossary that owns the word you need, and
use its word.

This repository's `GLOSSARY.md` is the source of truth for every word it
defines. No other glossary defines those words. Where another glossary still
shows one of them, `GLOSSARY.md` is right and the other copy is out of date.

| Glossary        | Owns                                                                                                                                                                                                                    | Where                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| This repository | Every word that `GLOSSARY.md` defines: recipes, the kernel split with its pin and its stamp, the template's own checks, the repo gardener's words, and the shared words Template, Foundation, Stamped source and Add-on | [GLOSSARY.md](GLOSSARY.md)                                                                         |
| Kernel          | No word. It is a dated copy of the names of Contract 3 terms from the Agent ecosystem glossary, with the patterns that the kernel's glossary test refuses in kernel files                                               | [tests/template/glossary/term-table.json](tests/template/glossary/term-table.json)                 |
| Agent ecosystem | Words shared across projects that no repository glossary defines yet: Kernel, Bootstrap, Repository profile, Template provenance and Template upgrade among them. Private, so only its name and owner here              | "Agent ecosystem glossary (living)" in Linear. Owner: Engineering, through Linear MAG-64           |
| Design words    | Module, Interface, Seam and Adapter, with Implementation, Depth, Leverage and Locality                                                                                                                                  | The codebase-design skill, under "Glossary" in its `SKILL.md`. The skill is not in this repository |

Use **CLI kernel** in contributor guidance. Use **Command Contract 3** when
citing the frozen specification named in the [CLI kernel authority](docs/agents/cli-kernel.md).

The kernel's term table leaves this repository with the kernel. When it does,
remove its row.
