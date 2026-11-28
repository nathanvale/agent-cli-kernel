# Approval add-on glossary

This file holds the words of the approval add-on; `GLOSSARY-MAP.md` lists every glossary.

### Installation and add-ons

**Approval add-on**:
The add-on that checks authority before a command attempts its approved
effects.

**ApprovalRejection**:
The approval add-on's public error when authority storage, exclusive
coordination or confirmation of durable consumption prevents an approved effect
from starting. Its `reason` identifies the error and `consumed` distinguishes
an unconsumed refusal from a failure after grant consumption.
_Avoid_: refusal (for every ApprovalRejection, since some follow consumption)
