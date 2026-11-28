# State add-on glossary

This file holds the words of the state add-on; `GLOSSARY-MAP.md` lists every glossary.

### Installation and add-ons

**State add-on**:
The add-on that owns the journal and the state a changing command works in.

**Journal**:
The state add-on's record of each changing command's intent, events and close, kept in the state root.

**Case**:
One changing command's entry in the journal, from intent to close.

**Unresolved case**:
A case with no close; it blocks later changes to the same resources until it is closed or superseded.

**supersedeUnresolved**:
A changing command's promise that it is safe to run again, even alongside a
leftover copy of a program an earlier run started; with it, the next run of
the same kernel command whose declared resources cover the dead case's
declared resources closes that unresolved case as outcome unknown and names
it in its result as superseded.
_Avoid_: retry, force, reclaim (for supersedeUnresolved)
