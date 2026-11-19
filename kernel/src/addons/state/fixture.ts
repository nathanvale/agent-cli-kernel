import { install } from "./install.ts";
import type { Phase, StateOptions } from "./install.ts";
import { resolveCoordination } from "./coordination.ts";
import type { CoordinationRoute } from "./coordination.ts";
import type { CapabilityQualificationRow } from "./capability-qualification-table.ts";
import {
  candidateQualification,
  machineBootIdentity,
  resolveQualification,
} from "./qualification.ts";
import type { FactOverrides, Match, Qualification } from "./qualification.ts";

export type { Phase } from "./install.ts";
export type { CapabilityQualificationRow } from "./capability-qualification-table.ts";
export type { FactOverrides } from "./qualification.ts";

// Interface: every closure a candidate row enables is stamped
// `fixture:<label>`, and neither seam reads or writes the production
// capability qualification table.
export type QualificationSeams =
  | {
      readonly fixtureLabel?: string;
      readonly candidateRow?: undefined;
      readonly factOverrides?: undefined;
    }
  | {
      readonly fixtureLabel: string;
      readonly candidateRow: CapabilityQualificationRow;
      readonly factOverrides?: FactOverrides;
    };

function fixtureQualification(seams: QualificationSeams): Qualification {
  const label = seams.fixtureLabel;
  if (label === undefined) return resolveQualification();
  if (seams.candidateRow !== undefined)
    return candidateQualification(
      label,
      seams.candidateRow,
      seams.factOverrides ?? {},
    );
  const matched = (): Match => ({
    matched: true,
    label: `fixture:${label}`,
    bootIdentity: machineBootIdentity(),
  });
  return Object.freeze({
    source: "fixture",
    match: matched,
    bootIdentity: machineBootIdentity,
  });
}

export function stateAddonWithTestSeams(
  options: StateOptions,
  seams: QualificationSeams & {
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
    qualification: fixtureQualification(seams),
    phase: seams.phase ?? (() => Promise.resolve()),
    coordination:
      seams.coordination ?? resolveCoordination(seams.coordinationLibrary),
  });
}
