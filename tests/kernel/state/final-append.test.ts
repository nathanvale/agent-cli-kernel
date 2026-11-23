import { expect } from "bun:test";
import {
  at,
  closeArgs,
  makeWorld,
  only,
  settlingAppendFault,
  supportingTest,
} from "./harness.ts";
import type { Json, SettlingAppendFault, World } from "./harness.ts";

const apply = ["apply", "a", "--content", "v1", "--json"];
const childBound = 15_000;
const harnessBarrierBound = 60_000;
const runsPerCheck = 14;
const killsPerCheck = 6;
const checkBound =
  runsPerCheck * childBound +
  killsPerCheck * (harnessBarrierBound + childBound);

type Route = {
  readonly name: string;
  readonly kind: "completion" | "not-applied" | "outcome";
  readonly run: (
    world: World,
    fault: Readonly<Record<string, string>>,
  ) => Promise<Json | undefined>;
};

async function rawResult(
  world: World,
  argv: readonly string[],
  extra: Readonly<Record<string, string>>,
): Promise<Json | undefined> {
  const run = await world.run(argv, extra);
  if (run.stderr !== "") throw new Error(run.stderr);
  return run.result.raw;
}

async function seedUnresolved(world: World): Promise<string> {
  await world.killAt(apply, "effect");
  return only(world);
}

const routesWithFinalAppend: readonly Route[] = [
  {
    name: "completion",
    kind: "completion",
    run: (world, fault) => rawResult(world, apply, fault),
  },
  {
    name: "not-applied",
    kind: "not-applied",
    run: (world, fault) =>
      rawResult(world, apply, { ...fault, SX_FAULT: "transient-after-intent" }),
  },
  {
    name: "outcome",
    kind: "outcome",
    run: (world, fault) =>
      rawResult(world, apply, { ...fault, SX_FAULT: "wrong-content" }),
  },
  {
    name: "unused-intent refusal",
    kind: "not-applied",
    run: async (world, fault) => {
      await seedUnresolved(world);
      return rawResult(world, apply, {
        ...fault,
        SX_SUPERSEDE: "1",
        SX_FAULT: "closure-publication-fails",
      });
    },
  },
  {
    name: "unused-intent refusal after the deadline",
    kind: "not-applied",
    run: async (world, fault) => {
      await seedUnresolved(world);
      return rawResult(world, [...apply, "--deadline-ms", "3000"], {
        ...fault,
        SX_SUPERSEDE: "1",
        SX_FAULT: "deadline-after-closure",
      });
    },
  },
  {
    name: "close",
    kind: "completion",
    run: async (world, fault) => {
      const id = await seedUnresolved(world);
      return rawResult(world, closeArgs(id, await world.revision(id)), fault);
    },
  },
];

function answer(result: Json | undefined) {
  return {
    transactionState: at(result, "transactionState"),
    inventoryComplete: at(result, "effects", "inventoryComplete"),
  };
}

function answerAfterFailedAppend(route: Route) {
  return route.kind === "outcome"
    ? { transactionState: "unknown", inventoryComplete: true }
    : { transactionState: "unknown", inventoryComplete: false };
}

supportingTest(
  "FA01.failed-final-append-never-clean: on every route that returns a proof after a final journal append, a failed write or a failed flush of that append is answered unknown with an incomplete inventory; an outcome append, which never settles a case, keeps the answer the landed record gives",
  async () => {
    const observed: Record<string, unknown> = {};
    const wanted: Record<string, unknown> = {};
    for (const route of routesWithFinalAppend)
      for (const step of ["write", "flush"] as const) {
        const label = `${route.name} ${step}`;
        const fault: SettlingAppendFault = `${route.kind}-${step}-fails`;
        const world = makeWorld({ qualification: "fixture", childBound });
        try {
          observed[label] = answer(
            await route.run(world, settlingAppendFault(fault)),
          );
        } finally {
          world.dispose();
        }
        wanted[label] = answerAfterFailedAppend(route);
      }
    expect(observed).toEqual(wanted);
  },
  checkBound,
);
