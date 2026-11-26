import { splitDeadline, splitDeadlineTokens } from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { acceptsRootInput, nearestWord, parseSlots } from "./input.ts";
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
const booleanSwitches = [
  "--json",
  "--help",
  "-h",
  "--version",
  "--discover",
  "--discover-all",
] as const;
const navigationSwitches = [
  "--help",
  "-h",
  "--version",
  "--discover",
  "--discover-all",
  "--discover-command",
];
function isHelpSwitch(flag: string | undefined): boolean {
  return flag === "--help" || flag === "-h";
}
const discoverCommandPrefix = "--discover-command=";
type SwitchScan = {
  readonly tokens: string[];
  literal: boolean;
  machine: boolean;
  unexpectedValue?: string;
};
function unexpectedBooleanSwitch(token: string): string | undefined {
  return booleanSwitches.find((name) => token.startsWith(`${name}=`));
}
function scanGlobalToken(state: SwitchScan, token: string): void {
  if (token === "--") state.literal = true;
  if (state.literal) {
    state.tokens.push(token);
    return;
  }
  if (token === "--json") {
    state.machine = true;
    return;
  }
  const bad = unexpectedBooleanSwitch(token);
  if (bad !== undefined) state.unexpectedValue ??= bad;
  if (token.startsWith(discoverCommandPrefix)) {
    state.tokens.push(
      "--discover-command",
      token.slice(discoverCommandPrefix.length),
    );
    return;
  }
  state.tokens.push(token);
}
function globalSwitches(argv: readonly unknown[]) {
  const state: SwitchScan = { tokens: [], literal: false, machine: false };
  for (const item of argv) scanGlobalToken(state, String(item));
  const separator = state.tokens.indexOf("--");
  const globalTokens =
    separator < 0 ? state.tokens : state.tokens.slice(0, separator);
  const navigation = globalTokens.filter((token) =>
    navigationSwitches.includes(token),
  );
  return {
    tokens: state.tokens,
    machine: state.machine,
    navigation,
    unexpectedValue: state.unexpectedValue,
  };
}
export function carriesGlobalSwitch(argv: readonly unknown[]): boolean {
  const { machine, navigation, unexpectedValue } = globalSwitches(argv);
  return machine || navigation.length > 0 || unexpectedValue !== undefined;
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
      { kind: "unknown-command", word: null, closest: null },
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
function laterWordsMatched(
  command: CommandDeclaration,
  words: readonly string[],
  index: number,
): number {
  return command.route.filter((token, at) => at > index && words[at] === token)
    .length;
}
export function closestRoute(
  commands: readonly CommandDeclaration[],
  words: readonly string[],
  index: number,
): string | null {
  const later = (item: CommandDeclaration) =>
    laterWordsMatched(item, words, index);
  const command = nearestWord(
    words[index] ?? "",
    commands
      .filter((item) => item.route.length > index)
      .sort((a, b) => later(b) - later(a) || a.route.length - b.route.length)
      .map((item) => [item.route[index] ?? "", item] as const),
  );
  return command === null ? null : command.route.join(" ");
}
function unknownCommand(
  cli: string,
  commands: readonly CommandDeclaration[],
  words: readonly string[],
): UsageFault {
  let matched = commands.filter(
    (item) => item.commandIdentity !== `${cli}.dispatch`,
  );
  for (const [index, word] of words.entries()) {
    const next = matched.filter((item) => item.route[index] === word);
    if (!next.length)
      return {
        kind: "unknown-command",
        word,
        closest: closestRoute(matched, words, index),
      };
    matched = next;
  }
  return { kind: "unknown-command", word: null, closest: null };
}
function unknownHelpRoute(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
  flag: string | undefined,
): UsageFault | undefined {
  if (!isHelpSwitch(flag)) return undefined;
  const at = tokens.indexOf(flag ?? "");
  const words = tokens.filter((_token, index) => index !== at);
  const first = words[0];
  if (first === undefined || first.startsWith("-")) return undefined;
  return selectCommand(cli, commands, words)
    ? undefined
    : unknownCommand(cli, commands, words);
}
function askedNavigation(
  cli: string,
  commands: readonly CommandDeclaration[],
  tokens: readonly string[],
  flag: string | undefined,
) {
  if (!isHelpSwitch(flag)) return { flag, tokens };
  if (tokens[0] === flag)
    return { flag: "--help", tokens: ["--help", ...tokens.slice(1)] };
  const command = selectCommand(cli, commands, tokens);
  return command && discoverable(command.commandIdentity)
    ? {
        flag: "--discover-command",
        tokens: ["--discover-command", command.commandIdentity],
      }
    : { flag: "--help", tokens: ["--help"] };
}
export function routedIdentity(
  cli: string,
  commands: readonly CommandDeclaration[],
  vector: readonly string[],
): string | undefined {
  const { tokens, navigation, unexpectedValue } = globalSwitches(vector);
  const deadline = splitDeadlineTokens(tokens);
  if (!deadline.ok || navigation.length > 0 || unexpectedValue !== undefined)
    return undefined;
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
  const {
    tokens: globalTokens,
    machine,
    navigation,
    unexpectedValue,
  } = globalSwitches(argv);
  if (unexpectedValue !== undefined)
    return refused(
      cli,
      {
        kind: "unexpected-value",
        slot: { kind: "option", name: unexpectedValue },
      },
      machine,
    );
  const deadline = splitDeadline(globalTokens);
  if (!deadline.ok) return refused(cli, { kind: "deadline" }, machine);
  const { tokens, deadlineMilliseconds } = deadline.value;
  // Accepted decisions (Nathan, 21 November 2026, 11:39 and 11:42; MAG-138
  // decisions 21 and 22): in an interactive run an empty argv runs the
  // default command instead of the <cli>.dispatch refusal, bending frozen
  // Command Contract 3 A10, DISC-1, DISC-4 (last clause) and LIFE-2a only
  // in an interactive run; non-interactive and --json runs stay unchanged.
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
    const unknown = unknownHelpRoute(cli, commands, tokens, navigation[0]);
    if (unknown) return refused(cli, unknown, machine);
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
    : refused(cli, unknownCommand(cli, commands, tokens), machine);
}
