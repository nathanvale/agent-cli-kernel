# Agent CLI kernel glossary

This file holds the repository-wide words this repository owns: source and
ancestry, installation and add-on concepts, fault replay timings, and the
shared tool words copied from the template at a recorded revision. The
context glossaries listed in `GLOSSARY-MAP.md` hold the rest of the kernel's
words. The template's `GLOSSARY.md` owns the template's words, and
`GLOSSARY-MAP.md` names the glossary that owns every word.

The kernel repository's workflow at `.github/workflows/ci.yml` is named
**Hosted check**. Its job names provide the required status checks. In
`package.json`, `format:check` checks formatting and `format` writes it.

## Language

An `_Avoid_` line lists words not to use for its term. A note in parentheses
says when: it covers the words before it, back to the previous note or
semicolon. The writer and the reviewer hold those words, because the names
check cannot tell what a name means. The names check refuses a word with no note
after it in every file and folder name and public declaration name. It refuses a word noted
`(unqualified)` as a whole name only when
[Words that need a qualifier](#words-that-need-a-qualifier) also lists it.

### Source and ancestry

**Kernel repository**:
The repository that is the canonical owner of the kernel and add-on source and
of their tests.
_Avoid_: core repository, kernel package (for the repository: the package is what a consumer installs)

**Carry-out**:
The single commit that brought the kernel, the add-ons, their tests and the
files they need, unedited, into this repository. It is also called the
**carry-out commit**.
_Avoid_: the move (it does not say what moved), extraction, split commit

**Prepared parent**:
The commit directly before the carry-out commit: the only parent it has. It
holds the source as it stood when it was prepared for the carry-out.
_Avoid_: base commit, parent (unqualified)

**Carry-out identity**:
The full identity of the carry-out commit on this repository's main branch.
No pin may name an earlier commit.
_Avoid_: floor (unqualified), baseline

**Kernel repository alignment**:
This repository later adopting the tooling that was carried with it, while it
stays the kernel's own source and uses no installed copy of itself.
_Avoid_: Template upgrade (for alignment)

**Recorded origin**:
The repository and the full commit this repository's source was carried from,
kept as a label for people. Tools check only its shape; no gate decides
anything else from it.
_Avoid_: citable origins, cited-commit list (for a recorded origin)

### Installation and add-ons

**Pin**:
A record of the kernel repository and one full commit in it. That commit
identifies the kernel; a pin has no version number. Say kernel pin wherever a
toolchain pin could be meant.
_Avoid_: version, release (for a kernel pin), pointer (say pin), pin record (say pin), lock (for a pin)

**Pinned commit**:
The one full commit that a pin names.
_Avoid_: tag, branch, short hash (for a pinned commit)

**Installed kernel**:
The kernel as a consuming repository holds it: installed as a package at a
pin, imported by its package name, with none of its source owned there.
_Avoid_: vendored kernel, kernel copy (for the installed kernel)

**Kernel package**:
What a consuming repository installs at a pin: the kernel, its add-ons, the
kernel's lint and the skills it ships. It is named `agent-cli-kernel`.

**Author skill**:
The guidance the kernel package ships for an agent writing and testing
commands on the kernel.
_Avoid_: author guide (for the shipped guidance)

**Add-on**:
An optional capability that uses the kernel's public interface without
importing or patching another add-on, and may have a required add-on that must
be selected alongside it. The five are the state, programs, approval,
diagnostics and menu add-ons.

**Add-on selection**:
The add-ons one consuming repository uses. The kernel is always used and is not
part of the selection.
_Avoid_: starter, profile, variant (for an add-on selection)

**Add-on requirement**:
A package an add-on needs in order to run, which the kernel carries as an
ordinary dependency. The diagnostics add-on's logging packages are add-on
requirements.
_Avoid_: optional peer (for an add-on requirement); dependency (unqualified)

**Required add-on**:
An add-on that another selected add-on needs alongside it. The state add-on
is a required add-on of the approval add-on.
_Avoid_: add-on prerequisite; add-on requirement (for another add-on, rather than a package)

**Kernel declaration**:
The kernel repository's own statement, read at one commit, of its kernel and
add-on folders and of the add-ons each add-on requires.
_Avoid_: manifest (for a kernel declaration), hand-kept list

### Fault replay timings

**Fault timing**:
The seconds one planted fault took to replay, kept in its own file beside
the fault records. Fault replay's shard planner balances its parts by them,
and counts a fault with no timing as a short one.

**UNPARSED**:
The fault replay verdict for a planted fault whose patch leaves a patched code
or JSON file unparseable, so no test can catch it for its planted reason. It is
never KILLED, and the replay exits non-zero. Repair: re-plant the fault so the
patched file parses.

**UNMATCHED**:
The fault replay verdict for a planted fault whose faulted run fails, but no
failing test's name matches the fault record's `title` (a test file that did
not load counts as no match). It is never KILLED, and the replay exits non-zero.
Repair: re-plant the fault so a test matching the record's title fails, or
update the record's title.

### Shared tool words

**Toolchain pin**:
The one Bun version a repository runs on. Its doctor fails when the running Bun is
another version.

**Check command**:
The one command a repository runs to show that it is sound. The template, the
kernel repository and every generated repository each have their own.
_Avoid_: check (unqualified)

**Hosted check**:
A repository's check command and gates as its forge runs them on pull requests
and pushes.
The template's pull-request workflow is named `Hosted check`.
_Avoid_: CI (unqualified)

**Gate**:
A required validation that can refuse a change before it lands in a repository.
_Avoid_: proof, admission, guard (for a gate), check (unqualified)

**Test surface**:
An Interface that tests drive the way a caller does.
_Avoid_: test seam (a Seam is where behaviour can vary; nothing varies at a test surface)

**Test area**:
A named set of tests that runs on its own.

**Process runner**:
The module that starts a child process for a script or test, in its own process
group and under an optional time limit.

**Negative control**:
A break made on purpose to show that a test or gate can fail. It can be made once by
hand, or kept.
_Avoid_: mutation; canary (for a negative control)

**Planted fault**:
A negative control kept as a patch, which the test named in its fault record
must keep catching.
_Avoid_: mutant, mutation; canary (for a planted fault)

**Fault record**:
The entry that names a planted fault, the test that must catch it, and the
commit it undoes.

**Fault replay**:
A run that applies each selected planted fault's patch in a temporary worktree,
where its named test must pass without the patch and fail with it.

**Anchor**:
The text that places one changed region of a planted fault's patch: the lines the
region removes or, when it only adds lines, the unchanged lines next to it.

**Recorded hit**:
A violation that already existed when its gate landed. The record gives its
reason and lets the gate pass until a commit fixes it.
_Avoid_: known hit, allowlist, baseline

**Refusal**:
A tool declining to act before it changes anything. Its message names the
cause and the repair.
_Avoid_: rejection (for a refusal)

**Repair**:
The next step a failure message tells the reader to take.
_Avoid_: fix (for the step; a fix is a commit)

**Verdict**:
The result of judging one thing once: one planted fault in a fault replay, or
one commit at the per-commit gate.

**Doctor**:
The command that checks, before work starts, that a checkout can run the
repository's check command and gates, and names a repair for each failure.

**Toolchain**:
The tools a repository's check command and gates use, at the accepted versions:
Bun, the linter, the compiler and the dead-code tool.
Run `format:check` to check formatting without writing, and `format` to write it.

**Lint rule**:
One rule the linter enforces on code, with a message that names its repair. A
lint rule can be the gate of a rule row.
_Avoid_: rule (unqualified)

**Names check**:
The check that holds every tracked file and folder name to the glossary's
words, and applies the same rules to public declarations through the symbol gate.
_Avoid_: names gate (for the names check)

**Symbol gate**:
The part of the names check that applies the glossary's Avoid and Qualify rules
to public declaration names. Its refusal gives the file, line, name, rule and repair.

**Public surface**:
The per-repository file selection the symbol gate reads. The template selects
exports in Bootstrap's copied code and consumed exports in `src/*.ts`.
The kernel selects its package entry points.

**Public declaration**:
An exported name on the public surface, including immediate public members,
parameters and return properties. Private members, locals and nested members
are outside it. A recorded hit names its file and declaration independently of
line numbers, for example `CommandResult.proof` in its `declaration` field.

**Repo gardener**:
The role that keeps the rule table and the names true. Its four jobs are Sow,
Gate, Weed and Stake.
_Avoid_: steward, janitor

**Sow**:
The repo gardener's job of recording the lesson of a correction or review
finding beside its witness.

**Weed**:
The repo gardener's job of removing a rule row, guide bullet, link definition
or reference that nothing uses any more.
_Avoid_: clean up, prune

**Stake**:
The repo gardener's job of holding a file or folder name to the glossary's
words.

**Rule row**:
One coding standard in the rule table, with what enforces it today.

**Witness**:
A commit or review thread that shows a mistake: the commit that fixed it, the
review thread that caught it, or a commit that carries it.

**Gate note**:
The note, kept in a repository's standards, that says what a rule row's gates
refuse and where, what stays with the reviewer, and which witnesses taught it.

**Citable origins**:
The repositories, other than a repository itself, whose commits and review
threads a citation in that repository's standards may name.
_Avoid_: recorded origin (that is one repository and one commit), allowed hosts

**Claim tag**:
The mark on a claim in a plan that says how sure it is: passed on Linux,
passed on macOS only, designed and not run, decided by Nathan, or open.
_Avoid_: confidence, status (for a claim tag), proven (for a prototype run)

## Words that need a qualifier

Each of these words names different things in different projects. In the name
of a file, a folder, a test, a commit or a public declaration, pair it with a word that says which
one you mean, as `test-proof` does.

_Qualify_: host, project, starter, profile, proof, manifest, probe, copy, dependency, reader, checker, migration, parent, floor, owner, guard, layout
