export type Profile = "scratch" | "durable";
export type Starter = "simple" | "complex";
export type Layout = "single-package" | "monorepo";

export type Request =
  | {
      readonly profile: "scratch";
      readonly layout: "single-package";
      readonly starter?: undefined;
    }
  | {
      readonly profile: "durable";
      readonly layout: Layout;
      readonly starter?: undefined;
    }
  | {
      readonly profile: "durable";
      readonly layout: "single-package";
      readonly starter: Starter;
    };

export interface Copy {
  readonly from: string;
  readonly into: "." | "src" | "tests";
}

export interface ProjectRecipe {
  readonly request: Request;
  readonly copies: readonly [Copy, ...Copy[]];
  readonly cli: Starter;
  readonly checkCommand: string;
}

export const UNCOPIED_NAMES: readonly string[] = [
  "TEMPLATE-SOURCE.md",
  "composition-tests",
];

const SIMPLE_CLI: readonly Copy[] = [
  { from: "starters/shared/src", into: "src" },
  { from: "starters/simple/src", into: "src" },
  { from: "starters/simple/tests", into: "tests" },
];

function starterRow(starter: Starter): ProjectRecipe {
  return {
    request: { profile: "durable", layout: "single-package", starter },
    copies: [
      { from: `profiles/static-admission/${starter}`, into: "." },
      { from: `starters/${starter}`, into: "." },
      { from: "starters/shared/src", into: "src" },
    ],
    cli: starter,
    checkCommand: "bun run check",
  };
}

export const RECIPES: readonly ProjectRecipe[] = [
  {
    request: { profile: "scratch", layout: "single-package" },
    copies: [{ from: "profiles/scratch", into: "." }, ...SIMPLE_CLI],
    cli: "simple",
    checkCommand: "bun run typecheck && bun run test",
  },
  {
    request: { profile: "durable", layout: "single-package" },
    copies: [{ from: "profiles/durable", into: "." }, ...SIMPLE_CLI],
    cli: "simple",
    checkCommand: "bun run check",
  },
  {
    request: { profile: "durable", layout: "monorepo" },
    copies: [{ from: "examples/monorepo", into: "." }, ...SIMPLE_CLI],
    cli: "simple",
    checkCommand: "bun run check",
  },
  starterRow("simple"),
  starterRow("complex"),
];

function distinct<T>(values: readonly (T | undefined)[]): T[] {
  return [
    ...new Set(values.filter((value): value is T => value !== undefined)),
  ];
}

export const PROFILES: readonly Profile[] = distinct(
  RECIPES.map((recipe) => recipe.request.profile),
);

export const STARTERS: readonly Starter[] = distinct(
  RECIPES.map((recipe) => recipe.request.starter),
);

export interface Selection {
  readonly profile: Profile;
  readonly monorepo: boolean;
  readonly starter?: Starter | undefined;
}

export type RecipeChoice =
  | { readonly status: "selected"; readonly recipe: ProjectRecipe }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly repair: string;
    };

function refusal(selection: Selection): RecipeChoice {
  if (selection.monorepo && selection.profile !== "durable") {
    return {
      status: "refused",
      message: "--monorepo is available only with --profile durable",
      repair: "remove --monorepo or choose --profile durable",
    };
  }
  if (selection.starter !== undefined && selection.profile !== "durable") {
    return {
      status: "refused",
      message: "--starter is available only with --profile durable",
      repair: "remove --starter or choose --profile durable",
    };
  }
  return {
    status: "refused",
    message: "--starter and --monorepo cannot be combined",
    repair: "choose one CLI starter or the explicit monorepo example",
  };
}

export function selectRecipe(selection: Selection): RecipeChoice {
  const layout: Layout = selection.monorepo ? "monorepo" : "single-package";
  const recipe = RECIPES.find(
    ({ request }) =>
      request.profile === selection.profile &&
      request.layout === layout &&
      request.starter === selection.starter,
  );
  return recipe === undefined
    ? refusal(selection)
    : { status: "selected", recipe };
}
