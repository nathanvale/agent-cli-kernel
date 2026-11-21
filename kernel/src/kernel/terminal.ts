import type { TerminalAdapter } from "./process-types.ts";

const encoder = new TextEncoder();

export function scriptedTerminal(
  keys: readonly (string | Uint8Array)[] = [],
  dimensions: { readonly columns: number; readonly rows: number } = {
    columns: 80,
    rows: 24,
  },
): TerminalAdapter & { readonly drawn: readonly (readonly string[])[] } {
  const drawn: (readonly string[])[] = [];
  const frames = keys.map((item) =>
    typeof item === "string" ? encoder.encode(item) : new Uint8Array(item),
  );
  let index = 0;
  return {
    drawn,
    size: () => ({ columns: dimensions.columns, rows: dimensions.rows }),
    enter: () => undefined,
    leave: () => undefined,
    keys(signal) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (signal.aborted || index >= frames.length)
                return Promise.resolve({
                  done: true as const,
                  value: undefined,
                });
              const next = frames[index];
              index += 1;
              if (next === undefined)
                return Promise.resolve({
                  done: true as const,
                  value: undefined,
                });
              return Promise.resolve({
                done: false as const,
                value: new Uint8Array(next),
              });
            },
          };
        },
      };
    },
    draw(lines) {
      drawn.push([...lines]);
    },
  };
}
