import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { withTenantTransaction } from "../dist/database/tenant-transaction.js";

const adminConnection = process.env.DATABASE_ADMIN_URL;
if (!adminConnection) throw new Error("DATABASE_ADMIN_URL_REQUIRED");

const databaseName = process.env.TEST_DATABASE_NAME ?? "zap_pronto_automated_test";
if (!/^[a-z][a-z0-9_]{2,62}$/.test(databaseName)) throw new Error("INVALID_TEST_DATABASE_NAME");

const quotedDatabase = `"${databaseName}"`;
const admin = new pg.Client({ connectionString: adminConnection });
await admin.connect();
const runtimeRole = `zap_pronto_runtime_test_${randomBytes(4).toString("hex")}`;
const runtimePassword = randomBytes(24).toString("base64url");
const quotedRuntimeRole = `"${runtimeRole}"`;

const targetUrl = new URL(adminConnection);
targetUrl.pathname = `/${databaseName}`;

try {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quotedDatabase}`);

  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    for (const filename of ["0001_core.sql", "0002_tenant_context_hardening.sql"]) {
      const migration = await readFile(resolve("database/migrations", filename), "utf8");
      await target.query(migration);
    }

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

    const escapedPassword = runtimePassword.replaceAll("'", "''");
    await admin.query(
      `CREATE ROLE ${quotedRuntimeRole} LOGIN PASSWORD '${escapedPassword}' ` +
        "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT",
    );
    await admin.query(`GRANT zap_pronto_app TO ${quotedRuntimeRole}`);

    const runtimeProperties = await admin.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [runtimeRole],
    );
    assert.deepEqual(runtimeProperties.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    const protectedTables = [
      "audit_events", "catalog_items", "channel_connection_units", "channel_connections",
      "contact_identities", "contacts", "conversations", "human_handoffs", "message_attachments",
      "messages", "outbox_events", "price_list_versions", "price_lists", "prices", "service_cases",
      "tenants", "units", "user_units", "users",
    ];
    const rlsCatalog = await target.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             count(p.policyname)::integer AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `);
    assert.deepEqual(rlsCatalog.rows.map((row) => row.relname), protectedTables);
    for (const table of rlsCatalog.rows) {
      assert.equal(table.relrowsecurity, true, `${table.relname}:RLS_DISABLED`);
      assert.equal(table.relforcerowsecurity, true, `${table.relname}:FORCE_RLS_DISABLED`);
      assert.ok(table.policy_count >= 1, `${table.relname}:POLICY_MISSING`);
    }

    const runtimeOwnedTables = await target.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND r.rolname = $1
    `, [runtimeRole]);
    assert.equal(runtimeOwnedTables.rowCount, 0);

    await target.query(`
      INSERT INTO tenants (id, name) VALUES
        ('40000000-0000-4000-8000-000000000001', 'Pool Tenant A'),
        ('50000000-0000-4000-8000-000000000002', 'Pool Tenant B');
      INSERT INTO units (tenant_id, code, name) VALUES
        ('40000000-0000-4000-8000-000000000001', 'POOL-A', 'Pool A'),
        ('50000000-0000-4000-8000-000000000002', 'POOL-B', 'Pool B');
    `);

    const runtimeUrl = new URL(targetUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    try {
      const actorId = "60000000-0000-4000-8000-000000000003";
      const tenantA = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId,
          correlationId: "pool-tenant-a",
        },
        async (client) => client.query("SELECT code FROM units ORDER BY code"),
      );
      assert.deepEqual(tenantA.rows.map((row) => row.code), ["POOL-A"]);

      await assert.rejects(
        async () => {
          const client = await runtimePool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE zap_pronto_app");
            await client.query("SELECT count(*) FROM units");
          } finally {
            await client.query("ROLLBACK").catch(() => undefined);
            client.release();
          }
        },
        /TENANT_CONTEXT_REQUIRED/,
      );

      const tenantB = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "50000000-0000-4000-8000-000000000002",
          actorId,
          correlationId: "pool-tenant-b",
        },
        async (client) => client.query("SELECT code FROM units ORDER BY code"),
      );
      assert.deepEqual(tenantB.rows.map((row) => row.code), ["POOL-B"]);

      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "40000000-0000-4000-8000-000000000001",
            actorId,
            correlationId: "pool-rollback",
          },
          async () => {
            throw new Error("EXPECTED_CALLBACK_FAILURE");
          },
        ),
        /EXPECTED_CALLBACK_FAILURE/,
      );

      const afterRollback = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "50000000-0000-4000-8000-000000000002",
          actorId,
          correlationId: "pool-after-rollback",
        },
        async (client) => client.query("SELECT code FROM units ORDER BY code"),
      );
      assert.deepEqual(afterRollback.rows.map((row) => row.code), ["POOL-B"]);
    } finally {
      await runtimePool.end();
    }
    process.stdout.write("database integration tests passed\n");
  } finally {
    await target.end();
  }
} finally {
  if (process.env.KEEP_TEST_DATABASE !== "1") {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  }
  await admin.query(`DROP ROLE IF EXISTS ${quotedRuntimeRole}`).catch(() => undefined);
  await admin.end();
}
