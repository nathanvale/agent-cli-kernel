// State add-on public entry (CMD-10a to CMD-13a, REC-1 to REC-10). The only
// module of this add-on that host code imports. It fixes the production
// seams: the reviewed qualification table (empty in the foundation), the
// platform's coordination route after its start-up self-check, and no
// observation hook. Test seams live only in the labelled fixture.ts.
//
// Interface for a host:
// - stateAddon(options) installs once and returns:
//   - descriptor: give it to contractFor({ state }) and to approval runtime().
//   - emergencyRecord: give it to runProcess(contract, { emergencyRecord }).
//   - transaction(ctx.state, declaration, work): the only way a changing
//     handler opens its transaction. Scope comes from validated input and
//     is canonicalised before any coordination. Returns the transaction
//     proof plus what happened: ran, or one refusal kind.
//   - close(ctx.state, request): the recovery command's closure transaction.
//   - report() and history(operationId): read-only data for the host's
//     ifNoResult and case-history inspect commands.
//   - capabilities(): which gated capabilities are available, and why not.
import { install } from "./install.ts";
import type { StateOptions } from "./install.ts";
import { resolveCoordination } from "./coordination.ts";
import { resolveQualification } from "./qualification.ts";

export type {
  CloseOutcome,
  CloseRequest,
  Declaration,
  Disposition,
  HistoryData,
  HistoryResult,
  Observation,
  Observer,
  RecoveryClass,
  Refusal,
  ReportResult,
  ScopeDeclaration,
  StateOptions,
  TransactionOutcome,
  UnfinishedEntry,
} from "./install.ts";
export type { CapabilityReport } from "./qualification.ts";

export function stateAddon(options: StateOptions) {
  return install(options, {
    qualification: resolveQualification(),
    coordination: resolveCoordination(),
    phase: () => Promise.resolve(),
  });
}
