export const locks = [
  {
    id: "N1",
    code: 2322,
    setup: "",
    invalid: "const result: F.Result = { ...F.unknown, retryable: true };",
    valid: "const result: F.Result = F.unknown;",
  },
  {
    id: "N2",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.Result = { ...F.refusal, failureClass: "internal" };',
    valid: "const result: F.Result = F.refusal;",
  },
  {
    id: "N3",
    code: 2322,
    setup: "",
    invalid: "const result: F.Result = { ...F.refusal, handoff: F.handoff };",
    valid: "const result: F.Result = F.refusal;",
  },
  {
    id: "N4",
    code: 2322,
    setup: "const { handoff, ...facts } = F.partial; void handoff;",
    invalid:
      'const result: F.Result = { ...facts, next: { kind: "instruction", text: "Inspect." } };',
    valid: "const result: F.Result = { ...facts, handoff: F.handoff };",
  },
  {
    id: "N5",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.Result = { ...F.success, transactionState: "unknown" };',
    valid: "const result: F.Result = F.success;",
  },
  {
    id: "N6",
    code: 2375,
    setup: "",
    invalid: "const result: F.Handoff = { ...F.handoff, resource: undefined };",
    valid: "const result: F.Handoff = F.handoff;",
  },
  {
    id: "N7",
    code: 2322,
    setup:
      "declare const authority: F.AuthorityId; declare const resource: F.ResourceId;",
    invalid: "const result: F.AuthorityId = resource;",
    valid: "const result: F.AuthorityId = authority;",
  },
  {
    id: "N8",
    code: 2322,
    setup: "declare const path: F.ParsedPath;",
    invalid: 'const result: F.ParsedPath = "/tmp/file";',
    valid: "const result: F.ParsedPath = path;",
  },
  {
    id: "N9",
    code: 2322,
    setup: "",
    invalid: "const result: F.ExitCode = 42;",
    valid: "const result: F.ExitCode = 3;",
  },
  {
    id: "N10",
    code: 2540,
    setup: "",
    invalid: "F.exits.domain = 3;",
    valid: "const result: F.ExitCode = F.exits.domain;",
  },
  {
    id: "M1",
    code: 2322,
    setup:
      "const { retryDelayMilliseconds, ...facts } = F.retry; void retryDelayMilliseconds;",
    invalid: "const result: F.Result = facts;",
    valid: "const result: F.Result = { ...facts, retryDelayMilliseconds: 10 };",
  },
  {
    id: "M2",
    code: 2322,
    setup: "",
    invalid:
      "const result: F.Result = { ...F.partial, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } };",
    valid: "const result: F.Result = F.partial;",
  },
  {
    id: "M3",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.Result = { ...F.unknown, effectClass: "inspect" };',
    valid: 'const result: F.Result = { ...F.refusal, effectClass: "inspect" };',
  },
  {
    id: "R1",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.Result = { ...F.refusal, transactionState: "unknown" };',
    valid: "const result: F.Result = F.refusal;",
  },
  {
    id: "R2",
    code: 2322,
    setup: "",
    invalid: "const result: F.JsonValue = new Date();",
    valid: 'const result: F.JsonValue = "2026-11-16";',
  },
  {
    id: "R3",
    code: 2322,
    setup: "",
    invalid: "const result: F.JsonValue = { nested: { absent: undefined } };",
    valid: "const result: F.JsonValue = { nested: { absent: null } };",
  },
  {
    id: "R4",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.Result = { ...F.refusal, transactionState: "completed" };',
    valid: "const result: F.Result = F.refusal;",
  },
  {
    id: "P1",
    code: 2322,
    setup: "const { next, ...facts } = F.journal; void next;",
    invalid: "const result: F.ExemplarResult = facts;",
    valid:
      "const result: F.ExemplarResult = { ...facts, next: F.journal.next };",
  },
  {
    id: "P2",
    code: 2322,
    setup: "const { handoff, ...facts } = F.prior; void handoff;",
    invalid: "const result: F.ExemplarResult = facts;",
    valid: "const result: F.ExemplarResult = { ...facts, handoff: F.handoff };",
  },
  {
    id: "P3",
    code: 2322,
    setup: "",
    invalid:
      'const result: F.ExemplarResult = { ...F.recovered, transactionState: "unknown" };',
    valid: "const result: F.ExemplarResult = F.recovered;",
  },
  {
    id: "K1",
    code: 2339,
    setup: "declare const request: F.ProgramRequest;",
    invalid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, run: (_input, context) => { void context.programs.inspect(request); return context.result(F.defaultSelection, F.runFacts); } });',
    valid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: { programs: true }, run: (_input, context) => { void context.programs.inspect(request); return context.result(F.defaultSelection, F.runFacts); } });',
  },
  {
    id: "K2",
    code: 2741,
    ts6Code: 2345,
    attribution:
      "Native reports the missing ifNoResult property directly; TS6 wraps it as argument incompatibility. Both reject the same property omission at line 4.",
    setup:
      'declare const route: F.IfNoResult; declare const result: F.CommandResult<"specimen.change">; const spec = { identity: "specimen.change", route: ["change"], summary: "Change.", input: F.input, capabilities: {}, effectClass: "repository-local", effects: ["write"], heldLockCause: "HELD", unresolvedCaseCause: "PRIOR", stations: [], run: () => Promise.resolve(result) } as const;',
    invalid: "F.changing(spec);",
    valid: "F.changing({ ...spec, ifNoResult: route });",
  },
  {
    id: "K3",
    code: 2739,
    ts6Code: 2345,
    attribution:
      "Native reports missing recorded-effect members directly; TS6 wraps them as argument incompatibility. Both reject the same capability forgery at line 4.",
    setup:
      'declare const programs: F.ProgramsCapability; declare const effect: F.RecordedEffect<"write">;',
    invalid: 'programs.domain({ runId: "run-1", effect: "write" });',
    valid: "programs.domain(effect);",
  },
  {
    id: "K4",
    code: 2345,
    setup: 'declare const transaction: F.EffectTransaction<"write">;',
    invalid:
      'void transaction.record("erase", async () => null, async () => true);',
    valid:
      'void transaction.record("write", async () => null, async () => true);',
  },
  {
    id: "K5",
    code: 2741,
    setup: "declare const route: F.IfNoResult;",
    invalid:
      'const result: F.IfNoResult = { step: { kind: "command", command: "specimen.report", args: [] } };',
    valid: "const result: F.IfNoResult = route;",
  },
  {
    id: "K6",
    code: 2339,
    setup: "",
    invalid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, run: (_input, context) => { void context.state.transaction(async () => {}); return context.result(F.defaultSelection, F.runFacts); } });',
    valid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, run: (_input, context) => context.result(F.defaultSelection, F.runFacts) });',
  },
  {
    id: "S1",
    code: 2719,
    setup: "",
    invalid:
      'F.contractFor({ cli: "specimen", commands: [F.inspectFor("specimen.missing")] });',
    valid:
      'F.contractFor({ cli: "specimen", commands: [F.inspectFor("specimen.inspect")] });',
  },
  {
    id: "S3",
    code: 2322,
    setup:
      'const spec = { identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, stations: [F.inspectStation] } as const;',
    invalid:
      'const first = F.command({ ...spec, run: (_input, context) => context.result({ commandIdentity: "specimen.inspect", causeCode: F.otherSuccessStation.causeCode }, F.runFacts) }); F.contractFor({ cli: "specimen", commands: [first, F.other] });',
    valid:
      'const first = F.command({ ...spec, run: (_input, context) => context.result(F.inspectStation, F.runFacts) }); F.contractFor({ cli: "specimen", commands: [first, F.other] });',
  },
  {
    id: "S4",
    code: 2345,
    setup:
      'const spec = { identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, stations: [F.inspectStation] } as const;',
    invalid:
      'const first = F.command({ ...spec, run: (_input, context) => context.result(F.otherStation, F.runFacts) }); F.contractFor({ cli: "specimen", commands: [first, F.other] });',
    valid:
      'const first = F.command({ ...spec, run: (_input, context) => context.result(F.inspectStation, F.runFacts) }); F.contractFor({ cli: "specimen", commands: [first, F.other] });',
  },
  {
    id: "S7",
    code: 2719,
    setup:
      'declare const changing: Omit<F.CommandDeclaration<"specimen.change">, "stations" | "effectClass"> & { readonly effectClass: "repository-local"; readonly stations: readonly [] };',
    invalid:
      'F.contractFor({ cli: "specimen", causes: F.exemplarCauses, commands: [F.reportFor("specimen.change"), changing, F.inspect] });',
    valid:
      'F.contractFor({ cli: "specimen", causes: F.exemplarCauses, commands: [F.reportFor("specimen.inspect"), changing, F.inspect] });',
  },
  {
    id: "S2",
    code: 2540,
    setup:
      'const selected = F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "instruction", text: "Inspect." } } });',
    invalid: 'selected.guidance.next = { kind: "done" };',
    valid: "const result = selected.guidance.next;",
  },
  {
    id: "S5",
    code: 2345,
    setup: "",
    invalid:
      'F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "retry" } } });',
    valid:
      'F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "instruction", text: "Inspect." } } });',
  },
  {
    id: "S6",
    code: 2345,
    setup: "",
    invalid:
      'F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "DOMAIN_PRECONDITION_UNMET", guidance: { next: { kind: "done" } } });',
    valid:
      'F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "SUCCESS_UNCHANGED", repairAction: null, guidance: { next: { kind: "done" } } });',
  },
  {
    id: "W1",
    code: 2375,
    setup: "declare const wire: F.WireResult;",
    invalid: "const result: F.Result = wire;",
    valid: "const result: F.WireResult = F.success;",
  },
] as const;

