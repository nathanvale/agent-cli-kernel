import { describe, expect, test } from "bun:test";
import {
  xdgBaseFolder,
  type XdgBaseOptions,
  type XdgKind,
} from "../../kernel/src/shared/xdg-base.ts";

type Case = {
  readonly name: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly kind: XdgKind;
  readonly options?: XdgBaseOptions;
  readonly expected: string | undefined;
};

function inheritedEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const child: Record<string, string | undefined> = {};
  Object.setPrototypeOf(child, parent);
  return child;
}

const cases: readonly Case[] = [
  {
    name: "rule 1+2: config reads XDG_CONFIG_HOME and normalises it",
    environment: {
      XDG_CONFIG_HOME: "/var/opt//app/./config/../cfg",
      HOME: "/home/alice",
    },
    kind: "config",
    expected: "/var/opt/app/cfg",
  },
  {
    name: "rule 1+2: data reads XDG_DATA_HOME and normalises it",
    environment: {
      XDG_DATA_HOME: "/var/opt//app/./data",
      HOME: "/home/alice",
    },
    kind: "data",
    expected: "/var/opt/app/data",
  },
  {
    name: "rule 1+2: state reads XDG_STATE_HOME and normalises it",
    environment: {
      XDG_STATE_HOME: "/var/opt//app/./state",
      HOME: "/home/alice",
    },
    kind: "state",
    expected: "/var/opt/app/state",
  },
  {
    name: "rule 1+2: cache reads XDG_CACHE_HOME and normalises it",
    environment: {
      XDG_CACHE_HOME: "/var/opt//app/./cache",
      HOME: "/home/alice",
    },
    kind: "cache",
    expected: "/var/opt/app/cache",
  },
  {
    name: "rule 1+2: runtime reads XDG_RUNTIME_DIR and normalises it",
    environment: {
      XDG_RUNTIME_DIR: "/run/user//1000/./app",
      HOME: "/home/alice",
    },
    kind: "runtime",
    expected: "/run/user/1000/app",
  },
  {
    name: "rule 3: empty XDG variable is ignored and falls back to HOME",
    environment: {
      XDG_CONFIG_HOME: "",
      HOME: "/home/alice",
    },
    kind: "config",
    expected: "/home/alice/.config",
  },
  {
    name: "rule 4: relative XDG variable is ignored and falls back to HOME",
    environment: {
      XDG_STATE_HOME: "relative/state",
      HOME: "/home/alice",
    },
    kind: "state",
    expected: "/home/alice/.local/state",
  },
  {
    name: "rule 5: config falls back to HOME/.config",
    environment: { HOME: "/home/alice" },
    kind: "config",
    expected: "/home/alice/.config",
  },
  {
    name: "rule 5: data falls back to HOME/.local/share",
    environment: { HOME: "/home/alice" },
    kind: "data",
    expected: "/home/alice/.local/share",
  },
  {
    name: "rule 5: state falls back to HOME/.local/state",
    environment: { HOME: "/home/alice" },
    kind: "state",
    expected: "/home/alice/.local/state",
  },
  {
    name: "rule 5: cache falls back to HOME/.cache",
    environment: { HOME: "/home/alice" },
    kind: "cache",
    options: { homeFallback: true },
    expected: "/home/alice/.cache",
  },
  {
    name: "rule 6: runtime returns undefined when XDG_RUNTIME_DIR is unset",
    environment: { HOME: "/home/alice" },
    kind: "runtime",
    expected: undefined,
  },
  {
    name: "rule 6: runtime returns undefined when XDG_RUNTIME_DIR is empty",
    environment: { XDG_RUNTIME_DIR: "", HOME: "/home/alice" },
    kind: "runtime",
    expected: undefined,
  },
  {
    name: "rule 6: runtime returns undefined when XDG_RUNTIME_DIR is relative",
    environment: { XDG_RUNTIME_DIR: "run/1000", HOME: "/home/alice" },
    kind: "runtime",
    expected: undefined,
  },
  {
    name: "rule 7: homeFallback false returns undefined instead of HOME default",
    environment: { HOME: "/home/alice" },
    kind: "state",
    options: { homeFallback: false },
    expected: undefined,
  },
  {
    name: "rule 7: homeFallback false still returns an absolute XDG variable",
    environment: { XDG_STATE_HOME: "/srv/state", HOME: "/home/alice" },
    kind: "state",
    options: { homeFallback: false },
    expected: "/srv/state",
  },
  {
    name: "rule 8: empty HOME returns undefined when XDG variable is unset",
    environment: { HOME: "" },
    kind: "config",
    expected: undefined,
  },
  {
    name: "rule 8: relative HOME returns undefined when XDG variable is unset",
    environment: { HOME: "home/alice" },
    kind: "data",
    expected: undefined,
  },
  {
    name: "rule 8: unset HOME returns undefined when XDG variable is unset",
    environment: {},
    kind: "cache",
    expected: undefined,
  },
  {
    name: "own property: inherited XDG variable on environment prototype is ignored",
    environment: inheritedEnvironment({ XDG_STATE_HOME: "/srv/inherited" }),
    kind: "state",
    expected: undefined,
  },
];

describe("xdgBaseFolder", () => {
  for (const row of cases) {
    test(row.name, () => {
      expect(xdgBaseFolder(row.environment, row.kind, row.options)).toBe(
        row.expected,
      );
    });
  }
});
