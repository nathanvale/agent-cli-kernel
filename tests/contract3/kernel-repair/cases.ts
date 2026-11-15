// Frozen case identities for the T1 kernel repair round (MAG-100, C3-FND-2).
// Source of every expected observation: the independent expectations
// `t1-repair/expectations.md` (sha256 7a6e3287...) and
// `t1-repair/expectations-f01.md` (sha256 6cdc603e...), the frozen contract and
// the oracle. Never regenerate an expected value from kernel output.
// A pending case names the layer or ticket that supplies its proof.

export type Layer = "runtime" | "process" | "compiler" | "lint";
export type RepairCase = {
  readonly id: string;
  readonly family: string;
  readonly findings: readonly string[];
  readonly layer: Layer;
  readonly expected: string;
  readonly status: "active" | "pending";
  readonly supplier?: string;
};

function active(
  family: string,
  findings: readonly string[],
  layer: Layer,
  rows: readonly (readonly [string, string])[],
): readonly RepairCase[] {
  return rows.map(([suffix, expected]) => ({
    id: `${family}.${suffix}`,
    family,
    findings,
    layer,
    expected,
    status: "active",
  }));
}
function pending(
  id: string,
  family: string,
  findings: readonly string[],
  layer: Layer,
  supplier: string,
  expected: string,
): RepairCase {
  return { id, family, findings, layer, expected, status: "pending", supplier };
}

const r01 = active("R01", ["F13"], "runtime", [
  [
    "second-transaction-refused",
    "After pA (unchanged), a second sequential transaction on the same attachment rejects before its work starts; ledger stays empty; a SUCCESS_UNCHANGED result built from pA is ok with effects.completed [].",
  ],
  [
    "overlapping-transaction-refused",
    "Two overlapping transaction calls on one attachment: exactly one work callback runs, the other call rejects before work; the ledger holds only the running call's effect.",
  ],
  [
    "single-proof-per-attachment",
    "The issuer refuses to mint a second transaction proof for the same attachment (throws); the first proof still builds.",
  ],
  [
    "refusal-after-effect-refused",
    "After a transaction recorded e with read-back (ledger shows e), build of a refused unchanged station for that run returns ok:false at path transaction.",
  ],
  [
    "refusal-after-unchanged-admitted",
    "After a transaction that recorded nothing (proof unchanged), a refused unchanged station for that run builds ok.",
  ],
  [
    "completed-twin",
    "One transaction recording e builds SUCCESS_COMPLETED with effects.completed ['e'].",
  ],
  [
    "foreign-proof-refused",
    "A proof from another run or another installation is refused at path transaction (existing control kept).",
  ],
]);

const r02 = active("R02", ["K2"], "runtime", [
  [
    "plain-object-refused",
    "{ runId: 'r1', scope: 's', isActive: () => true } is not kernel-issued; consumption ledger delta 0.",
  ],
  [
    "copy-refused",
    "A spread of S1 and a new object carrying S1's own symbol key are refused; ledger delta 0. structuredClone(S1) throws DataCloneError (function member), so no clone exists to present.",
  ],
  ["other-run-refused", "S1 presented for run r2 is refused; ledger delta 0."],
  [
    "other-installation-refused",
    "A scope issued by a different installation is refused when checked against this installation's descriptor; ledger delta 0.",
  ],
  [
    "inactive-refused",
    "S1 after its isActive() returns false is refused; ledger delta 0.",
  ],
  [
    "superseded-attachment-refused",
    "S1 after run r1 is attached again (new attachment) is refused; ledger delta 0.",
  ],
  [
    "issued-twin-consumed-once",
    "S1 itself, active, same run, is accepted and the grant is consumed exactly once.",
  ],
  [
    "public-index-export",
    "The issuance check is a runtime function exported by the kernel public index.",
  ],
]);

