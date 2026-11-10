// One scenario table, two implementations: the TypeScript machine with the composition the browser demo calls
// (src/index.ts, src/composition.ts) and the SQL RPCs on the real migrations in PGlite. See model.ts for the
// vocabulary and compare.ts for what "agree" means.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { inherentGaps, judge } from "./compare.ts";
import { knownDivergences } from "./known-divergences.ts";
import { scenarios } from "./scenarios.ts";
import { bootDatabase, runSql } from "./sql-driver.ts";
import { runTs } from "./ts-driver.ts";

const db = await bootDatabase();
after(() => db.close());

const seen = new Set<string>();

for (const scenario of scenarios) {
  test(scenario.name, async (t) => {
    const verdict = judge(scenario, runTs(scenario), await runSql(db, scenario), knownDivergences);
    for (const line of verdict.tolerated) {
      seen.add(line.split(" ")[0]);
      t.diagnostic(`known divergence ${line}`);
    }
    assert.deepEqual(verdict.failures, []);
  });
}

test("every known divergence is reproduced by a scenario", () => {
  const unused = knownDivergences.filter(({ id }) => !seen.has(id)).map(({ id }) => id);
  assert.deepEqual(unused, []);
  for (const entry of knownDivergences) {
    console.log(`# known divergence [${entry.wrong} wrong] ${entry.id}: ${entry.summary} (${entry.spec})`);
  }
  for (const gap of inherentGaps) console.log(`# not comparable: ${gap.field}: ${gap.reason}`);
});
