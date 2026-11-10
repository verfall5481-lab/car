// Every disagreement the suite tolerates. A step that disagrees fails unless it names one of these entries, and an
// entry whose step stops disagreeing fails too. `wrong` is the side that does not meet the scenario's expectation.
// SQL is never edited from this suite: an SQL entry is a report for the backend owner. The list is empty: every
// disagreement found so far was fixed on one side (see the scenario names for the SPEC rows they settle).
import type { KnownDivergence } from "./model.ts";

export const knownDivergences: readonly KnownDivergence[] = [];
