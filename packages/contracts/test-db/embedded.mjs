import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgtap } from "@electric-sql/pglite/pgtap";

const root = fileURLToPath(new URL("../../../supabase/", import.meta.url));
const prefixRoot = fileURLToPath(new URL("prefix/", import.meta.url));
const writeFixtures = process.argv.includes("--write-fixtures");
const migrations = (await readdir(join(root, "migrations"))).filter((file) => file.endsWith(".sql")).sort();
const suites = (await readdir(join(root, "tests"))).filter((file) => file.endsWith(".sql")).sort();

// Each migration must be valid when applied in order. PL/pgSQL binds names only when a statement runs,
// so these checks apply a prefix of the migrations and exercise the functions it defines.
const prefixChecks = [
  { through: 2, tests: [join(root, "tests", "pickup_lifecycle.test.sql")] },
  { through: 3, tests: [join(prefixRoot, "account_linking.test.sql")] },
  { through: 4, tests: [join(prefixRoot, "operations.test.sql")] },
];

async function run(db, path, label) {
  console.log(label);
  const results = await db.exec(await readFile(path, "utf8"));
  for (const { rows } of results) {
    for (const row of rows) {
      if (typeof row.fixture_name === "string") {
        if (writeFixtures) {
          const output = join(root, "tests", "fixtures");
          await mkdir(output, { recursive: true });
          await writeFile(join(output, `${row.fixture_name}.json`), JSON.stringify(row.payload, null, 2) + "\n");
        }
        continue;
      }
      const line = Object.values(row).filter((value) => typeof value === "string").join(" ");
      if (line) console.log(line);
      if (line.startsWith("not ok") || line.startsWith("# Looks like")) process.exitCode = 1;
    }
  }
}

async function database(through, tests, fixtures) {
  const db = await PGlite.create({ extensions: { pgtap } });
  try {
    await db.exec(await readFile(new URL("auth-shim.sql", import.meta.url), "utf8"));
    for (const file of migrations.slice(0, through)) {
      await db.exec(await readFile(join(root, "migrations", file), "utf8"));
    }
    for (const path of tests) await run(db, path, fixtures ? path.split(/[\\/]/).pop() : `${path.split(/[\\/]/).pop()} after ${migrations[through - 1]}`);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

try {
  for (const check of prefixChecks) {
    const db = await database(check.through, check.tests, false);
    await db.close();
  }
  const db = await database(migrations.length, suites.map((file) => join(root, "tests", file)), true);
  const server = await db.query("show server_version");
  console.log(`Embedded PostgreSQL ${server.rows[0].server_version} with Supabase Auth shim`);
  await db.close();
} catch (error) {
  console.error(error.message, error.code, error.detail, error.where, error.position);
  process.exitCode = 1;
}