const reserved = [
  "INTERNAL_PREPARATION",
  "INTERNAL_RESULT_UNCHANGED",
  "INTERNAL_RESULT_COMPLETED",
  "INTERNAL_RESULT_PARTIAL",
  "INTERNAL_RESULT_UNKNOWN",
] as const;
const r03 = active("R03", ["F12"], "runtime", [
  [
    "station-builder-refused",
    "station() throws for each of the five reserved causes (existing rule kept).",
  ],
  [
    "command-literal-refused",
    "A literal DeclaredStation for each reserved cause passed to command() is refused by contractFor with a reserved-words refusal before any command runs.",
  ],
  [
    "changing-literal-refused",
    "A literal DeclaredStation for each reserved cause passed to changing() is refused by contractFor with a reserved-words refusal.",
  ],
  [
    "raw-declaration-refused",
    "A raw CommandDeclaration whose stations hold each reserved cause is refused by contractFor with a reserved-words refusal.",
  ],
  [
    "base-words-retained",
    "For an admitted command, discoverCommand words for every reserved cause equal those of a twin with no host station; no host word appears.",
  ],
  [
    "schema-station-twin",
    "A host SCHEMA_INVALID_INPUT station is admitted and its words replace the default in discoverCommand.",
  ],
]);

const optionLike = [
  "",
  " ",
  "--json",
  "--deadline-ms",
  "--help",
  "--discover",
  "--discover-command",
  "--",
  "-x",
] as const;
const r04 = active("R04", ["F04"], "runtime", [
  [
    "command-builder-refused",
    "command() refuses each empty or option-like route token (existing rule kept).",
  ],
  [
    "changing-builder-refused",
    "changing() refuses each empty or option-like route token.",
  ],
  [
    "raw-declaration-refused",
    "contractFor refuses a raw declaration with each empty or option-like route token, naming the token.",
  ],
  [
    "builtins-exempt",
    "The four built-in navigation identities keep their routes; contractFor with no host commands is admitted.",
  ],
  [
    "apply-twin-selectable",
    "Route ['apply'] is admitted, listed by discover(), and resolve(['apply', ...valid args]) selects it.",
  ],
]);

const r05 = active("R05", ["F05"], "runtime", [
  [
    "next-empty-root-refused",
    "An envelope whose next names the root command with args [] fails validate.",
  ],
  [
    "handoff-empty-root-refused",
    "An envelope whose handoff.inspect names the root command with args [] fails validate.",
  ],
  [
    "build-empty-root-refused",
    "build refuses to produce a result for a station whose next names the root command with args [].",
  ],
  [
    "flag-twin-agrees",
    "The ['--all'] twins validate; parse(root, ['--all']) succeeds and resolve(['--all']) selects the root command.",
  ],
]);

const r06 = active("R06", ["F15"], "runtime", [
  [
    "mutation-during-await",
    "validate(E) with a command step, then E mutated before await (exitCode 99, data a function, extra key): ok:false, or ok:true with value !== E deep-equal to pre-mutation E.",
  ],
  [
    "mutation-after-resolve",
    "Mutating E after validate resolves does not change the returned value.",
  ],
  [
    "build-data-mutation",
    "build with host facts.data mutated before await: result.data deep-equals the pre-mutation data and is not the host object.",
  ],
]);

const r07 = active("R07", ["F06"], "runtime", [
  [
    "hidden-required-key-refused",
    "A result whose runId is non-enumerable fails validate.",
  ],
  [
    "hidden-tojson-refused",
    "data with a non-enumerable own toJSON function fails validate.",
  ],
  [
    "hidden-data-property-refused",
    "data with a non-enumerable own data property fails validate.",
  ],
  [
    "array-extra-enumerable-refused",
    "An array in data with an extra enumerable non-index own property fails validate.",
  ],
  [
    "array-extra-hidden-refused",
    "An array in data with an extra non-enumerable non-index own property fails validate.",
  ],
  [
    "round-trip-twin",
    "Plain objects and arrays (only hidden property: array length) validate, and JSON.parse(JSON.stringify(V)) deep-equals V with every required key present.",
  ],
]);

const r08 = active("R08", ["F17"], "runtime", [
  [
    "dag-20",
    "DAG of 20 shared {a:p,b:p} levels in data: validate answers within the watchdog, same answer twice.",
  ],
  [
    "dag-35",
    "DAG of 35 levels: validate answers within the watchdog, same answer twice.",
  ],
  [
    "dag-64",
    "DAG of 64 levels: validate answers within the watchdog, same answer twice.",
  ],
  [
    "tree-twin-and-guards",
    "Tree of depth 64 with few nodes validates; a cycle and depth 65 still fail.",
  ],
]);

