import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");

const migrationsDirectory = resolve("database", "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
  .sort((left, right) => left.localeCompare(right));

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query("SELECT pg_advisory_lock($1)", [820260805]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum_sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const filename of migrationFiles) {
    const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      "SELECT checksum_sha256 FROM schema_migrations WHERE filename = $1",
      [filename],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0].checksum_sha256.trim() !== checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${filename}`);
      }
      continue;
    }

    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1, $2)",
      [filename, checksum],
    );
    process.stdout.write(`applied ${filename}\n`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [820260805]).catch(() => undefined);
  await client.end();
}
