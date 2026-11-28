# Kernel runtime glossary

This file holds the words of the kernel runtime; `GLOSSARY-MAP.md` lists every glossary.

### Command results

**Repair action**:
The fixed repair guidance a station declares for Command Contract 3's
`repairAction` field. It is `null` on success and otherwise explains the
repair or the named handoff.
_Avoid_: Repair (for a station's guidance; Repair names a tool message's Repair: line)

**Kernel station**:
A station the kernel adds to a command without an author declaration, covering
usage refusals and internal failures.
_Avoid_: built-in station (for a kernel station)

**Full discovery**:
`--discover-all`: every command's `--discover-command` data, less station prose.

### Interactive runs

**Default command**:
The one ordinary command a CLI names, with `defaultCommand`, to run when no
words are typed after its name in an interactive run.
_Avoid_: bare-name command; root command (a root operation is Command Contract 3's route-`[]` command, which this is not); front door (in a name)

**Interactive run**:
A run that has a terminal adapter (in a process: both stdin and stdout are
terminals) and whose typed words hold no `--json`.
_Avoid_: terminal run

**Terminal adapter**:
The kernel's seam for reading keys from and drawing on a terminal: the
`/dev/tty` adapter in a process, or `scriptedTerminal` in tests.

### CLI source layout

**Subject**:
The domain noun a group of commands acts on, named by the first word of their
route.
_Avoid_: feature (for a subject), resource (a resource is a state add-on coordination lock target), domain (for a subject), slice, topic

**Shared edge**:
A module in `src/shared/` used across subjects that touches external state,
settings, child programs or the CLI's shared cause table, or holds logic those
subjects share that cannot live in one subject's `rules.ts`.
_Avoid_: util, helper, common, core (for a shared edge)

### Internal kernel names

**Directive**:
A comment a tool reads as an instruction rather than as prose, in that tool's
exact form: `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`,
`eslint-enable`, `@ts-expect-error`, `@ts-ignore`, line-only `@ts-nocheck` or
`@ts-check`, `biome-ignore` (`-all`, `-start`, `-end`),
`fallow-ignore-next-line` or `fallow-ignore-file`. The comment rule admits a
comment as a directive only when it is one in that form; prose after a
directive-looking word is refused.
_Avoid_: pragma, annotation (for a directive)

**Contract boundary**:
The public set of authority identity, resource identity and absolute path
constructors exposed as `contractFor().boundary`. Their values carry the
kernel's validated identity and path types into a command's code.

**Names check result**:
The names check's `NamesCheckResult`: stderr text and a numeric process exit
code. It is a script result, separate from Command Contract 3's Outcome.

**Validate inspect shape**:
`validateInspectShape` checks an inspect command declaration's fields before
construction or registration. It does not admit a command for a run.

**Validate changing shape**:
`validateChangingShape` checks a changing command declaration's fields before
construction or registration. It does not admit a command for a run.

**Lock probe**:
A compiler input used by the kernel's lock tests to check a type constraint
with the native and lint-view compilers. `lock-probes.ts` owns their batch
runner. This is separate from verify-cli's Probe of a target CLI.