const r09 = active("R09", ["F02", "F03"], "runtime", [
  [
    "exit-meanings-immutable",
    "Setting discover().exitMeanings['0'] throws or has no effect.",
  ],
  [
    "signal-exits-immutable",
    "Setting discover().signalExits['130'] throws or has no effect.",
  ],
  [
    "kernel-stations-immutable",
    "Mutating a kernel station's guidance arm fields, nested inspect entries, retryDelayPolicy and the stations array from discoverCommand (host and built-in) throws or has no effect.",
  ],
  [
    "second-contract-exact-tables",
    "After the attempts, discover() for this and a second contract carries exactly { 0: success, 1: internal, 2: usage, 3: domain, 4: schema, 75: transient } and { 130: SIGINT, 143: SIGTERM }.",
  ],
  [
    "built-words-original",
    "After the attempts, discoverCommand and a built INTERNAL_PREPARATION result carry the original kernel words.",
  ],
  [
    "altered-discovery-refused",
    "A discovery success whose exitMeanings or station words differ from those values fails validate.",
  ],
]);

const r10 = active("R10", ["F07", "F08"], "runtime", [
  [
    "prototype-key-payload-refused",
    "fields('3.0.0', p) is false for an extra own key toString, constructor, hasOwnProperty or valueOf.",
  ],
  [
    "proto-key-payload-refused",
    'fields(\'3.0.0\', JSON.parse(\'{"message":"m","__proto__":1}\')) is false.',
  ],
  [
    "required-prototype-name-absent",
    "With t0 declaring required toString, fields('3.0.0', { message: 'm' }) is false.",
  ],
  [
    "minor-required-prototype-name-throws",
    "versionReader([t0, t1]) throws when t1 adds required toString or constructor.",
  ],
  [
    "minor-optional-prototype-name-admitted",
    "versionReader([t0, t1]) succeeds when t1 adds toString and constructor as optional.",
  ],
  ["valid-twin", "fields('3.0.0', { message: 'm' }) against t0 is true."],
]);

const r11 = active("R11", ["F09"], "lint", [
  [
    "host-node-specifier",
    "await import('node:child_process') in host scope yields exactly one lint error.",
  ],
  [
    "host-bare-specifier",
    "await import('child_process') in host scope yields exactly one lint error.",
  ],
  [
    "kernel-specifiers",
    "Each specifier in kernel scope (kernel module, kernel index and validation folder) yields exactly one lint error.",
  ],
  [
    "path-twin-clean",
    "await import('node:path') in the same files is lint clean.",
  ],
  [
    "existing-controls-red",
    "Static child_process import and Bun.spawn, Bun.spawnSync, Bun.$ in host scope stay lint errors.",
  ],
]);

const r12 = active("R12", ["F10"], "runtime", [
  [
    "inspect-hidden-capability",
    "Inspect command declaring diagnostics with a non-enumerable diagnostics: refused before the handler (entries 0) or handler gets exactly the validated object.",
  ],
  [
    "inspect-getter-capability",
    "Inspect command with a getter returning a valid capability once then an invalid one: refused before the handler or handler gets exactly the validated object.",
  ],
  [
    "inspect-plain-twin",
    "Inspect command with an enumerable diagnostics enters once with that exact object.",
  ],
  [
    "changing-hidden-capability",
    "Changing command with a non-enumerable diagnostics: refused before the handler or handler gets exactly the validated object.",
  ],
  [
    "changing-getter-capability",
    "Changing command with a getter capability: refused before the handler or handler gets exactly the validated object.",
  ],
  [
    "changing-plain-twin",
    "Changing command with an enumerable diagnostics enters once with that exact object.",
  ],
]);

const r13 = active("R13", ["F11"], "compiler", [
  [
    "widened-array-assigns",
    "For const s: InputSchema with repeatable --tag, readonly string[] assigns to ParsedInput<typeof s>['--tag'].",
  ],
  [
    "widened-scalar-assigns",
    "For the same s, string assigns to the --tag slot.",
  ],
  [
    "literal-true-scalar-lock",
    "Literal repeatable: true: array assigns; scalar fails with exactly one diagnostic.",
  ],
  [
    "literal-false-array-lock",
    "Literal repeatable: false: scalar assigns; array fails with exactly one diagnostic.",
  ],
]);

