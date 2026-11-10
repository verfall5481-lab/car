// One scenario table, two implementations: `applyPickupAction` (as the browser demo composes it) and the SQL RPCs
// on the real migrations in PGlite. See model.ts for the vocabulary and compare.ts for what "agree" means.
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
    const sql = await runSql(db, scenario);
    for (const shape of scenario.shapes ?? ["spec", "demo"] as const) {
      await t.test(`TS (${shape} shape) agrees with SQL`, () => {
        const verdict = judge(scenario, shape, runTs(scenario, shape), sql, knownDivergences);
        for (const line of verdict.tolerated) {
          seen.add(line.split(" ")[0]);
          t.diagnostic(`known divergence ${line}`);
        }
        assert.deepEqual(verdict.failures, []);
      });
    }
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
