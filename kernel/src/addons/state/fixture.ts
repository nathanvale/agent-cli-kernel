import { install } from "./install.ts";
import type { Phase, StateOptions } from "./install.ts";
import { resolveCoordination } from "./coordination.ts";
import type { CoordinationRoute } from "./coordination.ts";
import { resolveQualification } from "./qualification.ts";

export type { Phase } from "./install.ts";

export function stateAddonWithTestSeams(
  options: StateOptions,
  seams: {
    readonly fixtureLabel?: string;
    readonly phase?: (name: Phase) => Promise<void>;
    readonly coordinationLibrary?: string;
    readonly coordination?: CoordinationRoute;
    readonly moverStart?: number;
    readonly moverReport?: (examined: number, moved: number) => void;
  },
) {
  const start = seams.moverStart;
  return install(options, {
    ...(start === undefined ? {} : { moverStart: () => start }),
    ...(seams.moverReport === undefined
      ? {}
      : { moverReport: seams.moverReport }),
    qualification:
      seams.fixtureLabel === undefined
        ? resolveQualification()
        : {
            label: `fixture:${seams.fixtureLabel}`,
            source: "fixture",
            stoppedOwner: "lease-and-no-delegate",
          },
    phase: seams.phase ?? (() => Promise.resolve()),
    coordination:
      seams.coordination ?? resolveCoordination(seams.coordinationLibrary),
  });
}
