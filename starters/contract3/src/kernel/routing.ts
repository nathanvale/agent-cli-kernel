import { splitDeadline, splitDeadlineTokens } from "./deadline.ts";
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
  if (!parsed.ok || !acceptsRootInput(command.route, parsed.value))
    return refused(
      cli,
      "USAGE_INVALID_INVOCATION",
      machine,
      command.commandIdentity,
    );
  const resolved = {
    commandIdentity: command.commandIdentity,
    machine,
    input: parsed.value,
  };
  return {
    ok: true,
    value:
      deadlineMilliseconds === undefined
        ? resolved
        : { ...resolved, deadlineMilliseconds },
  } as const;
}
export function invocationTokens(argv: readonly string[]): readonly string[] {
  const { tokens } = globalSwitches(argv);
  const split = splitDeadline(tokens);
  return split.ok ? split.value.tokens : tokens;
}
function selectCommand(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
): CommandDeclaration | undefined {
  return commands
    .filter(
      (item) =>
        item.commandIdentity !== `${cli}.dispatch` &&
        item.route.every((token, index) => tokens[index] === token),
    )
    .sort((a, b) => b.route.length - a.route.length)[0];
}
// Accepted decision (contract question 6 of 8): the host command a declared
// step's final vector (route, then args) routes to, by the same selection
// as an invocation, or undefined when it would reach no host command.
export function routedIdentity(
  cli: string,
  commands: readonly CommandDeclaration[],
  vector: readonly string[],
): string | undefined {
  const { tokens, navigation } = globalSwitches(vector);
  const deadline = splitDeadlineTokens(tokens);
  if (!deadline.ok || navigation.length > 0) return undefined;
  return selectCommand(cli, commands, deadline.value.tokens)?.commandIdentity;
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
  const command = selectCommand(cli, commands, tokens);
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
