const processGone = new Set<unknown>(["ESRCH"]);
const groupGone = new Set<unknown>(["ESRCH", "EPERM"]);

function sendUnlessGone(
  target: number,
  signal: NodeJS.Signals,
  gone: ReadonlySet<unknown>,
): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (gone.has(Reflect.get(Object(error), "code"))) return false;
    throw error;
  }
}

export function signalIfPresent(pid: number, signal: NodeJS.Signals): boolean {
  return sendUnlessGone(pid, signal, processGone);
}

export function signalGroupIfPresent(
  group: number,
  signal: NodeJS.Signals,
): boolean {
  return sendUnlessGone(-group, signal, groupGone);
}