const r14 = active("R14", ["F14"], "compiler", [
  [
    "widened-valid-twins",
    "Against ResultFor<CauseTable>: success with data {a:1} and repairAction null, transient refused with retryDelayMilliseconds 5 and next retry, inspect unchanged success all compile.",
  ],
  [
    "contract-valid-twins",
    "The same three twins compile against the result type exposed by validate (typeof commonCauses & CauseTable).",
  ],
  [
    "success-repair-lock",
    "Success with repairAction 'x' fails with one diagnostic (both table types).",
  ],
  [
    "refused-data-lock",
    "Refused with data {a:1} fails with one diagnostic (both table types).",
  ],
  [
    "retryable-no-delay-lock",
    "Retryable result without retryDelayMilliseconds fails with one diagnostic (both table types).",
  ],
  [
    "non-retryable-delay-lock",
    "Non-retryable result with retryDelayMilliseconds fails with one diagnostic (both table types).",
  ],
]);

const r15 = active("R15", ["F16"], "runtime", [
  [
    "canonically-equivalent-keys",
    "sameJson({ '\\u00e9': 1, 'e\\u0301': 2 }, { 'e\\u0301': 2, '\\u00e9': 1 }) is true.",
  ],
  ["member-order", "{ b: 1, a: 2 } equals { a: 2, b: 1 }."],
  ["value-change", "Changing one value makes them unequal."],
  [
    "locale-independent",
    "The same comparisons give identical answers in child processes run under different LC_ALL and LANG locales.",
  ],
  [
    "reordered-discovery-validates",
    "help and discover successes whose objects differ only in member order pass validate.",
  ],
]);

const r17 = active("R17", ["R1"], "runtime", [
  [
    "order-preserved",
    "['--tag','a','--tag','b','--tag','a'] parses to ['a','b','a'].",
  ],
  [
    "distinct-arrays",
    "Two consecutive parses return distinct arrays; the first is unchanged after the second.",
  ],
  [
    "non-repeatable-refused",
    "A repeated non-repeatable slot is still refused.",
  ],
]);

const pendingCases: readonly RepairCase[] = [
  pending(
    "R01.concurrent-real-state",
    "R01",
    ["F13"],
    "process",
    "T3",
    "Real state add-on transaction and read-back under the one-transaction-per-attachment rule, as a built CLI process.",
  ),
  pending(
    "R08.first-signal-during-validation",
    "R08",
    ["F17"],
    "process",
    "T2",
    "A first SIGINT during validation of a large shared value still exits 130 within the LIFE-3 bound.",
  ),
  pending(
    "R11.rendered-host-rule",
    "R11",
    ["F09"],
    "lint",
    "T7",
    "Generated hosts render the dynamic child_process ban; the programs add-on folder exemption is bound by T2.",
  ),
  pending(
    "R16.authority-denial-owner",
    "R16",
    ["K1"],
    "runtime",
    "T2",
    "Every DOMAIN_AUTHORITY_REQUIRED result names the authority owner and does not reuse the internal-result reason (repaired by c3-t2-writer).",
  ),
  pending(
    "R18.agreement-after-render",
    "R18",
    ["F01"],
    "process",
    "T2",
    "For each admitted R18 fixture, a rendered conforming step resolves to its target and parses.",
  ),
  pending(
    "R18.u2.emission-fallback",
    "R18",
    ["F01"],
    "process",
    "T2",
    "For a5 with a run value outside choices, emission refuses the step and the writer takes the INTERNAL_RESULT_* fallback.",
  ),
];

