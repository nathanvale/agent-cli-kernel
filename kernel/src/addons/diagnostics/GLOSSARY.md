# Diagnostics add-on glossary

This file holds the words of the diagnostics add-on; `GLOSSARY-MAP.md` lists every glossary.

### Installation and add-ons

**Diagnostics add-on**:
The add-on that owns the diagnostic records of a run and their custody.

### Internal kernel names

**Diagnostics add-on**:
The optional diagnostics capability. `DiagnosticsAddon` is its public type;
`DiagnosticsAttached` is the attachment to one run, including its bounded
`freeze` operation. `StatusAddon` and `StatusAttached` remain exported as
deprecated aliases of those types under accepted decision N11.
