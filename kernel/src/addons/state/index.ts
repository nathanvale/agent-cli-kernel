// Interface: a host uses these.
// - stateAddon(options) creates one state add-on instance and returns:
//   - descriptor: give it to contractFor({ state }) and to approval runtime().
//   - emergencyRecord: give it to runProcess or runInProcess, as
//     (contract, { emergencyRecord }).
//   - transaction(ctx.state, declaration, work): the only way a changing
//     handler opens its transaction. Scope comes from validated input and
//     is canonicalised before any coordination. `work` is handed the
//     transaction and the published operation's identity, before any effect
//     runs. Returns the transaction proof plus what happened: ran, or one
//     refusal kind.
//   - close(ctx.state, request): the recovery command's closure transaction.
//   - report() and history(operationId): read-only data for the host's
//     ifNoResult and case-history inspect commands.
//   - capabilities(): which gated capabilities are available, and why not.
// - The first changing command upgrades the state root to journal version 2,
//   one way: a version 1 program then refuses every route on it, its report
//   included. Every version 1 process that used the root must have exited
//   before a version 2 program first runs a changing command there; replacing
//   the installed programs is not enough. The add-on cannot detect such a
//   process (journal version 2 design part 1 section 3).
import { install } from "./install.ts";
import type { StateOptions } from "./install.ts";
import { resolveCoordination } from "./coordination.ts";
import { resolveQualification } from "./qualification.ts";

export type {
  CloseResult,
  CloseRequest,
  Declaration,
  Disposition,
  HistoryData,
  HistoryResult,
  Observation,
  Observer,
  PublishedOperation,
  RecoveryClass,
  Refusal,
  ReportResult,
  ScopeDeclaration,
  StateOptions,
  TransactionResult,
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