// R18: each base row runs once per arm and once per construction path.
const r18Arms = ["next", "handoff"] as const;
const r18Paths = ["command", "changing", "raw"] as const;
const r18Rejected: readonly (readonly [string, string])[] = [
  ["r1.missing-operand-caller", "T2op ['{binding.item}'] caller-owned"],
  ["r2.missing-operand-runtime", "T2op ['{runId}']"],
  ["r3.extra-operand", "T2op ['x', '{runId}', 'z']"],
  ["r4.required-option-absent", "Topt ['{binding.v}']"],
  ["r5.option-missing-value", "Topt ['--target']"],
  ["r6.unknown-option", "Topt ['--target', '{runId}', '--nope']"],
  ["r7.repeated-flag", "Topt ['--target', '{runId}', '--dry', '--dry']"],
  ["r8.requires-violated", "Topt ['--dry']"],
  [
    "r9.exclusive-violated",
    "Topt ['--target', '{runId}', '--dry', '--tag', '{runId}']",
  ],
  ["r10.root-empty", "Troot []"],
  ["r11.literal-invalid-value", "Tint ['0']"],
  ["r12.literal-not-choice", "Tmode ['medium']"],
  ["r13.deadline-unsupported", "Tnodl ['--deadline-ms', '{binding.d}']"],
  ["r14.deadline-literal-invalid", "Tdl ['--deadline-ms', 'abc']"],
  ["r15.separator-shift", "T2op ['--', '--x', '{runId}', 'z']"],
  // Added by expectations-f01-ruling.md (sha256 30fb2435...), under R18's rule.
  [
    "r16.repeated-deadline",
    "Tdl ['--deadline-ms', '10', '--deadline-ms', '20']",
  ],
];
const r18Admitted: readonly (readonly [string, string])[] = [
  ["a1.valid-twin", "T2op ['{binding.item}', '{runId}']"],
  ["a2.literal-valid", "Topt ['--target', 'main', '--tag', 'a', '--tag', 'b']"],
  ["a3.runtime-owned", "Topt ['--target', '{runId}', '--dry']"],
  ["a4.value-dependent-integer", "Tint ['{binding.count}'] caller-owned"],
  ["a5.value-dependent-runtime", "Tmode ['{runId}']"],
  ["a6.root-with-flag", "Troot ['--all']"],
  ["a7.deadline-templated", "Tdl ['--deadline-ms', '{binding.d}']"],
  ["a8.separator-literal", "T2op ['--', '--x', '{runId}']"],
];
function r18Derived(): readonly RepairCase[] {
  const cases: RepairCase[] = [];
  for (const [rows, verdict] of [
    [
      r18Rejected,
      "contractFor refuses before any command runs, naming the step",
    ],
    [
      r18Admitted,
      "contractFor admits; discoverCommand shows the template unsubstituted",
    ],
  ] as const)
    for (const [suffix, step] of rows)
      for (const arm of r18Arms)
        for (const path of r18Paths)
          cases.push({
            id: `R18.${suffix}.${arm}.${path}`,
            family: "R18",
            findings: ["F01"],
            layer: "runtime",
            expected: `${step} as a ${arm} step from a ${path} source: ${verdict}.`,
            status: "active",
          });
  return cases;
}
const r18Guards = active("R18", ["F01"], "runtime", [
  [
    "u1.slot-preflight-unchanged",
    "a4 with an invalid caller value is refused before the handler by the existing STEP-10 slot preflight (entries 0); a structurally valid step gets no whole-vector parse before the handler.",
  ],
  [
    "u3.existing-admission-unchanged",
    "An undeclared target, or a handoff inspection naming a changing command, is still refused.",
  ],
  // Added by expectations-f01-ruling.md: the broader-than-R18 refusal keeps
  // its own reason and one rejected case.
  [
    "u4.templated-option-token",
    "Topt ['--target', 'main', '--x{runId}']: contractFor refuses because a run value would select an option, with that reason rather than an unknown-option reason.",
  ],
]);

// Test-owned inputs named by the expectations (R03 causes, R04 tokens, R18 rows).
export const frozenInputs = Object.freeze({
  reservedCauses: reserved,
  optionLikeTokens: optionLike,
  r18Arms,
  r18Paths,
  r18Rejected,
  r18Admitted,
});

export const repairCases: readonly RepairCase[] = Object.freeze(
  [
    ...r01,
    ...r02,
    ...r03,
    ...r04,
    ...r05,
    ...r06,
    ...r07,
    ...r08,
    ...r09,
    ...r10,
    ...r11,
    ...r12,
    ...r13,
    ...r14,
    ...r15,
    ...r17,
    ...r18Derived(),
    ...r18Guards,
    ...pendingCases,
  ].map((item) => Object.freeze(item)),
);

export function familyCases(family: string): readonly RepairCase[] {
  return repairCases.filter(
    (item) => item.family === family && item.status === "active",
  );
}
