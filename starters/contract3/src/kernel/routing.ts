import { splitDeadline } from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { parseInput, acceptsRootInput } from "./input.ts";
function refused(
  cli: string,
  causeCode: "USAGE_INVALID_INVOCATION" | "USAGE_UNKNOWN_COMMAND",
  machine: boolean,
  commandIdentity = `${cli}.dispatch`,
) {
  return { ok: false, commandIdentity, causeCode, machine } as const;
}
const navigationSwitches = ["--help", "--discover", "--discover-command"];
function globalSwitches(argv: readonly unknown[]) {
  const tokens: string[] = [];
  let literal = false,
    machine = false;
  for (const token of argv) {
    if (token === "--") literal = true;
    if (!literal && token === "--json") machine = true;
    else tokens.push(String(token));
  }
  const separator = tokens.indexOf("--");
  const globalTokens = separator < 0 ? tokens : tokens.slice(0, separator);
  const navigation = globalTokens.filter((token) =>
    navigationSwitches.includes(token),
  );
  return { tokens, machine, navigation };
}
// INPUT-3 and STEP-6: true when the tokens carry a switch the front door
// handles before command parsing: `--json` or a navigation switch before
// `--`. A command step carrying one would not run as written (K1-2), while
// the same token after `--` is an operand (K1-13).
export function carriesGlobalSwitch(argv: readonly unknown[]): boolean {
  const { machine, navigation } = globalSwitches(argv);
  return machine || navigation.length > 0;
}
async function resolveBuiltin(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
  machine: boolean,
  flag: string | undefined,
  deadlineMilliseconds?: number,
) {
  if (deadlineMilliseconds !== undefined)
    return refused(cli, "USAGE_INVALID_INVOCATION", machine);
  const command = commands.find((item) => item.route[0] === flag);
  const expected = flag === "--discover-command" ? 2 : 1;
  if (!command || tokens[0] !== flag || tokens.length !== expected)
    return refused(cli, "USAGE_INVALID_INVOCATION", machine);
  if (
    flag === "--discover-command" &&
    !commands.some((item) => item.commandIdentity === tokens[1])
  )
    return refused(
      cli,
      "USAGE_UNKNOWN_COMMAND",
      machine,
      command.commandIdentity,
    );
  return resolveCommand(
    cli,
    command,
    tokens.slice(1),
    machine,
    deadlineMilliseconds,
  );
}
async function resolveCommand(
  cli: string,
  command: CommandDeclaration,
  args: readonly string[],
  machine: boolean,
  deadlineMilliseconds?: number,
) {
  if (deadlineMilliseconds !== undefined && !command.input.deadlineSupported)
    return refused(
      cli,
      "USAGE_INVALID_INVOCATION",
      machine,
      command.commandIdentity,
    );
  const parsed = await parseInput(command.input, args);
  return parsed.ok && acceptsRootInput(command.route, parsed.value)
    ? ({
        ok: true,
        value: {
          commandIdentity: command.commandIdentity,
          machine,
          input: parsed.value,
          ...(deadlineMilliseconds === undefined
            ? {}
            : { deadlineMilliseconds }),
        },
      } as const)
    : refused(
        cli,
        "USAGE_INVALID_INVOCATION",
        machine,
        command.commandIdentity,
      );
}
// The command tokens resolveInvocation routed on: global switches and a
// declared deadline removed. The process front door passes the tail after the
// route to the command's own executable parser.
export function invocationTokens(argv: readonly string[]): readonly string[] {
  const { tokens } = globalSwitches(argv);
  const split = splitDeadline(tokens);
  return split.ok ? split.value.tokens : tokens;
}
export async function resolveInvocation(
  cli: string,
  commands: readonly CommandDeclaration[],
  argv: unknown,
) {
  if (
    !Array.isArray(argv) ||
    !argv.every((token: unknown) => typeof token === "string")
  )
    return refused(cli, "USAGE_INVALID_INVOCATION", false);
  const { tokens: globalTokens, machine, navigation } = globalSwitches(argv);
  const deadline = splitDeadline(globalTokens);
  if (!deadline.ok) return refused(cli, "USAGE_INVALID_INVOCATION", machine);
  const { tokens, deadlineMilliseconds } = deadline.value;
  if (!tokens.length || navigation.length > 1)
    return refused(cli, "USAGE_INVALID_INVOCATION", machine);
  if (navigation.length === 1)
    return resolveBuiltin(
      cli,
      commands,
      tokens,
      machine,
      navigation[0],
      deadlineMilliseconds,
    );
  const candidates = commands
    .filter(
      (item) =>
        item.commandIdentity !== `${cli}.dispatch` &&
        item.route.every((token, index) => tokens[index] === token),
    )
    .sort((a, b) => b.route.length - a.route.length);
  const command = candidates[0];
  return command
    ? resolveCommand(
        cli,
        command,
        tokens.slice(command.route.length),
        machine,
        deadlineMilliseconds,
      )
    : refused(cli, "USAGE_UNKNOWN_COMMAND", machine);
}
