import { isAbsolute, join, normalize } from "node:path";

export type XdgKind = "config" | "data" | "state" | "cache" | "runtime";

export type XdgBaseOptions = {
  readonly homeFallback?: boolean;
};

const envNames: Readonly<Record<XdgKind, string>> = {
  config: "XDG_CONFIG_HOME",
  data: "XDG_DATA_HOME",
  state: "XDG_STATE_HOME",
  cache: "XDG_CACHE_HOME",
  runtime: "XDG_RUNTIME_DIR",
};

const homeSubfolders: Readonly<
  Record<Exclude<XdgKind, "runtime">, readonly string[]>
> = {
  config: [".config"],
  data: [".local", "share"],
  state: [".local", "state"],
  cache: [".cache"],
};

function absoluteValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(environment, key)) return undefined;
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value))
    return undefined;
  return normalize(value);
}

export function xdgBaseFolder(
  environment: Readonly<Record<string, string | undefined>>,
  kind: XdgKind,
  options?: XdgBaseOptions,
): string | undefined {
  const configured = absoluteValue(environment, envNames[kind]);
  if (configured !== undefined) return configured;
  if (kind === "runtime" || options?.homeFallback === false) return undefined;
  const home = absoluteValue(environment, "HOME");
  if (home === undefined) return undefined;
  return join(home, ...homeSubfolders[kind]);
}
