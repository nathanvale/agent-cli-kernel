import { unchanged } from "./shapes.ts";

export function readsUnchanged<const Identity extends string>(
  identity: Identity,
) {
  return <R>(
    _input: unknown,
    context: {
      readonly result: (
        selected: {
          readonly commandIdentity: Identity;
          readonly causeCode: "SUCCESS_UNCHANGED";
        },
        facts: {
          readonly message: string;
          readonly data: null;
          readonly effects: typeof unchanged;
        },
      ) => R;
    },
  ): R =>
    context.result(
      { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read.", data: null, effects: unchanged },
    );
}

export function neverRuns() {
  return Promise.resolve({
    ok: false,
    path: "handler",
    reason: "Raw admission fixture never runs.",
  } as const);
}
