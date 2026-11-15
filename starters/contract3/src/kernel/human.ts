import type { Envelope } from "./types.ts";
import { record } from "./validation/primitives.ts";

// Human-mode rendering of an already validated envelope (LIFE-2). Help and
// discovery go to stdout; a refusal or failure is exactly one stderr line.
export function oneLine(value: string): string {
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
      (item) => `  ${route(item)}  ${texts(item, "summary")}`,
    ),
    "",
    "Options:",
    ...list(data, "options").map((item) => {
      const valueName = texts(item, "valueName");
      return `  ${texts(item, "name")}${valueName ? ` <${valueName}>` : ""}  ${texts(item, "summary")}`;
    }),
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

function commandDiscovery(data: unknown): string[] {
  const command = record(data) ? data.command : undefined;
  return [
    `${texts(command, "commandIdentity")} (${texts(command, "effectClass")})`,
    texts(command, "summary"),
    `Route: ${route(command)}`,
    "Possible outcomes:",
    ...list(data, "stations").map(
      (item) =>
        `  ${texts(item, "outcome")} ${texts(item, "causeCode")}  ${texts(item, "trigger")}`,
    ),
  ];
}

export function renderHuman(
  cli: string,
  envelope: Envelope,
): { readonly stream: "stdout" | "stderr"; readonly text: string } {
  const result = envelope.result;
  if (result.outcome !== "success")
    return {
      stream: "stderr",
      text: `${oneLine(cli)}: ${oneLine(envelope.message)} [${result.causeCode}]\n`,
    };
  const lines =
    result.commandIdentity === `${cli}.help`
      ? help(result.data)
      : result.commandIdentity === `${cli}.discovery`
        ? discovery(result.data)
        : result.commandIdentity === `${cli}.command-discovery`
          ? commandDiscovery(result.data)
          : [
              oneLine(envelope.message),
              ...(result.data === null
                ? []
                : [JSON.stringify(result.data, null, 2)]),
            ];
  return { stream: "stdout", text: `${lines.join("\n")}\n` };
}
