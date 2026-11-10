// Every disagreement the suite tolerates. A step that disagrees fails unless it names one of these entries, and an
// entry whose step stops disagreeing fails too. `wrong` is the side that does not meet the scenario's expectation.
// SQL is never edited from this suite: an SQL entry is a report for the backend owner. A "ts" entry is composition
// in apps/web that the TS driver mirrors (packages/contracts itself has no "ts" entry).
import type { KnownDivergence } from "./model.ts";

export const knownDivergences: readonly KnownDivergence[] = [];
