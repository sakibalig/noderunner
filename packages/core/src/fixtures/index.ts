import { type RunEvent, RunEvent as RunEventSchema } from "../events.ts";
import { OsvRecord } from "../range.ts";
import lodash from "./osv/GHSA-35jh-r3h4-6jhm.json" with { type: "json" };
import qs from "./osv/GHSA-hrpp-h998-j3pp.json" with { type: "json" };
import run from "./run.json" with { type: "json" };

/** One recorded triage run on fixtures/mini-repo, parsed. */
export const fixtureRun: readonly RunEvent[] = RunEventSchema.array().parse(run);

/** Two real OSV records, fetched 2026-10-15. */
export const osvRecords = {
  lodash: OsvRecord.parse(lodash),
  qs: OsvRecord.parse(qs),
} as const;
