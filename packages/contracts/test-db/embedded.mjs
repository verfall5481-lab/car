import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgtap } from "@electric-sql/pglite/pgtap";

const root = fileURLToPath(new URL("../../../supabase/", import.meta.url));
const db = await PGlite.create({ extensions: { pgtap } });
try {
  await db.exec(await readFile(new URL("auth-shim.sql", import.meta.url), "utf8"));
  const server = await db.query("show server_version");
  console.log(`Embedded PostgreSQL ${server.rows[0].server_version} with Supabase Auth shim`);
  for (const directory of ["migrations", "tests"]) {
    const path = join(root, directory);
    const files = (await readdir(path)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      console.log(file);
      const results = await db.exec(await readFile(join(path, file), "utf8"));
      for (const { rows } of results) {
        for (const row of rows) {
          if (typeof row.fixture_name === "string") {
            if (process.argv.includes("--write-fixtures")) {
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
  }
} catch (error) {
  console.error(error.message, error.code, error.detail, error.where, error.position);
  process.exitCode = 1;
} finally {
  await db.close();
}
