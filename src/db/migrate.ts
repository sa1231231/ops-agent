import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "./pool.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    "select filename, checksum from schema_migrations",
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let ran = 0;

  for (const filename of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    const sum = checksum(sql);
    const previous = applied.get(filename);

    if (previous !== undefined) {
      // An edited migration means the DB and the file no longer agree. Silently
      // skipping it would leave the two permanently out of sync, so refuse.
      if (previous !== sum) {
        throw new Error(
          `Migration ${filename} was modified after being applied ` +
            `(recorded ${previous}, file is now ${sum}). ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      continue;
    }

    // Each migration is atomic: Postgres supports transactional DDL, so a
    // failure part-way leaves no half-applied schema behind.
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename, checksum) values ($1, $2)",
        [filename, sum],
      );
    });

    console.log(`[migrate] applied ${filename}`);
    ran++;
  }

  console.log(
    ran === 0
      ? `[migrate] up to date (${files.length} migration(s), nothing to apply)`
      : `[migrate] done — applied ${ran} migration(s)`,
  );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  migrate()
    .then(() => pool.end())
    .catch(async (err: unknown) => {
      console.error(
        "[migrate] failed:",
        err instanceof Error ? err.message : err,
      );
      await pool.end();
      process.exit(1);
    });
}
