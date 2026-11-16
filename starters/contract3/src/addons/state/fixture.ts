// LABELLED TEST-ONLY MODULE. It supplies a fixture qualification to a test
// host so recovery transitions can be exercised before any environment row
// is reviewed. It never writes the production table; every closure it
// enables is stamped `fixture:<label>`; a fixture pass never enables a
// capability (Q01). Host source must not import this module.
import { registerFixture } from "./qualification.ts";
import type { Qualification } from "./qualification.ts";

export function fixtureQualification(label: string): Qualification {
  return registerFixture({ label, stoppedOwner: "lease-and-no-delegate" });
}
