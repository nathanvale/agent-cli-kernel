import { unchanged } from "./shapes.ts";

// One owner for the inspect handler fake that succeeds unchanged with no
// data (K1-3 standards). Generic over the result builder, so it fits any
// command() whose derived or declared stations include SUCCESS_UNCHANGED.
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

// One owner for the handler a raw admission fixture carries (K1-5 requires
// one); it never runs (repair 1, S3).
export function neverRuns() {
  return Promise.resolve({
    ok: false,
    path: "handler",
    reason: "Raw admission fixture never runs.",
  } as const);
}
