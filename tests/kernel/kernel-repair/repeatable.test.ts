import { expect } from "bun:test";
import { command, contractFor } from "../../../kernel/src/kernel/index.ts";
import { runFamily } from "./harness.ts";

const value = {
  kind: "string",
  minLength: 1,
  maxLength: 8,
  choices: null,
  pattern: null,
} as const;
function fixture() {
  const tag = command({
    identity: "specimen.tag",
    route: ["tag"],
    summary: "Tag.",
    input: {
      arguments: [],
      options: [
        {
          name: "--tag",
          aliases: [],
          summary: "Tag.",
          required: false,
          repeatable: true,
          value,
        },
        {
          name: "--name",
          aliases: [],
          summary: "Name.",
          required: false,
          repeatable: false,
          value,
        },
      ],
      constraints: [],
      deadlineSupported: false,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: {},
    run: () => {
      throw new Error("Never entered.");
    },
  });
  return contractFor({ cli: "specimen", commands: [tag] });
}
async function tags(argv: readonly string[]): Promise<unknown> {
  const parsed = await fixture().parse("specimen.tag", argv);
  expect(parsed.ok).toBe(true);
  return parsed.ok ? Reflect.get(parsed.value, "--tag") : undefined;
}

runFamily("R17", {
  "R17.order-preserved": async () =>
    expect(await tags(["--tag", "a", "--tag", "b", "--tag", "a"])).toEqual([
      "a",
      "b",
      "a",
    ]),
  "R17.distinct-arrays": async () => {
    const first = await tags(["--tag", "a", "--tag", "b"]);
    const second = await tags(["--tag", "c"]);
    expect(first).not.toBe(second);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c"]);
  },
  "R17.non-repeatable-refused": async () =>
    expect(
      await fixture().parse("specimen.tag", ["--name", "a", "--name", "b"]),
    ).toMatchObject({ ok: false }),
});
