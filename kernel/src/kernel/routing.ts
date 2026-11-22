import { splitDeadline, splitDeadlineTokens } from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { acceptsRootInput, parseSlots } from "./input.ts";
import { discoverable } from "./navigation.ts";
import { usageRefusal } from "./usage.ts";
import type { UsageFault } from "./usage.ts";
export function refused(
  cli: string,
  fault: UsageFault,
  machine: boolean,
  commandIdentity = `${cli}.dispatch`,
) {
  return {
    ok: false,
    commandIdentity,
    machine,
    ...usageRefusal(fault, cli),
  } as const;
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
export function asksMachineOutput(argv: unknown): boolean {
  return (
    Array.isArray(argv) &&
    argv.every((token: unknown) => typeof token === "string") &&
    globalSwitches(argv).machine
  );
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
    return refused(cli, { kind: "deadline-unsupported" }, machine);
  const command = commands.find((item) => item.route[0] === flag);
  const expected = flag === "--discover-command" ? 2 : 1;
  if (!command || tokens[0] !== flag || tokens.length !== expected)
    return refused(cli, { kind: "navigation-shape" }, machine);
  if (
    flag === "--discover-command" &&
    !commands.some((item) => item.commandIdentity === tokens[1])
  )
    return refused(
      cli,
      { kind: "unknown-command" },
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
  const refuse = (fault: UsageFault) =>
    refused(cli, fault, machine, command.commandIdentity);
  if (deadlineMilliseconds !== undefined && !command.input.deadlineSupported)
    return refuse({ kind: "deadline-unsupported" });
  const parsed = await parseSlots(command.input, args);
  if (!parsed.ok) return refuse(parsed.fault);
  if (!acceptsRootInput(command.route, parsed.value))
    return refuse({ kind: "root-input" });
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
function askedNavigation(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
  flag: string | undefined,
) {
  if (flag !== "--help" || tokens[0] === flag) return { flag, tokens };
  const command = selectCommand(cli, commands, tokens);
  return command && discoverable(command.commandIdentity)
    ? {
        flag: "--discover-command",
        tokens: ["--discover-command", command.commandIdentity],
      }
    : { flag, tokens: [flag] };
}
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
export type ResolveFacts = {
  readonly interactive?: boolean;
  readonly defaultCommand?: CommandDeclaration;
};
export async function resolveInvocation(
  cli: string,
  commands: readonly CommandDeclaration[],
  argv: unknown,
  facts?: ResolveFacts,
) {
  if (
    !Array.isArray(argv) ||
    !argv.every((token: unknown) => typeof token === "string")
  )
    return refused(cli, { kind: "invalid" }, false);
  const { tokens: globalTokens, machine, navigation } = globalSwitches(argv);
  const deadline = splitDeadline(globalTokens);
  if (!deadline.ok) return refused(cli, { kind: "deadline" }, machine);
  const { tokens, deadlineMilliseconds } = deadline.value;
  if (!tokens.length) {
    if (
      facts?.interactive === true &&
      !machine &&
      deadlineMilliseconds === undefined &&
      facts.defaultCommand
    )
      return resolveCommand(cli, facts.defaultCommand, [], false);
    return refused(cli, { kind: "no-command" }, machine);
  }
  if (navigation.length > 1)
    return refused(cli, { kind: "navigation-conflict" }, machine);
  if (navigation.length === 1) {
    const asked = askedNavigation(cli, commands, tokens, navigation[0]);
    return resolveBuiltin(
      cli,
      commands,
      asked.tokens,
      machine,
      asked.flag,
      deadlineMilliseconds,
    );
  }
  const command = selectCommand(cli, commands, tokens);
  return command
    ? resolveCommand(
        cli,
        command,
        tokens.slice(command.route.length),
        machine,
        deadlineMilliseconds,
      )
    : refused(cli, { kind: "unknown-command" }, machine);
}
