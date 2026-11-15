import type { CommandDeclaration } from "../declarations.ts";
import type { DeclaredStation } from "../stations.ts";
import type {
  CauseTable,
  Envelope,
  ResultFor,
  Validation,
  WireResult,
} from "../types.ts";
import { templatesAgree } from "../guidance.ts";
import { parseInput } from "../input.ts";
import { diagnostics } from "./diagnostics.ts";
import { json, record } from "./primitives.ts";
import { envelopeShape, typedResult } from "./result.ts";
import { classifyVersion } from "./version.ts";
function declaredEnvelope<C extends CauseTable>(
  value: unknown,
  causes: C,
): value is Envelope<ResultFor<C>> {
  return (
    envelopeShape(value) &&
    typedResult(value.result, causes) &&
    (value.diagnostics === undefined || diagnostics(value.diagnostics))
  );
}
async function commandSteps(
  result: WireResult,
  commands: readonly CommandDeclaration[],
): Promise<boolean> {
  const steps = result.next ? [result.next] : (result.handoff?.inspect ?? []);
  for (const step of steps) {
    if (step.kind !== "command") continue;
    const command = commands.find(
      (item) => item.commandIdentity === step.command,
    );
    if (
      !command ||
      (result.handoff !== undefined && command.effectClass !== "inspect")
    )
      return false;
    if (!(await parseInput(command.input, step.args)).ok) return false;
  }
  return true;
}
function stationMatches(
  result: WireResult,
  station: DeclaredStation,
  commands: readonly CommandDeclaration[],
): boolean {
  const policy = station.retryDelayPolicy;
  if (
    policy.kind === "bounded" &&
    (result.retryDelayMilliseconds === undefined ||
      result.retryDelayMilliseconds < policy.minimumMilliseconds ||
      result.retryDelayMilliseconds > policy.maximumMilliseconds)
  )
    return false;
  return templatesAgree(
    station,
    result,
    commands.flatMap((item) => item.route),
  );
}
export async function validateEnvelope<C extends CauseTable>(
  value: unknown,
  causes: C,
  commands: readonly CommandDeclaration[],
  stations: ReadonlyMap<string, readonly DeclaredStation[]>,
): Promise<Validation<Envelope<ResultFor<C>>>> {
  const reject = (path: string, reason: string): Validation<never> => ({
    ok: false,
    path,
    reason,
  });
  try {
    const descriptor = record(value)
      ? Object.getOwnPropertyDescriptor(value, "contractVersion")
      : undefined;
    const observed: unknown = descriptor?.value;
    const version = classifyVersion(observed);
    if (version !== "accepted") return reject("contractVersion", version);
    if (!json(value)) return reject("$", "not plain bounded JSON");
    if (!declaredEnvelope(value, causes))
      return reject("$", "invalid envelope shape or correlation");
    const command = commands.find(
      (item) => item.commandIdentity === value.result.commandIdentity,
    );
    const station = stations
      .get(value.result.commandIdentity)
      ?.find((item) => item.causeCode === value.result.causeCode);
    if (
      !command ||
      !station ||
      command.effectClass !== value.result.effectClass
    )
      return reject("result", "undeclared command, station or effect class");
    if (
      value.availablePaths.some(
        (identity) =>
          !commands.some((item) => item.commandIdentity === identity),
      )
    )
      return reject("availablePaths", "undeclared identity");
    if (!stationMatches(value.result, station, commands))
      return reject("result", "station guidance or delay mismatch");
    if (!(await commandSteps(value.result, commands)))
      return reject("result", "invalid command step");
    return { ok: true, value };
  } catch {
    return reject("$", "unreadable external value");
  }
}
