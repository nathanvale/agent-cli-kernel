import type { CommandDeclaration } from "../declarations.ts";
import type { DeclaredStation } from "../stations.ts";
import type {
  CauseTable,
  Envelope,
  ResultFor,
  Validation,
  WireResult,
} from "../types.ts";
import { guidanceTemplatesAgree } from "../guidance.ts";
import { acceptsRootInput, parseInput } from "../input.ts";
import { json, record } from "./primitives.ts";
import { envelopeShape, typedResult } from "./result.ts";
import { classifyVersion } from "./version.ts";
import { freeze } from "../stations.ts";
function declaredEnvelope<C extends CauseTable>(
  value: unknown,
  causes: C,
): value is Envelope<ResultFor<C>> {
  return envelopeShape(value) && typedResult(value.result, causes);
}
async function commandSteps(
  cli: string,
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
    const parsed = await parseInput(command.input, step.args);
    if (
      !parsed.ok ||
      (command.commandIdentity !== `${cli}.dispatch` &&
        !acceptsRootInput(command.route, parsed.value))
    )
      return false;
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
  return guidanceTemplatesAgree(
    station,
    result,
    commands.flatMap((item) => item.route),
  );
}
export async function validateEnvelope<C extends CauseTable>(
  cli: string,
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
  const read = readExternal(value);
  if (!read.ok) return read;
  const snapshot = read.value;
  if (!declaredEnvelope(snapshot, causes))
    return reject("$", "invalid envelope shape or correlation");
  const command = commands.find(
    (item) => item.commandIdentity === snapshot.result.commandIdentity,
  );
  const station = stations
    .get(snapshot.result.commandIdentity)
    ?.find((item) => item.causeCode === snapshot.result.causeCode);
  if (
    !command ||
    !station ||
    command.effectClass !== snapshot.result.effectClass
  )
    return reject("result", "undeclared command, station or effect class");
  if (
    snapshot.availablePaths.some(
      (identity) => !commands.some((item) => item.commandIdentity === identity),
    )
  )
    return reject("availablePaths", "undeclared identity");
  if (
    [
      ...snapshot.result.effects.completed,
      ...snapshot.result.effects.remaining,
      ...snapshot.result.effects.uncertain,
    ].some((effect) => !command.effects?.includes(effect))
  )
    return reject("effects", "undeclared effect");
  if (!stationMatches(snapshot.result, station, commands))
    return reject("result", "station guidance or delay mismatch");
  if (!(await commandSteps(cli, snapshot.result, commands)))
    return reject("result", "invalid command step");
  return { ok: true, value: freeze(snapshot) };
}
function readExternal(value: unknown): Validation<unknown> {
  try {
    const descriptor = record(value)
      ? Object.getOwnPropertyDescriptor(value, "contractVersion")
      : undefined;
    const observed: unknown = descriptor?.value;
    const version = classifyVersion(observed);
    if (version !== "accepted")
      return { ok: false, path: "contractVersion", reason: version };
    if (!json(value))
      return { ok: false, path: "$", reason: "not plain bounded JSON" };
    const snapshot: unknown = structuredClone(value);
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false, path: "$", reason: "unreadable external value" };
  }
}
