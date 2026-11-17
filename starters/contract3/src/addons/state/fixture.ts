// LABELLED TEST-ONLY ENTRY. Host source never imports this module; the
// repository lint configuration bans every state add-on import except
// index.ts outside this folder and tests (T7 renders the same ban for
// generated hosts). It exposes the two test seams of the implementation:
// a fixture qualification that supplies the stopped-owner condition, and
// the observation hook at frozen add-on-internal transitions, and a C library
// name that makes the Linux coordination route's self-check fail. A fixture pass
// never enables a capability (Q01): capabilities() reports the proof as
// fixture-only, and every closure it enables is stamped `fixture:<label>`.
import { install } from "./install.ts";
import type { Phase, StateOptions } from "./install.ts";
import { resolveCoordination } from "./coordination.ts";
import { resolveQualification } from "./qualification.ts";

export type { Phase } from "./install.ts";

export function stateAddonWithTestSeams(
  options: StateOptions,
  seams: {
    // Present: a labelled fixture qualification. Absent: production default.
    readonly fixtureLabel?: string;
    readonly phase?: (name: Phase) => Promise<void>;
    // Present: the Linux route with this C library (any platform). Absent:
    // the production route for this platform.
    readonly coordinationLibrary?: string;
  },
) {
  return install(options, {
    qualification:
      seams.fixtureLabel === undefined
        ? resolveQualification()
        : {
            label: `fixture:${seams.fixtureLabel}`,
            source: "fixture",
            stoppedOwner: "lease-and-no-delegate",
          },
    phase: seams.phase ?? (() => Promise.resolve()),
    coordination: resolveCoordination(seams.coordinationLibrary),
  });
}
