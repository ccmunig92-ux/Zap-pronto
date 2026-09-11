import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";

const directDatabaseUrl = process.env.DATABASE_URL?.trim();
const databaseUrlFile = process.env.DATABASE_URL_FILE?.trim();
if (directDatabaseUrl && databaseUrlFile) throw new Error("DATABASE_URL_SOURCE_CONFLICT");
let connectionString = directDatabaseUrl;
if (databaseUrlFile) {
  try {
    const value = readFileSync(databaseUrlFile,"utf8");
    if (value.length > 4096) throw new Error("too large");
    connectionString = value.trim();
  } catch { throw new Error("DATABASE_URL_FILE_UNREADABLE"); }
}
if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");

const migrationsDirectory = resolve("database", "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
  .sort((left, right) => left.localeCompare(right));

const client = new pg.Client({ connectionString });
await client.connect();

const normalizeMigrationSql = (sql) => sql.replace(/\r\n?/gu, "\n");
const migrationChecksum = (sql) => createHash("sha256").update(sql).digest("hex");

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
    const sql = normalizeMigrationSql(await readFile(resolve(migrationsDirectory, filename), "utf8"));
    const checksum = migrationChecksum(sql);
    const legacyCrlfChecksum = migrationChecksum(sql.replace(/\n/gu, "\r\n"));
    const existing = await client.query(
      "SELECT checksum_sha256 FROM schema_migrations WHERE filename = $1",
      [filename],
    );

    if (existing.rowCount === 1) {
      const storedChecksum = existing.rows[0].checksum_sha256.trim();
      if (storedChecksum === legacyCrlfChecksum && storedChecksum !== checksum) {
        await client.query(
          "UPDATE schema_migrations SET checksum_sha256 = $1 WHERE filename = $2 AND checksum_sha256 = $3",
          [checksum, filename, storedChecksum],
        );
        process.stdout.write(`normalized checksum ${filename}\n`);
        continue;
      }
      if (storedChecksum !== checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${filename}`);
      }
      continue;
    }

    const transactionalSql = sql
      .replace(/^\s*BEGIN\s*;\s*/i, "")
      .replace(/\s*COMMIT\s*;\s*$/i, "");
    await client.query("BEGIN");
    try {
      await client.query(transactionalSql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1, $2)",
        [filename, checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    process.stdout.write(`applied ${filename}\n`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [820260805]).catch(() => undefined);
  await client.end();
}
