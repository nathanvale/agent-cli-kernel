# Bun TypeScript Template glossary

The words this repository owns: the recipe that Bootstrap follows, and the
checks that keep its own code honest. `GLOSSARY-MAP.md` names the glossaries
that own every other word, Bootstrap among them.

## Language

### Creating a repository

**Recipe**:
One row that says which folders Bootstrap copies for one request.

### Checks

**Test area**:
A named set of tests that runs on its own.

**Process runner**:
The template's one way for its scripts, and the tests that judge them, to
start a child process.

**Planted fault**:
A deliberate break in a guard, kept as a patch, that a named test must catch.
_Avoid_: mutant, mutation

**Fault record**:
The entry that names a planted fault, the test that must catch it, and the fix
it undoes.

**Fault replay**:
A run that applies each planted fault to a clean copy of the repository and
confirms that its named test fails.

**Recorded hit**:
A violation that existed when a check landed, listed so that the check passes
until someone fixes it. The list only shrinks.
_Avoid_: known hit, allowlist, baseline

### Keeping the rules

**Repo gardener**:
The role that keeps the rule table and the names true. Its four jobs are Sow,
Gate, Weed and Stake.
_Avoid_: steward, janitor

**Sow**:
Record the lesson of a correction or a review finding beside its witness. A
lesson seen twice grows into a rule.

**Weed**:
Remove a rule, guide bullet, link definition or pointer that nothing uses any
more, after finding out why it was added.
_Avoid_: clean up, prune

**Stake**:
Hold a file or folder name to the glossary's words: rename it, give its word
an owner, or record the hit with its reason.

## Words that need a qualifier

Each of these words names different things in different projects. In the name
of a file, a folder, a test or a commit, pair it with a word that says which
one you mean, as `repository-profile` does.

_Qualify_: host, project, starter, profile, proof, manifest, probe
