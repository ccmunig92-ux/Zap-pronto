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
    for (const filename of [
      "0001_core.sql",
      "0002_tenant_context_hardening.sql",
      "0003_actor_context_authorization.sql",
    ]) {
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
      INSERT INTO users (id, tenant_id, email, display_name) VALUES
        ('60000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', 'actor-a@test.local', 'Actor A'),
        ('70000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000002', 'actor-b@test.local', 'Actor B');
      INSERT INTO user_units (tenant_id, user_id, unit_id, role)
      SELECT u.tenant_id, u.id, un.id, 'ATTENDANT'
      FROM users u JOIN units un ON un.tenant_id = u.tenant_id
      WHERE u.email IN ('actor-a@test.local', 'actor-b@test.local');
      INSERT INTO channel_connections (id, tenant_id, type, scope, external_account_id) VALUES
        ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'WHATSAPP', 'SINGLE_UNIT', 'account-a'),
        ('51000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'WHATSAPP', 'SINGLE_UNIT', 'account-b');
      INSERT INTO channel_connection_units (tenant_id, channel_connection_id, unit_id)
      SELECT c.tenant_id, c.id, u.id FROM channel_connections c JOIN units u ON u.tenant_id = c.tenant_id;
      INSERT INTO contacts (id, tenant_id, display_name) VALUES
        ('42000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Contact A'),
        ('52000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'Contact B');
      INSERT INTO contact_identities (id, tenant_id, contact_id, channel_connection_id, external_user_id) VALUES
        ('43000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 'external-a'),
        ('53000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'external-b');
      INSERT INTO conversations (id, tenant_id, channel_connection_id, contact_id, contact_identity_id, unit_id) VALUES
        ('44000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A')),
        ('54000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', '53000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'));
      INSERT INTO service_cases (id, tenant_id, conversation_id, unit_id, kind) VALUES
        ('45000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), 'INFORMATION'),
        ('55000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), 'INFORMATION');
      INSERT INTO messages (id, tenant_id, conversation_id, direction, actor, external_message_id, body) VALUES
        ('46000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', 'INBOUND', 'CUSTOMER', 'message-a', 'A'),
        ('56000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', 'INBOUND', 'CUSTOMER', 'message-b', 'B');
      INSERT INTO message_attachments (tenant_id, message_id, media_type, storage_key, mime_type, sha256) VALUES
        ('40000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000001', 'AUDIO', 'tenant-a/audio', 'audio/ogg', repeat('a',64)),
        ('50000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-000000000002', 'AUDIO', 'tenant-b/audio', 'audio/ogg', repeat('b',64));
      INSERT INTO human_handoffs (tenant_id, conversation_id, service_case_id, unit_id, reason, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), 'COMPLETED_COLLECTION', 'handoff-a'),
        ('50000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), 'COMPLETED_COLLECTION', 'handoff-b');
      INSERT INTO catalog_items (id, tenant_id, code, name) VALUES
        ('47000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'ITEM-A', 'Item A'),
        ('57000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'ITEM-B', 'Item B');
      INSERT INTO price_lists (id, tenant_id, unit_id, name) VALUES
        ('48000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), 'List A'),
        ('58000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), 'List B');
      INSERT INTO price_list_versions (id, tenant_id, price_list_id, version, status, effective_at) VALUES
        ('49000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001', 1, 'ACTIVE', now()),
        ('59000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '58000000-0000-4000-8000-000000000002', 1, 'ACTIVE', now());
      INSERT INTO prices (tenant_id, price_list_version_id, catalog_item_id, amount_minor) VALUES
        ('40000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000001', 1000),
        ('50000000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-000000000002', 2000);
      INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', 'conversation', '44000000-0000-4000-8000-000000000001', 'test.a', '{}', 'outbox-a'),
        ('50000000-0000-4000-8000-000000000002', 'conversation', '54000000-0000-4000-8000-000000000002', 'test.b', '{}', 'outbox-b');
      INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id) VALUES
        ('40000000-0000-4000-8000-000000000001', 'USER', 'actor-a', 'TEST', 'tenant', 'a'),
        ('50000000-0000-4000-8000-000000000002', 'USER', 'actor-b', 'TEST', 'tenant', 'b');
    `);

    const runtimeUrl = new URL(targetUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    try {
      const actorAId = "60000000-0000-4000-8000-000000000003";
      const actorBId = "70000000-0000-4000-8000-000000000004";
      const tenantA = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "pool-tenant-a",
        },
        async (client) => client.query("SELECT code, pg_backend_pid() AS backend_pid FROM units ORDER BY code"),
      );
      assert.deepEqual(tenantA.rows.map((row) => row.code), ["POOL-A"]);
      const backendPid = tenantA.rows[0].backend_pid;

      for (const table of protectedTables) {
        const insertPrivilege = await target.query(
          "SELECT has_table_privilege($1, $2, 'INSERT') AS allowed",
          ["zap_pronto_app", `public.${table}`],
        );
        assert.equal(insertPrivilege.rows[0].allowed, true, `${table}:RUNTIME_INSERT_PRIVILEGE_MISSING`);
      }

      for (const table of protectedTables) {
        const result = await withTenantTransaction(
          runtimePool,
          {
            tenantId: "40000000-0000-4000-8000-000000000001",
            actorId: actorAId,
            correlationId: `matrix-select-${table}`,
          },
          async (client) => client.query(`SELECT count(*)::integer AS count FROM "${table}"`),
        );
        assert.equal(result.rows[0].count, 1, `${table}:TENANT_A_VISIBILITY_FAILED`);
      }

      for (const table of protectedTables.filter((name) => name !== "audit_events")) {
        const tenantPredicate = table === "tenants"
          ? "id = '50000000-0000-4000-8000-000000000002'"
          : "tenant_id = '50000000-0000-4000-8000-000000000002'";
        const result = await withTenantTransaction(
          runtimePool,
          {
            tenantId: "40000000-0000-4000-8000-000000000001",
            actorId: actorAId,
            correlationId: `matrix-update-${table}`,
          },
          async (client) => client.query(`UPDATE "${table}" SET ${table === "tenants" ? "name = name" : "tenant_id = tenant_id"} WHERE ${tenantPredicate}`),
        );
        assert.equal(result.rowCount, 0, `${table}:CROSS_TENANT_UPDATE_VISIBLE`);
      }

      for (const table of protectedTables) {
        const tenantColumn = table === "tenants" ? "id" : "tenant_id";
        await assert.rejects(
          withTenantTransaction(
            runtimePool,
            {
              tenantId: "40000000-0000-4000-8000-000000000001",
              actorId: actorAId,
              correlationId: `matrix-insert-${table}`,
            },
            async (client) => client.query(
              `INSERT INTO "${table}"
               SELECT (jsonb_populate_record(
                 NULL::"${table}",
                 to_jsonb(source) || jsonb_build_object('${tenantColumn}', $1::text)
               )).*
               FROM "${table}" source
               LIMIT 1`,
              ["50000000-0000-4000-8000-000000000002"],
            ),
          ),
          (error) => error instanceof Error && "code" in error && error.code === "42501"
            && "routine" in error && error.routine === "ExecWithCheckOptions",
          `${table}:CROSS_TENANT_INSERT_NOT_BLOCKED_BY_RLS`,
        );
      }

      for (const table of protectedTables.filter((name) => name !== "audit_events")) {
        const tenantPredicate = table === "tenants"
          ? "id = '50000000-0000-4000-8000-000000000002'"
          : "tenant_id = '50000000-0000-4000-8000-000000000002'";
        const result = await withTenantTransaction(
          runtimePool,
          {
            tenantId: "40000000-0000-4000-8000-000000000001",
            actorId: actorAId,
            correlationId: `matrix-delete-${table}`,
          },
          async (client) => client.query(`DELETE FROM "${table}" WHERE ${tenantPredicate}`),
        );
        assert.equal(result.rowCount, 0, `${table}:CROSS_TENANT_DELETE_VISIBLE`);
      }

      const auditPrivileges = await target.query(`
        SELECT
          has_table_privilege('zap_pronto_app', 'public.audit_events', 'UPDATE') AS can_update,
          has_table_privilege('zap_pronto_app', 'public.audit_events', 'DELETE') AS can_delete
      `);
      assert.deepEqual(auditPrivileges.rows[0], { can_update: false, can_delete: false });

      for (const [operation, sql] of [
        ["UPDATE", "UPDATE audit_events SET action = action WHERE tenant_id = $1"],
        ["DELETE", "DELETE FROM audit_events WHERE tenant_id = $1"],
      ]) {
        await assert.rejects(
          withTenantTransaction(
            runtimePool,
            {
              tenantId: "40000000-0000-4000-8000-000000000001",
              actorId: actorAId,
              correlationId: `audit-${operation.toLowerCase()}-denied`,
            },
            async (client) => client.query(sql, ["40000000-0000-4000-8000-000000000001"]),
          ),
          (error) => error instanceof Error && "code" in error && error.code === "42501",
        );
      }

      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "50000000-0000-4000-8000-000000000002",
            actorId: actorAId,
            correlationId: "actor-a-cross-tenant-b",
          },
          async (client) => client.query("SELECT code FROM units"),
        ),
        /APP_CONTEXT_UNAUTHORIZED/,
      );

      await assert.rejects(
        async () => {
          const client = await runtimePool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE zap_pronto_app");
            const pid = await client.query("SELECT pg_backend_pid() AS backend_pid");
            assert.equal(pid.rows[0].backend_pid, backendPid);
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
          actorId: actorBId,
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
            actorId: actorAId,
            correlationId: "pool-rollback",
          },
          async () => {
            throw new Error("EXPECTED_CALLBACK_FAILURE");
          },
        ),
        /EXPECTED_CALLBACK_FAILURE/,
      );

      await assert.rejects(
        async () => {
          const client = await runtimePool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE zap_pronto_app");
            const pid = await client.query("SELECT pg_backend_pid() AS backend_pid");
            assert.equal(pid.rows[0].backend_pid, backendPid);
            await client.query("SELECT count(*) FROM units");
          } finally {
            await client.query("ROLLBACK").catch(() => undefined);
            client.release();
          }
        },
        /TENANT_CONTEXT_REQUIRED/,
      );

      const afterRollback = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "50000000-0000-4000-8000-000000000002",
          actorId: actorBId,
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
