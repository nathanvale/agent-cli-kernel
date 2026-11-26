import type { Diagnostics, Envelope } from "./types.ts";
import { record } from "./validation/primitives.ts";
import { contractVersion } from "./validation/version.ts";

function oneLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, 2000);
}

function texts(value: unknown, key: string): string {
  return record(value) && typeof value[key] === "string"
    ? oneLine(value[key])
    : "";
}

function list(value: unknown, key: string): readonly unknown[] {
  return record(value) && Array.isArray(value[key]) ? value[key] : [];
}

function route(value: unknown): string {
  return list(value, "route")
    .map((token) => (typeof token === "string" ? oneLine(token) : ""))
    .join(" ");
}

function help(data: unknown): string[] {
  return [
    `Usage: ${texts(data, "usage")}`,
    texts(data, "summary"),
    "",
    "Commands:",
    ...list(data, "commands").map(
      (item) =>
        `  ${route(item)} (${texts(item, "commandIdentity")})  ${texts(item, "summary")}`,
    ),
    "",
    "Options:",
    ...list(data, "options").map((item) => {
      const valueName = texts(item, "valueName");
      return `  ${texts(item, "name")}${valueName ? ` <${valueName}>` : ""}  ${texts(item, "summary")}`;
    }),
  ];
}

function version(cli: string, data: unknown): string[] {
  const name = texts(data, "cli") || oneLine(cli);
  const declared = texts(data, "version");
  return [
    declared
      ? `${name} ${declared} (kernel contract ${contractVersion})`
      : `${name} version not declared (kernel contract ${contractVersion})`,
  ];
}

function discovery(data: unknown): string[] {
  return [
    `Contract ${texts(data, "contractVersion")}`,
    "Commands:",
    ...list(data, "commands").map(
      (item) =>
        `  ${texts(item, "commandIdentity")} (${texts(item, "effectClass")})  ${texts(item, "summary")}`,
    ),
  ];
}

function fullDiscovery(data: unknown): string[] {
  return [
    `Contract ${texts(data, "contractVersion")}`,
    "Commands:",
    ...list(data, "commands").map((entry) => {
      const item = record(entry) ? entry.command : undefined;
      return `  ${texts(item, "commandIdentity")} (${texts(item, "effectClass")})  ${texts(item, "summary")}`;
    }),
  ];
}

function numeral(value: unknown, key: string): string {
  return record(value) && typeof value[key] === "number"
    ? oneLine(String(value[key]))
    : "";
}

function strings(value: unknown, key: string): string[] {
  return list(value, key).map((item) =>
    typeof item === "string" ? oneLine(item) : "",
  );
}

function valueWords(value: unknown): string {
  if (!record(value)) return "";
  if (value.kind === "integer")
    return `integer, ${numeral(value, "minimum")} to ${numeral(value, "maximum")}`;
  const choices = strings(value, "choices");
  if (choices.length > 0) return choices.join("|");
  const pattern = texts(value, "pattern");
  return `string, length ${numeral(value, "minLength")} to ${numeral(value, "maxLength")}${pattern ? `, pattern ${pattern}` : ""}`;
}

function slot(item: unknown): string {
  const words = valueWords(record(item) ? item.value : undefined);
  const aliases = strings(item, "aliases").map((alias) => `, ${alias}`);
  const presence =
    record(item) && item.required === true ? "required" : "optional";
  const repeatable =
    record(item) && item.repeatable === true ? ", repeatable" : "";
  return `  ${texts(item, "name")}${aliases.join("")}${words ? ` <${words}>` : ""}  ${presence}${repeatable}  ${texts(item, "summary")}`;
}

function commandDiscovery(data: unknown, renamedHelp = false): string[] {
  const command = record(data) ? data.command : undefined;
  const input = record(data) ? data.input : undefined;
  const slotArguments = list(input, "arguments");
  const options = list(input, "options");
  const currentRoute = route(command);
  return [
    `${texts(command, "commandIdentity")} (${texts(command, "effectClass")})`,
    texts(command, "summary"),
    ...(renamedHelp ? [`Renamed to \`${currentRoute}\`.`] : []),
    `Route: ${currentRoute}`,
    ...(slotArguments.length > 0
      ? ["Arguments:", ...slotArguments.map(slot)]
      : []),
    "Options:",
    ...(options.length > 0 ? options.map(slot) : ["  (none)"]),
    "Possible results:",
    ...list(data, "stations").map(
      (item) =>
        `  ${texts(item, "outcome")} ${texts(item, "causeCode")}  ${texts(item, "trigger")}`,
    ),
  ];
}

export type HumanWrite = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

function diagnosticsWords(status: Diagnostics): string {
  if (status.status === "unavailable") {
    const file = status.trusted.file;
    return typeof file === "string"
      ? `unavailable (${status.reason}); log file ${file}`
      : `unavailable (${status.reason})`;
  }
  if (status.file === null)
    return status.sinkFailure === null
      ? "no log file"
      : `no log file (${status.sinkFailure})`;
  return status.sinkFailure === null
    ? status.file
    : `${status.file} (incomplete: ${status.sinkFailure})`;
}

function diagnosticsLine(
  status: Diagnostics | undefined,
): readonly HumanWrite[] {
  return status
    ? [
        {
          stream: "stdout",
          text: `Diagnostics: ${oneLine(diagnosticsWords(status))}\n`,
        },
      ]
    : [];
}

export function renderHuman(
  cli: string,
  envelope: Envelope,
  options?: { readonly renamedHelp?: boolean },
): readonly HumanWrite[] {
  return [
    resultText(cli, envelope, options?.renamedHelp === true),
    ...diagnosticsLine(envelope.diagnostics),
  ];
}

function successLines(
  cli: string,
  envelope: Envelope,
  renamedHelp: boolean,
): string[] {
  const { commandIdentity, data } = envelope.result;
  if (commandIdentity === `${cli}.help`) return help(data);
  if (commandIdentity === `${cli}.version`) return version(cli, data);
  if (commandIdentity === `${cli}.discovery`) return discovery(data);
  if (commandIdentity === `${cli}.full-discovery`) return fullDiscovery(data);
  if (commandIdentity === `${cli}.command-discovery`)
    return commandDiscovery(data, renamedHelp);
  return [
    oneLine(envelope.message),
    ...(data === null ? [] : [JSON.stringify(data, null, 2)]),
  ];
}

function resultText(
  cli: string,
  envelope: Envelope,
  renamedHelp: boolean,
): HumanWrite {
  const result = envelope.result;
  if (result.outcome !== "success")
    return {
      stream: "stderr",
      text: `${oneLine(cli)}: ${oneLine(envelope.message)} [${result.causeCode}]\n`,
    };
  const lines = successLines(cli, envelope, renamedHelp);
  return { stream: "stdout", text: `${lines.join("\n")}\n` };
}