export const exhaustiveness = [
  {
    id: "full-record",
    code: 2741,
    setup: 'type Outcome = "success" | "refused";',
    invalid: "const table: Record<Outcome, number> = { success: 0 };",
    valid: "const table: Record<Outcome, number> = { success: 0, refused: 3 };",
  },
  {
    id: "assert-never",
    code: 2345,
    setup:
      "function assertNever(value: never): never { throw new Error(String(value)); }",
    invalid:
      'function classify(value: "success" | "refused"): number { if (value === "success") return 0; return assertNever(value); }',
    valid:
      'function classify(value: "success" | "refused"): number { if (value === "success") return 0; if (value === "refused") return 3; return assertNever(value); }',
  },
] as const;

export const boundaries = [
  {
    id: "global-undeclared-cause",
    code: 2345,
    setup:
      'const contract = F.contractFor({ cli: "specimen", commands: [F.inspect] }); const undeclared = F.station(F.commonCauses, { ...F.words, commandIdentity: "specimen.inspect", causeCode: "SUCCESS_UNCHANGED", repairAction: null, guidance: { next: { kind: "done" } } });',
    invalid: "void contract.build(undeclared, F.runFacts);",
    valid: "void contract.build(F.inspectStation, F.runFacts);",
  },
  {
    id: "global-undeclared-command",
    code: 2345,
    setup:
      'const contract = F.contractFor({ cli: "specimen", commands: [F.inspect] });',
    invalid: "void contract.build(F.otherStation, F.runFacts);",
    valid: "void contract.build(F.inspectStation, F.runFacts);",
  },
  {
    id: "handler-result-global-envelope",
    code: 2322,
    setup:
      'const contract = F.contractFor({ cli: "specimen", commands: [F.inspect] }); const built = await contract.build(F.inspectStation, F.runFacts); if (!built.ok) throw new Error("Invalid fixture."); const value = built.value; const spec = { identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, stations: [F.inspectStation] } as const;',
    invalid: "F.command({ ...spec, run: () => value });",
    valid:
      "F.command({ ...spec, run: (_input, context) => context.result(F.inspectStation, F.runFacts) });",
  },
  {
    id: "next-full-discovery",
    code: 2719,
    setup: "",
    invalid:
      'F.contractFor({ cli: "specimen", commands: [F.inspectFor("specimen.no-such-built-in")] });',
    valid:
      'F.contractFor({ cli: "specimen", commands: [F.inspectFor("specimen.full-discovery")] });',
  },
  {
    id: "handoff-full-discovery",
    code: 2719,
    setup: "",
    invalid:
      'F.contractFor({ cli: "specimen", causes: F.exemplarCauses, commands: [F.reportFor("specimen.no-such-built-in")] });',
    valid:
      'F.contractFor({ cli: "specimen", causes: F.exemplarCauses, commands: [F.reportFor("specimen.full-discovery")] });',
  },
  {
    id: "unknown-declaration-renamed-from",
    code: 2353,
    setup: "",
    invalid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, renamedFrom: [["old"]], run: (_input, context) => context.result(F.defaultSelection, F.runFacts) });',
    valid:
      'F.command({ identity: "specimen.inspect", route: ["inspect"], summary: "Inspect.", input: F.input, capabilities: {}, run: (_input, context) => context.result(F.defaultSelection, F.runFacts) });',
  },
  {
    id: "unknown-declaration-renamed-from-changing",
    code: 2353,
    setup:
      'declare const route: F.IfNoResult; declare const result: F.CommandResult<"specimen.change">;',
    invalid:
      'F.changing({ identity: "specimen.change", route: ["change"], summary: "Change.", input: F.input, capabilities: {}, effectClass: "repository-local", effects: ["write"], ifNoResult: route, heldLockCause: "HELD", unresolvedCaseCause: "PRIOR", stations: [], renamedFrom: [["old"]], run: () => Promise.resolve(result) });',
    valid:
      'F.changing({ identity: "specimen.change", route: ["change"], summary: "Change.", input: F.input, capabilities: {}, effectClass: "repository-local", effects: ["write"], ifNoResult: route, heldLockCause: "HELD", unresolvedCaseCause: "PRIOR", stations: [], run: () => Promise.resolve(result) });',
  },
] as const;
