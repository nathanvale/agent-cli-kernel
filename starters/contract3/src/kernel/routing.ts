import type { CommandDeclaration } from "./declarations.ts";
import { parseInput } from "./input.ts";
function refused(
  cli: string,
  causeCode: "USAGE_INVALID_INVOCATION" | "USAGE_UNKNOWN_COMMAND",
  machine: boolean,
  commandIdentity = `${cli}.dispatch`,
) {
  return { ok: false, commandIdentity, causeCode, machine } as const;
}
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
    ["--help", "--discover", "--discover-command"].includes(token),
  );
  return { tokens, machine, navigation };
}
async function resolveBuiltin(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
  machine: boolean,
  flag: string | undefined,
) {
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
  return resolveCommand(cli, command, tokens.slice(1), machine);
}
async function resolveCommand(
  cli: string,
  command: CommandDeclaration,
  args: readonly string[],
  machine: boolean,
) {
  const parsed = await parseInput(command.input, args);
  return parsed.ok
    ? ({
        ok: true,
        value: {
          commandIdentity: command.commandIdentity,
          machine,
          input: parsed.value,
        },
      } as const)
    : refused(
        cli,
        "USAGE_INVALID_INVOCATION",
        machine,
        command.commandIdentity,
      );
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
  const { tokens, machine, navigation } = globalSwitches(argv);
  if (!tokens.length || navigation.length > 1)
    return refused(cli, "USAGE_INVALID_INVOCATION", machine);
  if (navigation.length === 1)
    return resolveBuiltin(cli, commands, tokens, machine, navigation[0]);
  const candidates = commands
    .filter(
      (item) =>
        item.commandIdentity !== `${cli}.dispatch` &&
        item.route.every((token, index) => tokens[index] === token),
    )
    .sort((a, b) => b.route.length - a.route.length);
  const command = candidates[0];
  return command
    ? resolveCommand(cli, command, tokens.slice(command.route.length), machine)
    : refused(cli, "USAGE_UNKNOWN_COMMAND", machine);
}
