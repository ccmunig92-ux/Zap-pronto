import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const adminConnection = process.env.DATABASE_ADMIN_URL;
if (!adminConnection) throw new Error("DATABASE_ADMIN_URL_REQUIRED");

const databaseName = process.env.TEST_DATABASE_NAME ?? "zap_pronto_automated_test";
if (!/^[a-z][a-z0-9_]{2,62}$/.test(databaseName)) throw new Error("INVALID_TEST_DATABASE_NAME");

const quotedDatabase = `"${databaseName}"`;
const admin = new pg.Client({ connectionString: adminConnection });
await admin.connect();

const targetUrl = new URL(adminConnection);
targetUrl.pathname = `/${databaseName}`;

try {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quotedDatabase}`);

  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    const migration = await readFile(resolve("database/migrations/0001_core.sql"), "utf8");
    await target.query(migration);

    for (const filename of ["0001_rls.sql", "0002_integrity.sql"]) {
      const testSql = await readFile(resolve("database/tests", filename), "utf8");
      await target.query(testSql);
    }

    const role = await target.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'zap_pronto_app'",
    );
    assert.equal(role.rowCount, 1);
    assert.equal(role.rows[0].rolsuper, false);
    assert.equal(role.rows[0].rolbypassrls, false);
    process.stdout.write("database integration tests passed\n");
  } finally {
    await target.end();
  }
} finally {
  if (process.env.KEEP_TEST_DATABASE !== "1") {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  }
  await admin.end();
}
