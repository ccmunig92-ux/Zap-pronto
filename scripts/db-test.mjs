import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { withTenantTransaction } from "../dist/database/tenant-transaction.js";
import { claimHandoff, requestHandoff } from "../dist/domain/handoffs.js";
import { acceptQuote, approveQuoteReview, cancelQuote, createReadyQuote, expireQuote, publishPriceListVersion, sendQuote } from "../dist/domain/quotes.js";
import { applyMedicalOrderExtraction, markMedicalOrderUnreadable, receiveMedicalOrder, reviewMedicalOrder } from "../dist/domain/medical-orders.js";
import { listAdministrativeInvitations, listAdministrativeUsers } from "../dist/domain/user-administration.js";
import { buildApp } from "../apps/api/dist/app.js";

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
const workerRuntimeRole = `zap_pronto_worker_test_${randomBytes(4).toString("hex")}`;
const workerRuntimePassword = randomBytes(24).toString("base64url");
const quotedWorkerRuntimeRole = `"${workerRuntimeRole}"`;

const targetUrl = new URL(adminConnection);
targetUrl.pathname = `/${databaseName}`;

try {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quotedDatabase}`);

  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    await target.query(`
      CREATE TABLE schema_migrations (
        filename text PRIMARY KEY,
        checksum_sha256 char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const filename of [
      "0001_core.sql",
      "0002_tenant_context_hardening.sql",
      "0003_actor_context_authorization.sql",
      "0004_component_roles.sql",
      "0005_workflow_foundation.sql",
      "0006_outbox_worker.sql",
      "0007_quotes.sql",
      "0008_medical_orders.sql",
      "0009_phase2_hardening.sql",
      "0010_identity_rbac.sql",
      "0011_permission_policy.sql",
      "0012_user_lifecycle.sql",
      "0013_admin_invitations.sql",
      "0014_invitation_user_lifecycle.sql",
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

    const cleanMemberships = await admin.query(`
      SELECT component.rolname,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member = component.oid) AS parent_count,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.roleid = component.oid) AS member_count
      FROM pg_roles component
      WHERE component.rolname IN ('zap_pronto_app', 'zap_pronto_api', 'zap_pronto_worker')
      ORDER BY component.rolname
    `);
    assert.deepEqual(cleanMemberships.rows, [
      { rolname: "zap_pronto_api", parent_count: 0, member_count: 0 },
      { rolname: "zap_pronto_app", parent_count: 0, member_count: 0 },
      { rolname: "zap_pronto_worker", parent_count: 0, member_count: 0 },
    ]);

    const escapedPassword = runtimePassword.replaceAll("'", "''");
    await admin.query(
      `CREATE ROLE ${quotedRuntimeRole} LOGIN PASSWORD '${escapedPassword}' ` +
        "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT",
    );
    await admin.query(`GRANT zap_pronto_api TO ${quotedRuntimeRole}`);
    const escapedWorkerPassword = workerRuntimePassword.replaceAll("'", "''");
    await admin.query(
      `CREATE ROLE ${quotedWorkerRuntimeRole} LOGIN PASSWORD '${escapedWorkerPassword}' ` +
        "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT",
    );
    await admin.query(`GRANT zap_pronto_worker TO ${quotedWorkerRuntimeRole}`);

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
    const crossMembership = await admin.query(`
      SELECT
        pg_has_role($1, 'zap_pronto_worker', 'MEMBER') AS api_is_worker,
        pg_has_role($2, 'zap_pronto_api', 'MEMBER') AS worker_is_api
    `, [runtimeRole, workerRuntimeRole]);
    assert.deepEqual(crossMembership.rows[0], { api_is_worker: false, worker_is_api: false });

    const catalogTables = ["app_permissions", "app_role_permissions", "app_roles"];
    const protectedTables = [
      "audit_events", "catalog_items", "channel_connection_units", "channel_connections",
      "contact_identities", "contacts", "conversations", "human_handoffs",
      "medical_order_items", "medical_order_pages", "medical_order_review_events", "medical_orders",
      "message_attachments", "messages", "oidc_providers", "outbox_events", "price_list_versions", "price_lists", "prices",
      "quote_events", "quote_items", "quotes", "service_cases", "tenants", "units", "user_units", "users", "workflow_transitions",
      "user_invitations", "user_invitation_units", "user_lifecycle_commands", "user_oidc_identities",
    ];
    protectedTables.sort();
    const allProtectedTables = [...catalogTables, ...protectedTables].sort();
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
    assert.deepEqual(rlsCatalog.rows.map((row) => row.relname), allProtectedTables);
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

    const roleSecurity = await admin.query(`
      SELECT role.rolname, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
             role.rolcreaterole, role.rolreplication, role.rolbypassrls,
             (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member = role.oid) AS parent_count,
             (SELECT count(*)::integer FROM pg_auth_members m WHERE m.roleid = role.oid) AS member_count
      FROM pg_roles role
      WHERE role.rolname IN ('zap_pronto_app', 'zap_pronto_api', 'zap_pronto_worker')
      ORDER BY role.rolname
    `);
    assert.equal(roleSecurity.rowCount, 3);
    for (const role of roleSecurity.rows) {
      assert.deepEqual(
        {
          rolcanlogin: role.rolcanlogin,
          rolsuper: role.rolsuper,
          rolcreatedb: role.rolcreatedb,
          rolcreaterole: role.rolcreaterole,
          rolreplication: role.rolreplication,
          rolbypassrls: role.rolbypassrls,
          parent_count: role.parent_count,
          member_count: role.member_count,
        },
        {
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          parent_count: 0,
          member_count: role.rolname === "zap_pronto_app" ? 0 : 1,
        },
        `${role.rolname}:UNSAFE_ROLE_CONFIGURATION`,
      );
    }

    const apiWritable = new Set([
      "units", "channel_connections", "channel_connection_units",
      "contacts", "contact_identities", "conversations", "service_cases", "message_attachments",
      "human_handoffs", "catalog_items", "price_lists", "price_list_versions", "prices",
      "quotes", "medical_orders", "medical_order_pages", "medical_order_items",
    ]);
    const apiInsertOnly = new Set([
      "messages", "audit_events", "workflow_transitions", "quote_items",
      "medical_order_review_events",
    ]);
    const apiHidden = new Set(["user_invitations", "user_invitation_units", "user_lifecycle_commands"]);
    const workerReadable = new Set([
      "tenants", "units", "channel_connections", "channel_connection_units", "contacts",
      "contact_identities", "conversations", "service_cases", "messages", "message_attachments",
      "human_handoffs", "outbox_events",
    ]);

    for (const table of allProtectedTables) {
      for (const role of ["zap_pronto_app", "zap_pronto_api", "zap_pronto_worker"]) {
        const privileges = await target.query(`
          SELECT
            has_table_privilege($1, $2, 'SELECT') AS can_select,
            has_table_privilege($1, $2, 'INSERT') AS can_insert,
            has_table_privilege($1, $2, 'UPDATE') AS can_update,
            has_table_privilege($1, $2, 'DELETE') AS can_delete
        `, [role, `public.${table}`]);
        const expected = role === "zap_pronto_api"
          ? {
              can_select: !apiHidden.has(table),
              can_insert: apiWritable.has(table) || apiInsertOnly.has(table),
              can_update: apiWritable.has(table),
              can_delete: false,
            }
          : role === "zap_pronto_worker"
            ? {
                can_select: workerReadable.has(table),
                can_insert: table === "audit_events",
                can_update: false,
                can_delete: false,
              }
            : { can_select: false, can_insert: false, can_update: false, can_delete: false };
        assert.deepEqual(privileges.rows[0], expected, `${role}:${table}:PRIVILEGE_MATRIX_MISMATCH`);
      }
    }

    const outboxColumnPrivileges = await target.query(`
      SELECT
        has_column_privilege('zap_pronto_api', 'outbox_events', 'tenant_id', 'INSERT') AS api_can_enqueue_tenant,
        has_column_privilege('zap_pronto_api', 'outbox_events', 'status', 'INSERT') AS api_can_forge_status,
        has_function_privilege('zap_pronto_worker', 'claim_outbox_events(integer,integer)', 'EXECUTE') AS worker_can_claim,
        has_function_privilege('zap_pronto_api', 'claim_outbox_events(integer,integer)', 'EXECUTE') AS api_can_claim
    `);
    assert.deepEqual(outboxColumnPrivileges.rows[0], {
      api_can_enqueue_tenant: true,
      api_can_forge_status: false,
      worker_can_claim: true,
      api_can_claim: false,
    });
    const executorRole = await admin.query(`
      SELECT role.rolcanlogin, role.rolsuper, role.rolbypassrls,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member = role.oid) AS parent_count,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.roleid = role.oid) AS member_count
      FROM pg_roles role WHERE role.rolname = 'zap_pronto_outbox_executor'
    `);
    assert.deepEqual(executorRole.rows[0], {
      rolcanlogin: false, rolsuper: false, rolbypassrls: false, parent_count: 0, member_count: 0,
    });
    const quoteExecutorRole = await admin.query(`
      SELECT role.rolcanlogin, role.rolsuper, role.rolbypassrls,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member = role.oid) AS parent_count,
        (SELECT count(*)::integer FROM pg_auth_members m WHERE m.roleid = role.oid) AS member_count
      FROM pg_roles role WHERE role.rolname = 'zap_pronto_quote_event_executor'
    `);
    assert.deepEqual(quoteExecutorRole.rows[0], {
      rolcanlogin: false, rolsuper: false, rolbypassrls: false, parent_count: 0, member_count: 0,
    });

    for (const role of ["zap_pronto_app", "zap_pronto_api", "zap_pronto_worker"]) {
      const migrationsPrivilege = await target.query(
        "SELECT has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS allowed",
        [role],
      );
      assert.equal(migrationsPrivilege.rows[0].allowed, false, `${role}:SCHEMA_MIGRATIONS_EXPOSED`);
    }

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
      INSERT INTO message_attachments (id, tenant_id, message_id, media_type, storage_key, mime_type, sha256) VALUES
        ('4c000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000001', 'DOCUMENT', 'tenant-a/order.pdf', 'application/pdf', repeat('a',64)),
        ('5c000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-000000000002', 'DOCUMENT', 'tenant-b/order.pdf', 'application/pdf', repeat('b',64));
      INSERT INTO medical_orders
        (id, tenant_id, service_case_id, conversation_id, unit_id, message_id, message_attachment_id,
         document_sha256, page_count, idempotency_key) VALUES
        ('4d000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), '46000000-0000-4000-8000-000000000001', '4c000000-0000-4000-8000-000000000001', repeat('a',64), 1, 'medical-seed-a'),
        ('5d000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), '56000000-0000-4000-8000-000000000002', '5c000000-0000-4000-8000-000000000002', repeat('b',64), 1, 'medical-seed-b');
      UPDATE medical_orders SET status='PROCESSING',version=version+1 WHERE status='RECEIVED';
      INSERT INTO medical_order_pages (id, tenant_id, medical_order_id, page_number) VALUES
        ('4e000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001', 1),
        ('5e000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-000000000002', 1);
      INSERT INTO medical_order_items
        (id, tenant_id, medical_order_id, page_id, sequence, raw_text) VALUES
        ('4f000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-000000000001', 1, 'Seed A'),
        ('5f000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-000000000002', '5e000000-0000-4000-8000-000000000002', 1, 'Seed B');
      INSERT INTO medical_order_review_events
        (tenant_id, medical_order_id, medical_order_item_id, action, actor_id, correlation_id, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001', '4f000000-0000-4000-8000-000000000001', 'CONFIRMED', '60000000-0000-4000-8000-000000000003', 'medical-seed-a', 'medical-event-a'),
        ('50000000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-000000000002', '5f000000-0000-4000-8000-000000000002', 'CONFIRMED', '70000000-0000-4000-8000-000000000004', 'medical-seed-b', 'medical-event-b');
      INSERT INTO human_handoffs (tenant_id, conversation_id, service_case_id, unit_id, reason, status, queued_at, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), 'COMPLETED_COLLECTION', 'QUEUED', now(), 'handoff-a'),
        ('50000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), 'COMPLETED_COLLECTION', 'QUEUED', now(), 'handoff-b');
      INSERT INTO catalog_items (id, tenant_id, code, name) VALUES
        ('47000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'ITEM-A', 'Item A'),
        ('57000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'ITEM-B', 'Item B');
      INSERT INTO price_lists (id, tenant_id, unit_id, name) VALUES
        ('48000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), 'List A'),
        ('58000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), 'List B');
      INSERT INTO price_list_versions (id, tenant_id, price_list_id, version, status, effective_at) VALUES
        ('49000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001', 1, 'DRAFT', now()),
        ('59000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '58000000-0000-4000-8000-000000000002', 1, 'DRAFT', now());
      INSERT INTO prices (tenant_id, price_list_version_id, catalog_item_id, amount_minor) VALUES
        ('40000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000001', 1000),
        ('50000000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-000000000002', 2000);
      UPDATE price_list_versions SET status='PUBLISHED', published_at=now() WHERE status='DRAFT';
      INSERT INTO quotes
        (id, tenant_id, service_case_id, conversation_id, unit_id, price_list_id, price_list_version_id,
         status, valid_until, prepared_by_user_id, idempotency_key, request_fingerprint) VALUES
        ('4a000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'), '48000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'DRAFT', now() + interval '1 day', '60000000-0000-4000-8000-000000000003', 'quote-seed-a', repeat('a',64)),
        ('5a000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002', (SELECT id FROM units WHERE code='POOL-B'), '58000000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002', 'DRAFT', now() + interval '1 day', '70000000-0000-4000-8000-000000000004', 'quote-seed-b', repeat('b',64));
      INSERT INTO quote_items
        (tenant_id, quote_id, line_number, catalog_item_id, price_list_version_id,
         catalog_code_snapshot, description_snapshot, quantity, unit_price_minor, line_total_minor, price_effective_at) VALUES
        ('40000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', 1, '47000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'ITEM-A', 'Item A', 1, 1000, 1000, now()),
        ('50000000-0000-4000-8000-000000000002', '5a000000-0000-4000-8000-000000000002', 1, '57000000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002', 'ITEM-B', 'Item B', 1, 2000, 2000, now());
      UPDATE quotes SET status='READY', subtotal_minor=1000, total_minor=1000, version=version+1 WHERE id='4a000000-0000-4000-8000-000000000001';
      UPDATE quotes SET status='READY', subtotal_minor=2000, total_minor=2000, version=version+1 WHERE id='5a000000-0000-4000-8000-000000000002';
      INSERT INTO quote_events
        (tenant_id, quote_id, from_status, to_status, reason, actor_id, correlation_id, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', 'DRAFT', 'READY', 'TEST_SEED', '60000000-0000-4000-8000-000000000003', 'quote-seed-a', 'quote-event-a'),
        ('50000000-0000-4000-8000-000000000002', '5a000000-0000-4000-8000-000000000002', 'DRAFT', 'READY', 'TEST_SEED', '70000000-0000-4000-8000-000000000004', 'quote-seed-b', 'quote-event-b');
      INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key) VALUES
        ('40000000-0000-4000-8000-000000000001', 'conversation', '44000000-0000-4000-8000-000000000001', 'test.a', '{}', 'outbox-a'),
        ('50000000-0000-4000-8000-000000000002', 'conversation', '54000000-0000-4000-8000-000000000002', 'test.b', '{}', 'outbox-b');
      INSERT INTO workflow_transitions
        (tenant_id, aggregate_type, aggregate_id, from_status, to_status, reason, actor_id, correlation_id) VALUES
        ('40000000-0000-4000-8000-000000000001', 'CONVERSATION', '44000000-0000-4000-8000-000000000001', NULL, 'OPEN', 'TEST_SEED', '60000000-0000-4000-8000-000000000003', 'workflow-a'),
        ('50000000-0000-4000-8000-000000000002', 'CONVERSATION', '54000000-0000-4000-8000-000000000002', NULL, 'OPEN', 'TEST_SEED', '70000000-0000-4000-8000-000000000004', 'workflow-b');
      INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id) VALUES
        ('40000000-0000-4000-8000-000000000001', 'USER', 'actor-a', 'TEST', 'tenant', 'a'),
        ('50000000-0000-4000-8000-000000000002', 'USER', 'actor-b', 'TEST', 'tenant', 'b');
    `);

    await target.query(`
      INSERT INTO oidc_providers
        (id, tenant_id, code, issuer, audience, organization_claim, organization_value, config_reference)
      VALUES
        ('61000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
         'primary', 'https://identity.test', 'zap-pronto', 'org_id', 'tenant-a', 'secret://oidc/tenant-a'),
        ('71000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002',
         'primary', 'https://identity.test', 'zap-pronto', 'org_id', 'tenant-b', 'secret://oidc/tenant-b');
      INSERT INTO user_oidc_identities
        (id, tenant_id, user_id, oidc_provider_id, subject)
      VALUES
        ('62000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
         '60000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000001', 'shared-subject'),
        ('72000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002',
         '70000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000002', 'shared-subject');
      INSERT INTO user_invitations
        (id,tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
      VALUES
        ('63000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
         '61000000-0000-4000-8000-000000000001','invite-a@test.local','Invite A',decode(repeat('aa',32),'hex'),now()+interval '1 day','60000000-0000-4000-8000-000000000003'),
        ('73000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002',
         '71000000-0000-4000-8000-000000000002','invite-b@test.local','Invite B',decode(repeat('bb',32),'hex'),now()+interval '1 day','70000000-0000-4000-8000-000000000004');
      INSERT INTO user_invitation_units (tenant_id,invitation_id,unit_id,role)
      SELECT invitation.tenant_id,invitation.id,unit.id,'ATTENDANT'
      FROM user_invitations invitation JOIN units unit ON unit.tenant_id=invitation.tenant_id;
      INSERT INTO user_lifecycle_commands
        (tenant_id,idempotency_key,operation,request_fingerprint,result)
      VALUES
        ('40000000-0000-4000-8000-000000000001','invite-command-a','INVITE',decode(repeat('ca',32),'hex'),'{}'),
        ('50000000-0000-4000-8000-000000000002','invite-command-b','INVITE',decode(repeat('cb',32),'hex'),'{}');
    `);

    await assert.rejects(
      target.query(`INSERT INTO users (tenant_id,email,display_name)
        VALUES ('40000000-0000-4000-8000-000000000001','ACTOR-A@TEST.LOCAL','Duplicate')`),
      (error) => error instanceof Error && "code" in error && error.code === "23505",
    );
    await assert.rejects(
      target.query(`INSERT INTO user_invitations
        (tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
        VALUES ('40000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',
        'other@test.local','Other',decode('aa','hex'),now()+interval '1 day','60000000-0000-4000-8000-000000000003')`),
      (error) => error instanceof Error && "code" in error && error.code === "23514",
    );
    await assert.rejects(
      target.query(`INSERT INTO user_invitations
        (tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
        VALUES ('40000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',
        'invite-a@test.local','Replay',decode(repeat('cc',32),'hex'),now()+interval '1 day','60000000-0000-4000-8000-000000000003')`),
      (error) => error instanceof Error && "code" in error && error.code === "23505",
    );
    await assert.rejects(
      target.query(`UPDATE users SET status='BLOCKED',blocked_at=NULL
        WHERE id='60000000-0000-4000-8000-000000000003'`),
      (error) => error instanceof Error && "code" in error && error.code === "23514",
    );

    await assert.rejects(
      target.query(`
        UPDATE conversations SET status = 'CLOSED', closed_at = now(), automation_status = 'HUMAN_ACTIVE'
        WHERE id = '54000000-0000-4000-8000-000000000002'
      `),
      (error) => error instanceof Error && "code" in error && error.code === "23514"
        && /INVALID_WORKFLOW_TRANSITION/.test(error.message),
    );

    const runtimeUrl = new URL(targetUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    const competingRuntimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    const workerUrl = new URL(targetUrl);
    workerUrl.username = workerRuntimeRole;
    workerUrl.password = workerRuntimePassword;
    const workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 1 });
    const competingWorkerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 1 });
    try {
      const actorAId = "60000000-0000-4000-8000-000000000003";
      const actorBId = "70000000-0000-4000-8000-000000000004";
      const oidcClient = await runtimePool.connect();
      try {
        await oidcClient.query("BEGIN");
        await oidcClient.query("SET LOCAL ROLE zap_pronto_api");
        const principal = await oidcClient.query(
          "SELECT * FROM resolve_oidc_principal($1,$2,$3,$4,$5)",
          ["https://identity.test", "zap-pronto", "shared-subject", "org_id", "tenant-a"],
        );
        assert.deepEqual(principal.rows, [{
          tenant_id: "40000000-0000-4000-8000-000000000001",
          user_id: actorAId,
          oidc_provider_id: "61000000-0000-4000-8000-000000000001",
          identity_id: "62000000-0000-4000-8000-000000000001",
        }]);
        await oidcClient.query("COMMIT");
        for (const invalidIdentity of [
          ["https://identity.test", "wrong-audience", "shared-subject", "org_id", "tenant-a"],
          ["https://identity.test", "zap-pronto", "shared-subject", "org_id", "missing-tenant"],
          ["https://identity.test", "zap-pronto", "shared-subject", null, null],
        ]) {
          await oidcClient.query("BEGIN");
          await oidcClient.query("SET LOCAL ROLE zap_pronto_api");
          await assert.rejects(
            oidcClient.query("SELECT * FROM resolve_oidc_principal($1,$2,$3,$4,$5)", invalidIdentity),
            (error) => error instanceof Error && "code" in error && error.code === "28000"
              && /AUTH_UNAUTHORIZED/.test(error.message),
          );
          await oidcClient.query("ROLLBACK");
        }
      } finally {
        await oidcClient.query("ROLLBACK").catch(() => undefined);
        oidcClient.release();
      }

      await target.query("UPDATE oidc_providers SET status='DISABLED' WHERE id='61000000-0000-4000-8000-000000000001'");
      const disabledProviderClient = await runtimePool.connect();
      try {
        await disabledProviderClient.query("BEGIN");
        await disabledProviderClient.query("SET LOCAL ROLE zap_pronto_api");
        await assert.rejects(
          disabledProviderClient.query(
            "SELECT * FROM resolve_oidc_principal($1,$2,$3,$4,$5)",
            ["https://identity.test", "zap-pronto", "shared-subject", "org_id", "tenant-a"],
          ),
          (error) => error instanceof Error && "code" in error && error.code === "28000"
            && /AUTH_UNAUTHORIZED/.test(error.message),
        );
      } finally {
        await disabledProviderClient.query("ROLLBACK").catch(() => undefined);
        disabledProviderClient.release();
      }
      await target.query("UPDATE oidc_providers SET status='ACTIVE' WHERE id='61000000-0000-4000-8000-000000000001'");

      const httpApp = await buildApp({
        pool: runtimePool,
        identityVerifier: { async verifyBearer() {
          return { issuer: "https://identity.test", audience: "zap-pronto", subject: "shared-subject",
            organization: { claim: "org_id", value: "tenant-a" } };
        } },
      });
      try {
        const currentUserResponse = await httpApp.inject({
          method: "GET",
          url: `/v1/me?tenantId=50000000-0000-4000-8000-000000000002&userId=${actorBId}`,
          headers: { authorization: "Bearer database-backed-token" },
        });
        assert.equal(currentUserResponse.statusCode, 200);
        assert.equal(currentUserResponse.headers["cache-control"], "no-store");
        const currentUser = currentUserResponse.json();
        assert.equal(currentUser.user.id, actorAId);
        assert.equal(currentUser.user.email, "actor-a@test.local");
        assert.equal(currentUser.tenant.id, "40000000-0000-4000-8000-000000000001");
        assert.deepEqual(currentUser.memberships.map((membership) => membership.unitCode), ["POOL-A"]);
        assert.ok(currentUser.grants.every((grant) =>
          grant.scope === "UNIT" && grant.unitId === currentUser.memberships[0].unitId));
        assert.doesNotMatch(JSON.stringify(currentUser), /shared-subject|identity\.test|61000000|62000000/);
        await target.query(`UPDATE user_units SET role='TENANT_ADMIN'
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND user_id=$1`, [actorAId]);
        const tenantAdminResponse = await httpApp.inject({ method: "GET", url: "/v1/me",
          headers: { authorization: "Bearer database-backed-token" } });
        assert.equal(tenantAdminResponse.statusCode, 200);
        assert.ok(tenantAdminResponse.json().grants.every((grant) =>
          grant.scope === "TENANT" && !("unitId" in grant)));
        await target.query(`UPDATE user_units SET role='ATTENDANT'
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND user_id=$1`, [actorAId]);
        await target.query(`UPDATE units SET active=false
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
        const inactiveUnitResponse = await httpApp.inject({ method: "GET", url: "/v1/me",
          headers: { authorization: "Bearer database-backed-token" } });
        assert.equal(inactiveUnitResponse.statusCode, 403);
        assert.equal(inactiveUnitResponse.json().type, "urn:zap-pronto:error:account-not-assigned");
        await target.query(`UPDATE units SET active=true
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      } finally {
        await httpApp.close();
      }

      const lifecycleTargetId = "64000000-0000-4000-8000-000000000001";
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name)
        VALUES ($1,'40000000-0000-4000-8000-000000000001','lifecycle-target@test.local','Lifecycle Target')`,
      [lifecycleTargetId]);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
        SELECT '40000000-0000-4000-8000-000000000001',$1,id,'ATTENDANT' FROM units
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`, [lifecycleTargetId]);
      await target.query(`INSERT INTO user_oidc_identities
        (tenant_id,user_id,oidc_provider_id,subject)
        VALUES ('40000000-0000-4000-8000-000000000001',$1,
        '61000000-0000-4000-8000-000000000001','lifecycle-target')`, [lifecycleTargetId]);
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "lifecycle-non-admin",
      }, async (client) => client.query("SELECT * FROM admin_change_user_status($1,$2,$3,1,'BLOCKED','Unauthorized')",
      ["lifecycle-unauthorized", Buffer.alloc(32, 0xa0), lifecycleTargetId])),
      (error) => error instanceof Error && "code" in error && error.code === "42501");
      const invitationUnit = await target.query(`SELECT id FROM units
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      const invitationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const invitationAssignments = JSON.stringify([{ unitId: invitationUnit.rows[0].id, role: "ATTENDANT" }]);
      const createInvitation = (overrides = {}) => {
        const values = {
          key: "admin-invite-security-a", fingerprint: Buffer.alloc(32, 0xd1),
          id: "66000000-0000-4000-8000-000000000001", provider: "primary",
          email: "security-invite@test.local", name: "Security Invite", expiresAt: invitationExpiresAt,
          digest: Buffer.alloc(32, 0xe1), assignments: invitationAssignments, ...overrides,
        };
        return withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "admin-invite-security",
        }, async (client) => client.query(
          "SELECT * FROM admin_create_user_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [values.key, values.fingerprint, values.id, values.provider, values.email, values.name,
            values.expiresAt, values.digest, values.assignments],
        ));
      };
      await assert.rejects(createInvitation({ key: "admin-invite-unauthorized" }),
        (error) => error instanceof Error && "code" in error && error.code === "42501");
      await target.query(`UPDATE user_units SET role='TENANT_ADMIN'
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND user_id=$1`, [actorAId]);
      const administrativeUsers = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-users-list",
      }, (client) => listAdministrativeUsers(client, { limit: 100 }));
      assert.ok(administrativeUsers.items.some((user) => user.id === actorAId));
      assert.ok(!administrativeUsers.items.some((user) => user.email === "actor-b@test.local"));
      const administrativeInvitations = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-list",
      }, (client) => listAdministrativeInvitations(client, { limit: 2 }));
      assert.ok(administrativeInvitations.items.every((invitation) => invitation.email !== "invite-b@test.local"));
      await assert.rejects(createInvitation({ key: "admin-invite-null-assignments", assignments: null }),
        (error) => error instanceof Error && "code" in error && error.code === "22023");
      await assert.rejects(createInvitation({ key: "admin-invite-null-role", assignments: JSON.stringify([
        { unitId: invitationUnit.rows[0].id, role: null },
      ]) }), (error) => error instanceof Error && "code" in error && error.code === "22023");
      await target.query(`INSERT INTO user_invitations
        (id,tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_at,created_by_user_id)
        VALUES ('67000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
          '61000000-0000-4000-8000-000000000001','security-invite@test.local','Expired Invite',
          decode(repeat('f1',32),'hex'),now()-interval '1 day',now()-interval '2 days',$1)`, [actorAId]);
      const invitationCreated = await createInvitation();
      assert.deepEqual(invitationCreated.rows.map((row) => ({ id: row.id, replayed: row.replayed })),
        [{ id: "66000000-0000-4000-8000-000000000001", replayed: false }]);
      const firstInvitationPage = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-first-page",
      }, (client) => listAdministrativeInvitations(client, { limit: 1 }));
      assert.equal(firstInvitationPage.items.length, 1);
      assert.ok(firstInvitationPage.nextCursor);
      const secondInvitationPage = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-second-page",
      }, (client) => listAdministrativeInvitations(client, { limit: 1, cursor: firstInvitationPage.nextCursor }));
      assert.equal(secondInvitationPage.items.length, 1);
      assert.notEqual(secondInvitationPage.items[0].id, firstInvitationPage.items[0].id);
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-cross-cursor",
      }, (client) => client.query("SELECT * FROM admin_list_user_invitations($1,2)",
      ["71000000-0000-4000-8000-000000000002"])),
      (error) => error instanceof Error && "code" in error && error.code === "22023");
      await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-internal-limit",
      }, (client) => client.query("SELECT * FROM admin_list_user_invitations(NULL,101)"));
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "admin-invitations-invalid-limit",
      }, (client) => client.query("SELECT * FROM admin_list_user_invitations(NULL,102)")),
      (error) => error instanceof Error && "code" in error && error.code === "22023");
      const invitationReplay = await createInvitation({
        id: "68000000-0000-4000-8000-000000000001", digest: Buffer.alloc(32, 0xe2),
      });
      assert.deepEqual(invitationReplay.rows.map((row) => ({ id: row.id, replayed: row.replayed })),
        [{ id: "66000000-0000-4000-8000-000000000001", replayed: true }]);
      await assert.rejects(createInvitation({ fingerprint: Buffer.alloc(32, 0xd2) }),
        (error) => error instanceof Error && "code" in error && error.code === "23505");
      const tenantBUnit = await target.query(`SELECT id FROM units
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND code='POOL-B'`);
      await assert.rejects(createInvitation({ key: "admin-invite-cross-unit", fingerprint: Buffer.alloc(32, 0xd3),
        id: "69000000-0000-4000-8000-000000000001", email: "cross-unit-invite@test.local",
        digest: Buffer.alloc(32, 0xe3), assignments: JSON.stringify([
          { unitId: tenantBUnit.rows[0].id, role: "ATTENDANT" },
        ]) }), (error) => error instanceof Error && "code" in error && error.code === "P0002");
      const invitationEvidence = await target.query(`SELECT
        (SELECT status::text FROM user_invitations WHERE id='67000000-0000-4000-8000-000000000001') AS old_status,
        (SELECT count(*)::integer FROM user_invitations WHERE id='66000000-0000-4000-8000-000000000001') AS invitations,
        (SELECT count(*)::integer FROM user_lifecycle_commands WHERE idempotency_key='admin-invite-security-a') AS commands,
        (SELECT count(*)::integer FROM audit_events WHERE entity_id IN
          ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001')) AS audits,
        (SELECT count(*)::integer FROM outbox_events WHERE aggregate_id IN
          ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001')) AS outbox,
        (SELECT result ? 'token' OR result ? 'tokenDigest' FROM user_lifecycle_commands
          WHERE idempotency_key='admin-invite-security-a') AS command_leaks_token`);
      assert.deepEqual(invitationEvidence.rows[0], {
        old_status: "EXPIRED", invitations: 1, commands: 1, audits: 2, outbox: 2,
        command_leaks_token: false,
      });
      const reissueInvitation = (pool, key, fingerprintByte, replacementId, digestByte) =>
        withTenantTransaction(pool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: `reissue-${fingerprintByte}`,
        }, async (client) => client.query(
          "SELECT * FROM admin_reissue_user_invitation($1,$2,$3,$4,$5,$6,$7)",
          [key, Buffer.alloc(32, fingerprintByte), "66000000-0000-4000-8000-000000000001",
            replacementId, invitationExpiresAt, Buffer.alloc(32, digestByte), "Rotate exposed invitation"],
        ));
      const concurrentReissues = await Promise.allSettled([
        reissueInvitation(runtimePool, "admin-reissue-security-a", 0xb1,
          "6a000000-0000-4000-8000-000000000001", 0xc1),
        reissueInvitation(competingRuntimePool, "admin-reissue-security-b", 0xb2,
          "6b000000-0000-4000-8000-000000000001", 0xc2),
      ]);
      assert.equal(concurrentReissues.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrentReissues.filter((result) => result.status === "rejected").length, 1);
      const successfulReissue = concurrentReissues.find((result) => result.status === "fulfilled");
      const replacementInvitationId = successfulReissue.value.rows[0].id;
      assert.equal(successfulReissue.value.rows[0].replayed, false);
      const successfulReissueKey = replacementInvitationId.startsWith("6a")
        ? "admin-reissue-security-a" : "admin-reissue-security-b";
      const successfulFingerprintByte = replacementInvitationId.startsWith("6a") ? 0xb1 : 0xb2;
      const successfulDigestByte = replacementInvitationId.startsWith("6a") ? 0xc1 : 0xc2;
      const reissueReplay = await reissueInvitation(runtimePool, successfulReissueKey,
        successfulFingerprintByte, "6c000000-0000-4000-8000-000000000001", successfulDigestByte);
      assert.equal(reissueReplay.rows[0].id, replacementInvitationId);
      assert.equal(reissueReplay.rows[0].replayed, true);
      const revokeInvitation = (key, fingerprint, targetId, reason = "Administrative revocation") =>
        withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: `revoke-${fingerprint}`,
        }, async (client) => client.query(
          "SELECT * FROM admin_revoke_user_invitation($1,$2,$3,$4)",
          [key, Buffer.alloc(32, fingerprint), targetId, reason],
        ));
      const revokedInvitation = await revokeInvitation("admin-revoke-security", 0xd4, replacementInvitationId);
      assert.equal(revokedInvitation.rows[0].status, "REVOKED");
      assert.equal(revokedInvitation.rows[0].replayed, false);
      const revokeReplay = await revokeInvitation("admin-revoke-security", 0xd4, replacementInvitationId);
      assert.equal(revokeReplay.rows[0].replayed, true);
      await assert.rejects(revokeInvitation("admin-revoke-cross-tenant", 0xd5,
        "73000000-0000-4000-8000-000000000002"),
      (error) => error instanceof Error && "code" in error && error.code === "P0002");
      const lifecycleInvitationEvidence = await target.query(`SELECT
        (SELECT status::text FROM user_invitations WHERE id='66000000-0000-4000-8000-000000000001') AS original_status,
        (SELECT status::text FROM user_invitations WHERE id=$1) AS replacement_status,
        (SELECT count(*)::integer FROM audit_events WHERE entity_id IN
          ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',$1::text)) AS audits,
        (SELECT count(*)::integer FROM outbox_events WHERE aggregate_id IN
          ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',$1)) AS outbox`,
      [replacementInvitationId]);
      assert.deepEqual(lifecycleInvitationEvidence.rows[0], {
        original_status: "REVOKED", replacement_status: "REVOKED", audits: 5, outbox: 5,
      });
      await target.query(`DELETE FROM audit_events WHERE entity_id IN
        ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001')`);
      await target.query(`DELETE FROM outbox_events WHERE aggregate_id IN
        ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001')`);
      await target.query("DELETE FROM user_lifecycle_commands WHERE idempotency_key LIKE 'admin-%security%'");
      await target.query(`DELETE FROM user_invitations WHERE id IN
        ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001')`);

      const changeStatus = (status, version, reason, overrides = {}) => withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: `lifecycle-${status.toLowerCase()}`,
      }, async (client) => {
        const values = { key: `lifecycle-${status.toLowerCase()}-${version}`,
          fingerprint: Buffer.alloc(32, status === "BLOCKED" ? 0xa1 : status === "ACTIVE" ? 0xa2 : 0xa3),
          target: lifecycleTargetId, ...overrides };
        return client.query("SELECT * FROM admin_change_user_status($1,$2,$3,$4,$5,$6)",
          [values.key, values.fingerprint, values.target, version, status, reason]);
      });
      assert.deepEqual((await changeStatus("BLOCKED", 1, "Security review")).rows,
        [{ user_id: lifecycleTargetId, status: "BLOCKED", version: 2, replayed: false }]);
      assert.deepEqual((await changeStatus("BLOCKED", 1, "Security review")).rows,
        [{ user_id: lifecycleTargetId, status: "BLOCKED", version: 2, replayed: true }]);
      await assert.rejects(changeStatus("BLOCKED", 1, "Changed command", { fingerprint: Buffer.alloc(32, 0xaf) }),
        (error) => error instanceof Error && "code" in error && error.code === "23505");
      await assert.rejects(changeStatus("ACTIVE", 1, "Stale command"),
        (error) => error instanceof Error && "code" in error && error.code === "40001");
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "lifecycle-cross-tenant",
      }, async (client) => client.query("SELECT * FROM admin_change_user_status($1,$2,$3,1,'BLOCKED','Cross tenant')",
      ["lifecycle-cross-tenant", Buffer.alloc(32, 0xa4), actorBId])),
      (error) => error instanceof Error && "code" in error && error.code === "P0002");
      assert.deepEqual((await changeStatus("ACTIVE", 2, "Review completed")).rows,
        [{ user_id: lifecycleTargetId, status: "ACTIVE", version: 3, replayed: false }]);
      assert.deepEqual((await changeStatus("REVOKED", 3, "Access permanently revoked")).rows,
        [{ user_id: lifecycleTargetId, status: "REVOKED", version: 4, replayed: false }]);
      await assert.rejects(changeStatus("ACTIVE", 4, "Invalid reversal"),
        (error) => error instanceof Error && "code" in error && error.code === "22023");
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "lifecycle-self-block",
      }, async (client) => client.query(
        "SELECT * FROM admin_change_user_status($1,$2,$3,1,'BLOCKED','Self block')",
        ["lifecycle-self-block", Buffer.alloc(32, 0xa5), actorAId])),
      (error) => error instanceof Error && "code" in error && error.code === "42501");
      const lifecycleEvidence = await target.query(`SELECT
        (SELECT status FROM user_oidc_identities WHERE user_id=$1) AS identity_status,
        (SELECT count(*)::integer FROM audit_events WHERE entity_id=$1::text AND action='USER_STATUS_CHANGED') AS audit_count,
        (SELECT count(*)::integer FROM outbox_events WHERE aggregate_id=$1 AND event_type='user.status_changed') AS outbox_count`,
      [lifecycleTargetId]);
      assert.deepEqual(lifecycleEvidence.rows[0], {
        identity_status: "REVOKED", audit_count: 3, outbox_count: 3,
      });
      const lifecyclePrivileges = await target.query(`SELECT
        has_function_privilege('zap_pronto_api','admin_change_user_status(text,bytea,uuid,integer,text,text)','EXECUTE') AS api_execute,
        has_function_privilege('zap_pronto_worker','admin_change_user_status(text,bytea,uuid,integer,text,text)','EXECUTE') AS worker_execute,
        has_function_privilege('zap_pronto_app','admin_change_user_status(text,bytea,uuid,integer,text,text)','EXECUTE') AS app_execute,
        has_function_privilege('zap_pronto_api','admin_create_user_invitation(text,bytea,uuid,text,text,text,timestamptz,bytea,jsonb)','EXECUTE') AS api_invite_execute,
        has_function_privilege('zap_pronto_worker','admin_create_user_invitation(text,bytea,uuid,text,text,text,timestamptz,bytea,jsonb)','EXECUTE') AS worker_invite_execute,
        has_function_privilege('zap_pronto_app','admin_create_user_invitation(text,bytea,uuid,text,text,text,timestamptz,bytea,jsonb)','EXECUTE') AS app_invite_execute,
        has_function_privilege('zap_pronto_api','admin_revoke_user_invitation(text,bytea,uuid,text)','EXECUTE') AS api_revoke_invite_execute,
        has_function_privilege('zap_pronto_worker','admin_revoke_user_invitation(text,bytea,uuid,text)','EXECUTE') AS worker_revoke_invite_execute,
        has_function_privilege('zap_pronto_app','admin_revoke_user_invitation(text,bytea,uuid,text)','EXECUTE') AS app_revoke_invite_execute,
        has_function_privilege('zap_pronto_api','admin_reissue_user_invitation(text,bytea,uuid,uuid,timestamptz,bytea,text)','EXECUTE') AS api_reissue_invite_execute,
        has_function_privilege('zap_pronto_worker','admin_reissue_user_invitation(text,bytea,uuid,uuid,timestamptz,bytea,text)','EXECUTE') AS worker_reissue_invite_execute,
        has_function_privilege('zap_pronto_app','admin_reissue_user_invitation(text,bytea,uuid,uuid,timestamptz,bytea,text)','EXECUTE') AS app_reissue_invite_execute,
        has_function_privilege('zap_pronto_api','admin_list_user_invitations(uuid,integer)','EXECUTE') AS api_list_invite_execute,
        has_function_privilege('zap_pronto_worker','admin_list_user_invitations(uuid,integer)','EXECUTE') AS worker_list_invite_execute,
        has_function_privilege('zap_pronto_app','admin_list_user_invitations(uuid,integer)','EXECUTE') AS app_list_invite_execute,
        has_table_privilege('zap_pronto_api','user_invitations','SELECT') AS api_select_invitations,
        has_table_privilege('zap_pronto_api','users','INSERT') AS api_insert_user,
        has_table_privilege('zap_pronto_api','users','UPDATE') AS api_update_user,
        has_table_privilege('zap_pronto_api','user_units','UPDATE') AS api_update_membership`);
      assert.deepEqual(lifecyclePrivileges.rows[0], {
        api_execute: true, worker_execute: false, app_execute: false,
        api_invite_execute: true, worker_invite_execute: false, app_invite_execute: false,
        api_revoke_invite_execute: true, worker_revoke_invite_execute: false, app_revoke_invite_execute: false,
        api_reissue_invite_execute: true, worker_reissue_invite_execute: false, app_reissue_invite_execute: false,
        api_list_invite_execute: true, worker_list_invite_execute: false, app_list_invite_execute: false,
        api_select_invitations: false,
        api_insert_user: false, api_update_user: false, api_update_membership: false,
      });
      const competingAdminId = "65000000-0000-4000-8000-000000000001";
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name)
        VALUES ($1,'40000000-0000-4000-8000-000000000001','competing-admin@test.local','Competing Admin')`,
      [competingAdminId]);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
        SELECT '40000000-0000-4000-8000-000000000001',$1,id,'TENANT_ADMIN' FROM units
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`, [competingAdminId]);
      const concurrentRemoval = (pool, actorId, targetId, correlationId) => withTenantTransaction(pool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId, correlationId,
      }, async (client) => client.query(
        "SELECT * FROM admin_change_user_status($1,$2,$3,1,'BLOCKED','Concurrency test')",
        [`admin-race-${targetId}`, Buffer.alloc(32, targetId === actorAId ? 0xa6 : 0xa7), targetId]));
      const concurrentAdminResults = await Promise.allSettled([
        concurrentRemoval(runtimePool, actorAId, competingAdminId, "admin-race-a"),
        concurrentRemoval(competingRuntimePool, competingAdminId, actorAId, "admin-race-b"),
      ]);
      assert.equal(concurrentAdminResults.filter((result) => result.status === "fulfilled").length, 1,
        concurrentAdminResults.map((result) => result.status === "rejected"
          ? `${result.reason?.code ?? "ERROR"}:${result.reason?.message ?? result.reason}` : "fulfilled").join(" | "));
      const activeAdminCount = await target.query(`SELECT count(DISTINCT account.id)::integer AS count
        FROM users account JOIN user_units membership
          ON membership.tenant_id=account.tenant_id AND membership.user_id=account.id
        JOIN units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active=true
        WHERE account.tenant_id='40000000-0000-4000-8000-000000000001' AND account.status='ACTIVE'
          AND membership.role='TENANT_ADMIN'`);
      assert.equal(activeAdminCount.rows[0].count, 1);
      await target.query(`UPDATE users SET status='ACTIVE',blocked_at=NULL,revoked_at=NULL
        WHERE id IN ($1,$2)`, [actorAId, competingAdminId]);
      await target.query(`DELETE FROM audit_events WHERE action='USER_STATUS_CHANGED' AND entity_id IN ($1::text,$2::text)`,
      [actorAId, competingAdminId]);
      await target.query(`DELETE FROM outbox_events WHERE event_type='user.status_changed' AND aggregate_id IN ($1,$2)`,
      [actorAId, competingAdminId]);
      await target.query("DELETE FROM user_lifecycle_commands WHERE target_user_id IN ($1,$2)",
      [actorAId, competingAdminId]);
      await target.query("DELETE FROM user_units WHERE user_id=$1", [competingAdminId]);
      await target.query("DELETE FROM users WHERE id=$1", [competingAdminId]);
      await target.query(`UPDATE user_units SET role='ATTENDANT'
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND user_id=$1`, [actorAId]);
      await target.query("DELETE FROM audit_events WHERE entity_id=$1::text", [lifecycleTargetId]);
      await target.query("DELETE FROM outbox_events WHERE aggregate_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM user_lifecycle_commands WHERE target_user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM user_oidc_identities WHERE user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM user_units WHERE user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM users WHERE id=$1", [lifecycleTargetId]);

      await assert.rejects(
        target.query(`INSERT INTO oidc_providers
          (tenant_id,code,issuer,audience,organization_claim,organization_value,config_reference)
          VALUES ('50000000-0000-4000-8000-000000000002','duplicate-resolution',
          'https://identity.test','zap-pronto','org_id','tenant-a','secret://duplicate')`),
        (error) => error instanceof Error && "code" in error && error.code === "23505",
      );

      const oidcPrivileges = await target.query(`SELECT
        has_function_privilege('zap_pronto_api', 'resolve_oidc_principal(text,text,text,text,text)', 'EXECUTE') AS api_execute,
        has_function_privilege('zap_pronto_worker', 'resolve_oidc_principal(text,text,text,text,text)', 'EXECUTE') AS worker_execute,
        has_table_privilege('zap_pronto_api', 'oidc_providers', 'INSERT') AS api_insert_provider,
        has_table_privilege('zap_pronto_worker', 'user_oidc_identities', 'SELECT') AS worker_read_identity
      `);
      assert.deepEqual(oidcPrivileges.rows[0], {
        api_execute: true, worker_execute: false, api_insert_provider: false, worker_read_identity: false,
      });

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

      // Elevação exclusiva do banco descartável para exercitar todas as policies.
      await target.query("GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zap_pronto_api");
      await target.query("GRANT SELECT ON user_invitations,user_invitation_units,user_lifecycle_commands TO zap_pronto_api");
      await target.query("REVOKE UPDATE, DELETE ON audit_events FROM zap_pronto_api");

      for (const table of protectedTables) {
        const insertPrivilege = await target.query(
          "SELECT has_table_privilege($1, $2, 'INSERT') AS allowed",
          ["zap_pronto_api", `public.${table}`],
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

      for (const table of protectedTables.filter((name) => name !== "users")) {
        const tenantColumn = table === "tenants" ? "id" : "tenant_id";
        const insertOverrides = table === "quotes"
          ? { status: "DRAFT", version: 1, subtotal_minor: 0, discount_minor: 0, total_minor: 0 }
          : table === "medical_orders"
            ? { status: "RECEIVED", version: 1, overall_confidence: null, extraction_fingerprint: null }
            : {};
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
                 to_jsonb(source) || $2::jsonb || jsonb_build_object('${tenantColumn}', $1::text)
               )).*
               FROM "${table}" source
               LIMIT 1`,
              ["50000000-0000-4000-8000-000000000002", JSON.stringify(insertOverrides)],
            ),
          ),
          (error) => error instanceof Error && "code" in error && error.code === "42501"
            && "routine" in error && error.routine === "ExecWithCheckOptions",
          `${table}:CROSS_TENANT_INSERT_NOT_BLOCKED_BY_RLS`,
        );
      }
      await assert.rejects(
        withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "matrix-insert-users",
        }, async (client) => client.query(`INSERT INTO users (id,tenant_id,email,display_name)
          VALUES ('7f000000-0000-4000-8000-000000000099','50000000-0000-4000-8000-000000000002',
          'cross-tenant@test.local','Cross Tenant')`)),
        (error) => error instanceof Error && "code" in error && error.code === "42501"
          && "routine" in error && error.routine === "ExecWithCheckOptions",
        "users:CROSS_TENANT_INSERT_NOT_BLOCKED_BY_RLS",
      );

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
          has_table_privilege('zap_pronto_api', 'public.audit_events', 'UPDATE') AS can_update,
          has_table_privilege('zap_pronto_api', 'public.audit_events', 'DELETE') AS can_delete
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
            await client.query("SET LOCAL ROLE zap_pronto_api");
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
            await client.query("SET LOCAL ROLE zap_pronto_api");
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

      const handoffA = await target.query(
        "SELECT id, version FROM human_handoffs WHERE idempotency_key = 'handoff-a'",
      );
      await target.query(`
        UPDATE conversations SET automation_status = 'HUMAN_REQUESTED'
        WHERE id = '44000000-0000-4000-8000-000000000001';
        UPDATE conversations SET automation_status = 'HUMAN_QUEUED'
        WHERE id = '44000000-0000-4000-8000-000000000001';
        UPDATE service_cases SET status = 'WAITING_HUMAN'
        WHERE id = '45000000-0000-4000-8000-000000000001';
      `);
      const claimContext = {
        tenantId: "40000000-0000-4000-8000-000000000001",
        actorId: actorAId,
      };
      const claimInput = {
        handoffId: handoffA.rows[0].id,
        expectedVersion: handoffA.rows[0].version,
      };
      const claimResults = await Promise.allSettled([
        withTenantTransaction(
          runtimePool,
          { ...claimContext, correlationId: "concurrent-claim-a" },
          (client) => claimHandoff(client, claimInput),
        ),
        withTenantTransaction(
          competingRuntimePool,
          { ...claimContext, correlationId: "concurrent-claim-b" },
          (client) => claimHandoff(client, claimInput),
        ),
      ]);
      assert.equal(
        claimResults.filter((result) => result.status === "fulfilled").length,
        1,
        claimResults.map((result) => result.status === "rejected"
          ? String(result.reason?.message ?? result.reason)
          : "FULFILLED").join(" | "),
      );
      assert.equal(claimResults.filter((result) => result.status === "rejected").length, 1);
      const rejectedClaim = claimResults.find((result) => result.status === "rejected");
      assert.match(rejectedClaim.reason.message, /HANDOFF_CLAIM_CONFLICT/);

      const claimEvidence = await target.query(`
        SELECT h.status, h.version, h.assigned_user_id,
          (SELECT count(*)::integer FROM workflow_transitions wt
            WHERE wt.aggregate_type = 'HANDOFF' AND wt.aggregate_id = h.id AND wt.to_status = 'ACTIVE') AS transitions,
          (SELECT count(*)::integer FROM outbox_events oe
            WHERE oe.idempotency_key = 'handoff.claimed:' || h.id::text) AS outbox_events
        FROM human_handoffs h WHERE h.id = $1
      `, [handoffA.rows[0].id]);
      assert.deepEqual(claimEvidence.rows[0], {
        status: "ACTIVE",
        version: 2,
        assigned_user_id: actorAId,
        transitions: 1,
        outbox_events: 1,
      });
      const claimedCase = await target.query(
        "SELECT status, version FROM service_cases WHERE id = '45000000-0000-4000-8000-000000000001'",
      );
      assert.deepEqual(claimedCase.rows[0], { status: "IN_REVIEW", version: 2 });
      const claimTransitionCount = await target.query(
        "SELECT count(*)::integer AS count FROM workflow_transitions WHERE correlation_id IN ('concurrent-claim-a', 'concurrent-claim-b')",
      );
      assert.equal(claimTransitionCount.rows[0].count, 3);

      await target.query("DELETE FROM human_handoffs WHERE idempotency_key = 'handoff-b'");
      const concurrentHandoffRequest = {
          serviceCaseId: "55000000-0000-4000-8000-000000000002",
          expectedCaseVersion: 1,
          reason: "COMPLETED_COLLECTION",
          priority: "NORMAL",
          idempotencyKey: "handoff-request-b",
      };
      const concurrentHandoffRequests = await Promise.allSettled([
        withTenantTransaction(runtimePool, {
          tenantId: "50000000-0000-4000-8000-000000000002", actorId: actorBId,
          correlationId: "request-handoff-b",
        }, (client) => requestHandoff(client, concurrentHandoffRequest)),
        withTenantTransaction(competingRuntimePool, {
          tenantId: "50000000-0000-4000-8000-000000000002", actorId: actorBId,
          correlationId: "request-handoff-b-replay",
        }, (client) => requestHandoff(client, concurrentHandoffRequest)),
      ]);
      assert.equal(concurrentHandoffRequests.filter((result) => result.status === "fulfilled").length, 2);
      const requestedHandoff = concurrentHandoffRequests[0].value;
      assert.equal(concurrentHandoffRequests[1].value.id, requestedHandoff.id);
      assert.equal(requestedHandoff.status, "QUEUED");
      const requestEvidence = await target.query(`
        SELECT c.automation_status, c.assigned_user_id, sc.status AS case_status, sc.version AS case_version,
          h.status AS handoff_status, h.queued_at IS NOT NULL AS was_queued,
          (SELECT count(*)::integer FROM workflow_transitions wt
            WHERE wt.correlation_id IN ('request-handoff-b','request-handoff-b-replay')) AS transitions,
          (SELECT count(*)::integer FROM outbox_events oe
            WHERE oe.idempotency_key = 'handoff.queued:' || h.id::text) AS outbox_events
        FROM human_handoffs h
        JOIN service_cases sc ON sc.tenant_id = h.tenant_id AND sc.id = h.service_case_id
        JOIN conversations c ON c.tenant_id = h.tenant_id AND c.id = h.conversation_id
        WHERE h.id = $1
      `, [requestedHandoff.id]);
      assert.deepEqual(requestEvidence.rows[0], {
        automation_status: "HUMAN_QUEUED",
        assigned_user_id: null,
        case_status: "WAITING_HUMAN",
        case_version: 2,
        handoff_status: "QUEUED",
        was_queued: true,
        transitions: 4,
        outbox_events: 1,
      });

      const readyQuote = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "50000000-0000-4000-8000-000000000002",
          actorId: actorBId,
          correlationId: "quote-create-b",
        },
        (client) => createReadyQuote(client, {
          serviceCaseId: "55000000-0000-4000-8000-000000000002",
          priceListVersionId: "59000000-0000-4000-8000-000000000002",
          items: [{ catalogItemId: "57000000-0000-4000-8000-000000000002", quantity: 3 }],
          discountMinor: 500n,
          validUntil: new Date(Date.now() + 86_400_000),
          idempotencyKey: "quote-runtime-b",
        }),
      );
      assert.deepEqual(
        { status: readyQuote.status, version: readyQuote.version, subtotal: readyQuote.subtotalMinor, total: readyQuote.totalMinor },
        { status: "READY", version: 2, subtotal: 6000n, total: 5500n },
      );
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "50000000-0000-4000-8000-000000000002",
            actorId: actorBId,
            correlationId: "quote-forged-ready-b",
          },
          (client) => client.query(`
            INSERT INTO quotes
              (tenant_id, service_case_id, conversation_id, unit_id, price_list_id,
               price_list_version_id, status, valid_until, prepared_by_user_id,
               idempotency_key, request_fingerprint)
            SELECT current_app_tenant_id(), '55000000-0000-4000-8000-000000000002',
              '54000000-0000-4000-8000-000000000002', unit.id,
              '58000000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002',
              'READY', now() + interval '1 day', current_app_actor_id(), 'forged-ready', repeat('f',64)
            FROM units unit WHERE unit.code='POOL-B'
          `),
        ),
        /INVALID_QUOTE_INSERT/,
      );
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "50000000-0000-4000-8000-000000000002",
            actorId: actorBId,
            correlationId: "quote-version-bypass-b",
          },
          async (client) => {
            await client.query(`
              INSERT INTO quotes
                (id, tenant_id, service_case_id, conversation_id, unit_id, price_list_id,
                 price_list_version_id, revision, status, valid_until, prepared_by_user_id,
                 idempotency_key, request_fingerprint)
              SELECT '5d000000-0000-4000-8000-000000000002', current_app_tenant_id(),
                '55000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000002',
                unit.id, '58000000-0000-4000-8000-000000000002',
                '59000000-0000-4000-8000-000000000002', 99, 'DRAFT', now() + interval '1 day',
                current_app_actor_id(), 'quote-version-bypass', repeat('d',64)
              FROM units unit WHERE unit.code='POOL-B'
            `);
            await client.query(`
              UPDATE quotes SET status='READY', valid_until=valid_until + interval '1 day'
              WHERE id='5d000000-0000-4000-8000-000000000002'
            `);
          },
        ),
        /QUOTE_IDENTITY_IMMUTABLE|QUOTE_VERSION_INCREMENT_REQUIRED/,
      );
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "50000000-0000-4000-8000-000000000002",
            actorId: actorBId,
            correlationId: "price-empty-publish-b",
          },
          async (client) => {
            await client.query(`
              INSERT INTO price_list_versions
                (id, tenant_id, price_list_id, version, status, effective_at)
              VALUES ('5c000000-0000-4000-8000-000000000002', current_app_tenant_id(),
                '58000000-0000-4000-8000-000000000002', 99, 'DRAFT', now())
            `);
            await client.query(`
              UPDATE price_list_versions SET status='PUBLISHED', published_at=now()
              WHERE id='5c000000-0000-4000-8000-000000000002'
            `);
          },
        ),
        /PRICE_VERSION_EMPTY/,
      );

      const sendContext = {
        tenantId: "50000000-0000-4000-8000-000000000002",
        actorId: actorBId,
      };
      const concurrentSends = await Promise.allSettled([
        withTenantTransaction(
          runtimePool,
          { ...sendContext, correlationId: "quote-send-b-1" },
          (client) => sendQuote(client, { quoteId: readyQuote.id, expectedVersion: readyQuote.version }),
        ),
        withTenantTransaction(
          competingRuntimePool,
          { ...sendContext, correlationId: "quote-send-b-2" },
          (client) => sendQuote(client, { quoteId: readyQuote.id, expectedVersion: readyQuote.version }),
        ),
      ]);
      assert.equal(concurrentSends.filter((result) => result.status === "fulfilled").length, 2);
      assert.deepEqual(concurrentSends.map((result) => result.value.version), [3, 3]);
      const sentQuote = concurrentSends.find((result) => result.status === "fulfilled").value;
      assert.equal(sentQuote.version, 3);
      const acceptedQuote = await withTenantTransaction(
        runtimePool,
        { ...sendContext, correlationId: "quote-accept-b" },
        (client) => acceptQuote(client, { quoteId: readyQuote.id, expectedVersion: sentQuote.version }),
      );
      assert.equal(acceptedQuote.status, "ACCEPTED");
      assert.equal(acceptedQuote.version, 4);

      const quoteEvidence = await target.query(`
        SELECT quote.status, quote.subtotal_minor, quote.discount_minor, quote.total_minor,
          item.catalog_code_snapshot, item.description_snapshot, item.quantity, item.unit_price_minor,
          conversation.automation_status,
          (SELECT count(*)::integer FROM quote_events event WHERE event.quote_id = quote.id) AS events,
          (SELECT count(*)::integer FROM outbox_events outbox
            WHERE outbox.aggregate_type = 'quote' AND outbox.aggregate_id = quote.id) AS outbox_events
        FROM quotes quote
        JOIN quote_items item ON item.tenant_id = quote.tenant_id AND item.quote_id = quote.id
        JOIN conversations conversation ON conversation.tenant_id = quote.tenant_id AND conversation.id = quote.conversation_id
        WHERE quote.id = $1
      `, [readyQuote.id]);
      assert.deepEqual(quoteEvidence.rows[0], {
        status: "ACCEPTED", subtotal_minor: "6000", discount_minor: "500", total_minor: "5500",
        catalog_code_snapshot: "ITEM-B", description_snapshot: "Item B", quantity: 3,
        unit_price_minor: "2000", automation_status: "HUMAN_QUEUED", events: 4, outbox_events: 2,
      });
      await assert.rejects(
        target.query("UPDATE prices SET amount_minor = 9999 WHERE tenant_id = '50000000-0000-4000-8000-000000000002'"),
        (error) => error instanceof Error && "code" in error && error.code === "23514"
          && /PUBLISHED_PRICES_IMMUTABLE/.test(error.message),
      );
      await withTenantTransaction(
        runtimePool,
        { ...sendContext, correlationId: "price-version-publish-b" },
        async (client) => {
          await client.query(`
            INSERT INTO price_list_versions
              (id, tenant_id, price_list_id, version, status, effective_at)
            VALUES ('5b000000-0000-4000-8000-000000000002', current_app_tenant_id(),
              '58000000-0000-4000-8000-000000000002', 2, 'DRAFT', now() + interval '1 day')
          `);
          await client.query(`
            INSERT INTO prices (tenant_id, price_list_version_id, catalog_item_id, amount_minor)
            VALUES (current_app_tenant_id(), '5b000000-0000-4000-8000-000000000002',
              '57000000-0000-4000-8000-000000000002', 2500)
          `);
          await publishPriceListVersion(client, "5b000000-0000-4000-8000-000000000002");
        },
      );
      const priceSnapshotEvidence = await target.query(`
        SELECT
          (SELECT status FROM price_list_versions WHERE id='59000000-0000-4000-8000-000000000002') AS old_status,
          (SELECT status FROM price_list_versions WHERE id='5b000000-0000-4000-8000-000000000002') AS new_status,
          (SELECT unit_price_minor FROM quote_items WHERE quote_id=$1) AS snapshot_price,
          (SELECT amount_minor FROM prices WHERE price_list_version_id='5b000000-0000-4000-8000-000000000002') AS new_price
      `, [readyQuote.id]);
      assert.deepEqual(priceSnapshotEvidence.rows[0], {
        old_status: "RETIRED", new_status: "PUBLISHED", snapshot_price: "2000", new_price: "2500",
      });

      const reviewQuoteInput = {
        serviceCaseId: "55000000-0000-4000-8000-000000000002",
        priceListVersionId: "5b000000-0000-4000-8000-000000000002",
        items: [{ catalogItemId: "57000000-0000-4000-8000-000000000002", quantity: 1 }],
        discountMinor: 0n,
        validUntil: new Date(Date.now() + 172_800_000),
        idempotencyKey: "quote-review-b",
        requiresHumanReview: true,
      };
      const reviewQuote = await withTenantTransaction(
        runtimePool,
        { ...sendContext, correlationId: "quote-review-create-b" },
        (client) => createReadyQuote(client, reviewQuoteInput),
      );
      assert.equal(reviewQuote.status, "REVIEW_REQUIRED");
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          { ...sendContext, correlationId: "quote-review-replay-mismatch" },
          (client) => createReadyQuote(client, {
            ...reviewQuoteInput,
            items: [{ catalogItemId: "57000000-0000-4000-8000-000000000002", quantity: 2 }],
          }),
        ),
        /IDEMPOTENCY_KEY_REUSED/,
      );
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          { ...sendContext, correlationId: "quote-snapshot-forgery" },
          (client) => client.query(`
            INSERT INTO quote_items
              (tenant_id, quote_id, line_number, catalog_item_id, price_list_version_id,
               catalog_code_snapshot, description_snapshot, quantity, unit_price_minor,
               line_total_minor, price_effective_at)
            SELECT current_app_tenant_id(), $1, 2, price.catalog_item_id, price.price_list_version_id,
              'FORGED', 'FORGED', 1, price.amount_minor, price.amount_minor, version.effective_at
            FROM prices price JOIN price_list_versions version
              ON version.tenant_id=price.tenant_id AND version.id=price.price_list_version_id
            WHERE price.catalog_item_id='57000000-0000-4000-8000-000000000002'
          `, [reviewQuote.id]),
        ),
        /QUOTE_ITEM_SNAPSHOT_MISMATCH/,
      );
      const approvedQuote = await withTenantTransaction(
        runtimePool,
        { ...sendContext, correlationId: "quote-review-approve-b" },
        (client) => approveQuoteReview(client, { quoteId: reviewQuote.id, expectedVersion: reviewQuote.version }),
      );
      assert.equal(approvedQuote.status, "READY");
      await assert.rejects(
        target.query("UPDATE quotes SET subtotal_minor=9999,total_minor=9999 WHERE id=$1", [reviewQuote.id]),
        /READY_QUOTE_COMMERCIAL_DATA_IMMUTABLE/,
      );
      const cancelledQuote = await withTenantTransaction(
        runtimePool,
        { ...sendContext, correlationId: "quote-review-cancel-b" },
        (client) => cancelQuote(client, { quoteId: reviewQuote.id, expectedVersion: approvedQuote.version }),
      );
      assert.equal(cancelledQuote.status, "CANCELLED");

      const expiringQuote = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "quote-expiring-create-a",
        },
        (client) => createReadyQuote(client, {
          serviceCaseId: "45000000-0000-4000-8000-000000000001",
          priceListVersionId: "49000000-0000-4000-8000-000000000001",
          items: [{ catalogItemId: "47000000-0000-4000-8000-000000000001", quantity: 1 }],
          discountMinor: 0n,
          validUntil: new Date(Date.now() + 500),
          idempotencyKey: "quote-expiring-a",
        }),
      );
      const sentExpiringQuote = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "quote-expiring-send-a",
        },
        (client) => sendQuote(client, { quoteId: expiringQuote.id, expectedVersion: expiringQuote.version }),
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      await assert.rejects(
        withTenantTransaction(
          runtimePool,
          {
            tenantId: "40000000-0000-4000-8000-000000000001",
            actorId: actorAId,
            correlationId: "quote-expired-accept-a",
          },
          (client) => acceptQuote(client, {
            quoteId: expiringQuote.id,
            expectedVersion: sentExpiringQuote.version,
          }),
        ),
        /QUOTE_TRANSITION_CONFLICT/,
      );
      const expiredQuote = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "quote-expire-a",
        },
        (client) => expireQuote(client, {
          quoteId: expiringQuote.id,
          expectedVersion: sentExpiringQuote.version,
        }),
      );
      assert.equal(expiredQuote.status, "EXPIRED");

      await target.query(`
        INSERT INTO price_list_versions
          (id, tenant_id, price_list_id, version, status, effective_at) VALUES
          ('5e000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000002', '58000000-0000-4000-8000-000000000002', 3, 'DRAFT', now() + interval '2 days'),
          ('5f000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000002', '58000000-0000-4000-8000-000000000002', 4, 'DRAFT', now() + interval '3 days');
        INSERT INTO prices (tenant_id, price_list_version_id, catalog_item_id, amount_minor) VALUES
          ('50000000-0000-4000-8000-000000000002', '5e000000-0000-4000-8000-000000000003', '57000000-0000-4000-8000-000000000002', 2600),
          ('50000000-0000-4000-8000-000000000002', '5f000000-0000-4000-8000-000000000004', '57000000-0000-4000-8000-000000000002', 2700);
      `);
      const concurrentPublications = await Promise.all([
        withTenantTransaction(
          runtimePool,
          { ...sendContext, correlationId: "price-publish-concurrent-3" },
          (client) => publishPriceListVersion(client, "5e000000-0000-4000-8000-000000000003"),
        ),
        withTenantTransaction(
          competingRuntimePool,
          { ...sendContext, correlationId: "price-publish-concurrent-4" },
          (client) => publishPriceListVersion(client, "5f000000-0000-4000-8000-000000000004"),
        ),
      ]);
      assert.equal(concurrentPublications.length, 2);
      const publicationEvidence = await target.query(`
        SELECT status, count(*)::integer AS count
        FROM price_list_versions
        WHERE price_list_id='58000000-0000-4000-8000-000000000002'
        GROUP BY status ORDER BY status
      `);
      assert.deepEqual(publicationEvidence.rows, [
        { status: "PUBLISHED", count: 1 },
        { status: "RETIRED", count: 3 },
      ]);
      await withTenantTransaction(runtimePool,
        { ...sendContext, correlationId: "price-publish-retired-replay" },
        (client) => publishPriceListVersion(client, "5e000000-0000-4000-8000-000000000003"));

      await target.query(`
        INSERT INTO conversations
          (id, tenant_id, channel_connection_id, contact_id, contact_identity_id, unit_id)
        VALUES ('64000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
          '41000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001',
          '43000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'));
        INSERT INTO service_cases (id, tenant_id, conversation_id, unit_id, kind)
        VALUES ('65000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000009', (SELECT id FROM units WHERE code='POOL-A'), 'MEDICAL_ORDER');
        INSERT INTO messages
          (id, tenant_id, conversation_id, direction, actor, external_message_id, body) VALUES
          ('66000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
            '64000000-0000-4000-8000-000000000009', 'INBOUND', 'CUSTOMER',
            'medical-concurrent-first-a', 'Primeiro pedido concorrente'),
          ('66000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-000000000001',
            '64000000-0000-4000-8000-000000000009', 'INBOUND', 'CUSTOMER',
            'medical-concurrent-second-a', 'Segundo pedido concorrente');
        INSERT INTO message_attachments
          (id, tenant_id, message_id, media_type, storage_key, mime_type, sha256) VALUES
          ('6c000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
            '66000000-0000-4000-8000-000000000009', 'DOCUMENT',
            'tenant-a/concurrent-first.pdf', 'application/pdf', repeat('9',64)),
          ('6c000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-000000000001',
            '66000000-0000-4000-8000-00000000000a', 'DOCUMENT',
            'tenant-a/concurrent-second.pdf', 'application/pdf', repeat('a',64));
        INSERT INTO users (id, tenant_id, email, display_name)
        VALUES ('60000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-000000000001',
          'reviewer-a2@example.test', 'Reviewer A2');
        INSERT INTO user_units (tenant_id, user_id, unit_id, role)
        SELECT '40000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-00000000000a', id, 'ATTENDANT'
        FROM units WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A';
      `);
      const concurrentReceiveInput = {
        serviceCaseId: "65000000-0000-4000-8000-000000000009",
        messageId: "66000000-0000-4000-8000-000000000009",
        attachmentId: "6c000000-0000-4000-8000-000000000009",
        documentSha256: "9".repeat(64), pageCount: 1, idempotencyKey: "medical-concurrent-receive-a",
      };
      const concurrentReceives = await Promise.allSettled([
        withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "medical-concurrent-receive-a-1",
        }, (client) => receiveMedicalOrder(client, concurrentReceiveInput)),
        withTenantTransaction(competingRuntimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "medical-concurrent-receive-a-2",
        }, (client) => receiveMedicalOrder(client, concurrentReceiveInput)),
      ]);
      assert.equal(concurrentReceives.filter((result) => result.status === "fulfilled").length, 2);
      const concurrentFirstOrder = concurrentReceives[0].value;
      assert.equal(concurrentReceives[1].value.id, concurrentFirstOrder.id);
      const concurrentReceiveEvidence = await target.query(`
        SELECT count(*)::integer AS orders,
          (SELECT count(*)::integer FROM medical_order_pages page
            WHERE page.medical_order_id=$1) AS pages
        FROM medical_orders medical WHERE medical.idempotency_key='medical-concurrent-receive-a'
      `, [concurrentFirstOrder.id]);
      assert.deepEqual(concurrentReceiveEvidence.rows[0], { orders: 1, pages: 1 });

      const concurrentSecondOrder = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-concurrent-second-receive-a",
      }, (client) => receiveMedicalOrder(client, {
        serviceCaseId: "65000000-0000-4000-8000-000000000009",
        messageId: "66000000-0000-4000-8000-00000000000a",
        attachmentId: "6c000000-0000-4000-8000-00000000000a",
        documentSha256: "a".repeat(64), pageCount: 1, idempotencyKey: "medical-concurrent-second-a",
      }));
      const extractionFor = (medicalOrderId, expectedOrderVersion, text, idempotencyKey) => ({
        medicalOrderId, expectedOrderVersion, expectedCaseVersion: 1,
        provider: "TEST_OCR", model: "test-model", modelVersion: "1",
        confidenceThreshold: 0.8, confidencePolicyVersion: "medical-ocr-v1",
        pages: [{ pageNumber: 1, ocrText: text, confidence: 0.9,
          items: [{ sequence: 1, rawText: text, confidence: 0.9 }] }], idempotencyKey,
      });
      const concurrentExtractions = await Promise.allSettled([
        withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "medical-shared-handoff-extract-a-1",
        }, (client) => applyMedicalOrderExtraction(client,
          extractionFor(concurrentFirstOrder.id, concurrentFirstOrder.version,
            "Hemograma concorrente", "medical-shared-handoff-extract-a-1"))),
        withTenantTransaction(competingRuntimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "medical-shared-handoff-extract-a-2",
        }, (client) => applyMedicalOrderExtraction(client,
          extractionFor(concurrentSecondOrder.id, concurrentSecondOrder.version,
            "Glicose concorrente", "medical-shared-handoff-extract-a-2"))),
      ]);
      assert.equal(concurrentExtractions.filter((result) => result.status === "fulfilled").length, 2,
        concurrentExtractions.map((result) => result.status === "rejected"
          ? String(result.reason?.message ?? result.reason) : "FULFILLED").join(" | "));
      const sharedHandoffEvidence = await target.query(`
        SELECT (SELECT count(*)::integer FROM medical_orders medical
            WHERE medical.service_case_id='65000000-0000-4000-8000-000000000009'
              AND medical.status='REVIEW_REQUIRED') AS review_orders,
          (SELECT count(*)::integer FROM medical_order_items item JOIN medical_orders medical
            ON medical.id=item.medical_order_id
            WHERE medical.service_case_id='65000000-0000-4000-8000-000000000009') AS items,
          (SELECT count(*)::integer FROM human_handoffs handoff
            WHERE handoff.conversation_id='64000000-0000-4000-8000-000000000009'
              AND handoff.status IN ('REQUESTED','QUEUED','ACTIVE')) AS open_handoffs,
          (SELECT status FROM service_cases WHERE id='65000000-0000-4000-8000-000000000009') AS case_status,
          (SELECT automation_status FROM conversations
            WHERE id='64000000-0000-4000-8000-000000000009') AS automation_status
      `);
      assert.deepEqual(sharedHandoffEvidence.rows[0], {
        review_orders: 2, items: 2, open_handoffs: 1,
        case_status: "WAITING_HUMAN", automation_status: "HUMAN_QUEUED",
      });

      const concurrentReviewItem = await target.query(
        "SELECT id FROM medical_order_items WHERE medical_order_id=$1",
        [concurrentFirstOrder.id],
      );
      const concurrentReviewVersion = concurrentExtractions.find((result) =>
        result.status === "fulfilled" && result.value.id === concurrentFirstOrder.id).value.version;
      const concurrentReviews = await Promise.allSettled([
        withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
          correlationId: "medical-concurrent-review-a-1",
        }, (client) => reviewMedicalOrder(client, concurrentFirstOrder.id, concurrentReviewVersion, [{
          itemId: concurrentReviewItem.rows[0].id, action: "REJECT",
          reason: "DECISAO_CONCORRENTE_DIVERGENTE",
        } ])),
        withTenantTransaction(competingRuntimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: "60000000-0000-4000-8000-00000000000a",
          correlationId: "medical-concurrent-review-a-2",
        }, (client) => reviewMedicalOrder(client, concurrentFirstOrder.id, concurrentReviewVersion, [{
          itemId: concurrentReviewItem.rows[0].id, action: "CONFIRM",
          confirmedCatalogItemId: "47000000-0000-4000-8000-000000000001",
        } ])),
      ]);
      assert.equal(concurrentReviews.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrentReviews.filter((result) => result.status === "rejected").length, 1);
      assert.match(concurrentReviews.find((result) => result.status === "rejected").reason.message,
        /MEDICAL_ORDER_REVIEW_CONFLICT/);
      const concurrentReviewEvidence = await target.query(`
        SELECT medical.status, medical.version, medical.reviewed_by_user_id,
          item.status AS item_status, item.reviewed_by_user_id AS item_reviewer,
          (SELECT count(*)::integer FROM medical_order_review_events event
            WHERE event.medical_order_id=medical.id) AS events
        FROM medical_orders medical JOIN medical_order_items item
          ON item.tenant_id=medical.tenant_id AND item.medical_order_id=medical.id
        WHERE medical.id=$1
      `, [concurrentFirstOrder.id]);
      assert.equal(concurrentReviewEvidence.rows[0].status, "REVIEWED");
      assert.equal(concurrentReviewEvidence.rows[0].version, concurrentReviewVersion + 1);
      assert.ok(["CONFIRMED", "REJECTED"].includes(concurrentReviewEvidence.rows[0].item_status));
      assert.equal(concurrentReviewEvidence.rows[0].reviewed_by_user_id,
        concurrentReviewEvidence.rows[0].item_reviewer);
      assert.equal(concurrentReviewEvidence.rows[0].events, 2);

      await target.query(`
        INSERT INTO conversations
          (id, tenant_id, channel_connection_id, contact_id, contact_identity_id, unit_id)
        VALUES ('64000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000001',
          '41000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001',
          '43000000-0000-4000-8000-000000000001', (SELECT id FROM units WHERE code='POOL-A'));
        INSERT INTO service_cases (id, tenant_id, conversation_id, unit_id, kind)
        VALUES ('65000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000006', (SELECT id FROM units WHERE code='POOL-A'), 'MEDICAL_ORDER');
        INSERT INTO messages
          (id, tenant_id, conversation_id, direction, actor, external_message_id, body)
        VALUES ('66000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000006', 'INBOUND', 'CUSTOMER', 'medical-runtime-a', 'Pedido médico');
        INSERT INTO message_attachments
          (id, tenant_id, message_id, media_type, storage_key, mime_type, sha256)
        VALUES ('6c000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000001',
          '66000000-0000-4000-8000-000000000006', 'DOCUMENT', 'tenant-a/runtime-order.pdf',
          'application/pdf', repeat('c',64));
      `);
      const receivedOrder = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "medical-receive-a",
        },
        (client) => receiveMedicalOrder(client, {
          serviceCaseId: "65000000-0000-4000-8000-000000000006",
          messageId: "66000000-0000-4000-8000-000000000006",
          attachmentId: "6c000000-0000-4000-8000-000000000006",
          documentSha256: "c".repeat(64),
          pageCount: 1,
          idempotencyKey: "medical-runtime-a",
        }),
      );
      assert.equal(receivedOrder.status, "PROCESSING");
      const replayedOrder = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "medical-receive-replay-a",
        },
        (client) => receiveMedicalOrder(client, {
          serviceCaseId: "65000000-0000-4000-8000-000000000006",
          messageId: "66000000-0000-4000-8000-000000000006",
          attachmentId: "6c000000-0000-4000-8000-000000000006",
          documentSha256: "c".repeat(64),
          pageCount: 1,
          idempotencyKey: "medical-runtime-a",
        }),
      );
      assert.equal(replayedOrder.id, receivedOrder.id);
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-receive-mismatch-a",
      }, (client) => receiveMedicalOrder(client, {
        serviceCaseId: "65000000-0000-4000-8000-000000000006",
        messageId: "66000000-0000-4000-8000-000000000006",
        attachmentId: "6c000000-0000-4000-8000-000000000006", documentSha256: "c".repeat(64),
        pageCount: 2, idempotencyKey: "medical-runtime-a",
      })), /IDEMPOTENCY_KEY_REUSED/);
      const extractedOrder = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "medical-extraction-a",
        },
        (client) => applyMedicalOrderExtraction(client, {
          medicalOrderId: receivedOrder.id,
          expectedOrderVersion: receivedOrder.version,
          expectedCaseVersion: 1,
          provider: "TEST_OCR",
          model: "test-model",
          modelVersion: "1",
          confidenceThreshold: 0.8,
          confidencePolicyVersion: "medical-ocr-v1",
          pages: [{
            pageNumber: 1,
            ocrText: "Hemograma completo",
            confidence: 0.7,
            items: [{
              sequence: 1,
              rawText: "Hemograma completo",
              normalizedText: "hemograma completo",
              suggestedCatalogItemId: "47000000-0000-4000-8000-000000000001",
              confidence: 0.55,
            }],
          }],
          idempotencyKey: "medical-extraction-a",
        }),
      );
      assert.equal(extractedOrder.status, "REVIEW_REQUIRED");
      const extractionReplay = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-extraction-replay-a",
      }, (client) => applyMedicalOrderExtraction(client, {
        medicalOrderId: receivedOrder.id, expectedOrderVersion: receivedOrder.version, expectedCaseVersion: 1,
        provider: "TEST_OCR", model: "test-model", modelVersion: "1", confidenceThreshold: 0.8,
        confidencePolicyVersion: "medical-ocr-v1", pages: [{ pageNumber: 1,
          ocrText: "Hemograma completo", confidence: 0.7, items: [{ sequence: 1,
            rawText: "Hemograma completo", normalizedText: "hemograma completo",
            suggestedCatalogItemId: "47000000-0000-4000-8000-000000000001", confidence: 0.55 }] }],
        idempotencyKey: "medical-extraction-a",
      }));
      assert.equal(extractionReplay.version, extractedOrder.version);
      const extractedItem = await target.query(
        "SELECT id FROM medical_order_items WHERE medical_order_id=$1",
        [receivedOrder.id],
      );
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-false-event-a",
      }, (client) => client.query(`INSERT INTO medical_order_review_events
        (tenant_id,medical_order_id,medical_order_item_id,action,actor_id,correlation_id,idempotency_key)
        VALUES (current_app_tenant_id(),$1,$2,'CONFIRMED',current_app_actor_id(),
          current_setting('app.correlation_id'),'false-confirmation-event')`,
      [receivedOrder.id, extractedItem.rows[0].id])), /MEDICAL_ORDER_REVIEW_EVENT_STATE_INVALID/);
      const reviewedOrder = await withTenantTransaction(
        runtimePool,
        {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "medical-review-a",
        },
        (client) => reviewMedicalOrder(client, receivedOrder.id, extractedOrder.version, [{
          itemId: extractedItem.rows[0].id,
          action: "CONFIRM",
          confirmedCatalogItemId: "47000000-0000-4000-8000-000000000001",
        }]),
      );
      assert.equal(reviewedOrder.status, "REVIEWED");
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-review-duplicate-replay-a",
      }, (client) => reviewMedicalOrder(client, receivedOrder.id, reviewedOrder.version, [{
        itemId: extractedItem.rows[0].id, action: "CONFIRM",
        confirmedCatalogItemId: "47000000-0000-4000-8000-000000000001",
      }, {
        itemId: extractedItem.rows[0].id, action: "CONFIRM",
        confirmedCatalogItemId: "47000000-0000-4000-8000-000000000001",
      }])), /MEDICAL_ORDER_REVIEW_DUPLICATE_ITEM/);
      await target.query(`
        INSERT INTO service_cases (id,tenant_id,conversation_id,unit_id,kind)
        VALUES ('65000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000006',(SELECT id FROM units WHERE code='POOL-A'),'MEDICAL_ORDER');
        INSERT INTO messages (id,tenant_id,conversation_id,direction,actor,external_message_id,body)
        VALUES ('66000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000006','INBOUND','CUSTOMER','medical-handoff-conflict-a','Outro pedido');
        INSERT INTO message_attachments (id,tenant_id,message_id,media_type,storage_key,mime_type,sha256)
        VALUES ('6c000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000001',
          '66000000-0000-4000-8000-000000000008','DOCUMENT','tenant-a/conflict.pdf','application/pdf',repeat('e',64));
      `);
      const conflictingReceived = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-handoff-conflict-receive-a",
      }, (client) => receiveMedicalOrder(client, {
        serviceCaseId: "65000000-0000-4000-8000-000000000008",
        messageId: "66000000-0000-4000-8000-000000000008",
        attachmentId: "6c000000-0000-4000-8000-000000000008", documentSha256: "e".repeat(64),
        pageCount: 1, idempotencyKey: "medical-handoff-conflict-receive-a",
      }));
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-handoff-conflict-extract-a",
      }, (client) => applyMedicalOrderExtraction(client, {
        medicalOrderId: conflictingReceived.id, expectedOrderVersion: conflictingReceived.version,
        expectedCaseVersion: 1, provider: "TEST_OCR", model: "test-model", modelVersion: "1",
        confidenceThreshold: 0.8, confidencePolicyVersion: "medical-ocr-v1",
        pages: [{ pageNumber: 1, ocrText: "Glicose", confidence: 0.9,
          items: [{ sequence: 1, rawText: "Glicose", confidence: 0.9 }] }],
        idempotencyKey: "medical-handoff-conflict-extract-a",
      })), /HANDOFF_OPEN_FOR_ANOTHER_CASE/);
      const medicalHandoffRollbackEvidence = await target.query(`SELECT medical.status, page.status AS page_status,
        (SELECT count(*)::integer FROM medical_order_items item WHERE item.medical_order_id=medical.id) AS items,
        service_case.status AS case_status FROM medical_orders medical
        JOIN medical_order_pages page ON page.medical_order_id=medical.id
        JOIN service_cases service_case ON service_case.id=medical.service_case_id WHERE medical.id=$1`,
      [conflictingReceived.id]);
      assert.deepEqual(medicalHandoffRollbackEvidence.rows[0], { status: "PROCESSING", page_status: "PENDING",
        items: 0, case_status: "COLLECTING" });
      const medicalEvidence = await target.query(`
        SELECT medical.status, medical.overall_confidence, item.status AS item_status,
          item.reviewed_by_user_id, service_case.status AS case_status,
          conversation.automation_status,
          (SELECT count(*)::integer FROM human_handoffs handoff
            WHERE handoff.conversation_id=medical.conversation_id AND handoff.status IN ('REQUESTED','QUEUED','ACTIVE')) AS open_handoffs,
          (SELECT count(*)::integer FROM quotes quote WHERE quote.service_case_id=medical.service_case_id) AS quotes
        FROM medical_orders medical
        JOIN medical_order_items item ON item.tenant_id=medical.tenant_id AND item.medical_order_id=medical.id
        JOIN service_cases service_case ON service_case.tenant_id=medical.tenant_id AND service_case.id=medical.service_case_id
        JOIN conversations conversation ON conversation.tenant_id=medical.tenant_id AND conversation.id=medical.conversation_id
        WHERE medical.id=$1
      `, [receivedOrder.id]);
      assert.deepEqual(medicalEvidence.rows[0], {
        status: "REVIEWED", overall_confidence: "0.5500", item_status: "CONFIRMED",
        reviewed_by_user_id: actorAId, case_status: "WAITING_HUMAN",
        automation_status: "HUMAN_QUEUED", open_handoffs: 1, quotes: 0,
      });
      await assert.rejects(
        target.query("UPDATE medical_order_items SET raw_text='ALTERED' WHERE id=$1", [extractedItem.rows[0].id]),
        /MEDICAL_ORDER_ITEM_SOURCE_IMMUTABLE/,
      );

      await target.query(`
        INSERT INTO conversations (id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id)
        VALUES ('64000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001',
          '41000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
          '43000000-0000-4000-8000-000000000001',(SELECT id FROM units WHERE code='POOL-A'));
        INSERT INTO service_cases (id,tenant_id,conversation_id,unit_id,kind)
        VALUES ('65000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000007',(SELECT id FROM units WHERE code='POOL-A'),'MEDICAL_ORDER');
        INSERT INTO messages (id,tenant_id,conversation_id,direction,actor,external_message_id,body)
        VALUES ('66000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001',
          '64000000-0000-4000-8000-000000000007','INBOUND','CUSTOMER','medical-unreadable-a','Pedido ilegível');
        INSERT INTO message_attachments (id,tenant_id,message_id,media_type,storage_key,mime_type,sha256)
        VALUES ('6c000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001',
          '66000000-0000-4000-8000-000000000007','IMAGE','tenant-a/unreadable.jpg','image/jpeg',repeat('d',64));
      `);
      const unreadableReceived = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-unreadable-receive-a",
      }, (client) => receiveMedicalOrder(client, {
        serviceCaseId: "65000000-0000-4000-8000-000000000007",
        messageId: "66000000-0000-4000-8000-000000000007",
        attachmentId: "6c000000-0000-4000-8000-000000000007", documentSha256: "d".repeat(64),
        pageCount: 1, idempotencyKey: "medical-unreadable-receive-a",
      }));
      const actorWithoutUnit = "60000000-0000-4000-8000-000000000009";
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name)
        VALUES ($1,'40000000-0000-4000-8000-000000000001','no-unit@example.test','No Unit')`,
      [actorWithoutUnit]);
      await target.query(`INSERT INTO units (tenant_id,code,name)
        VALUES ('40000000-0000-4000-8000-000000000001','POOL-A2','Pool A2')`);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
        SELECT '40000000-0000-4000-8000-000000000001',$1,id,'ATTENDANT'
        FROM units WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A2'`,
      [actorWithoutUnit]);
      const tenantAdminId = "60000000-0000-4000-8000-00000000000b";
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name)
        VALUES ($1,'40000000-0000-4000-8000-000000000001','tenant-admin-a@test.local','Tenant Admin A')`,
      [tenantAdminId]);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
        SELECT '40000000-0000-4000-8000-000000000001',$1,id,'TENANT_ADMIN'
        FROM units WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`,
      [tenantAdminId]);
      const crossTenantUnitId = (await target.query(
        "SELECT id FROM units WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND code='POOL-B'",
      )).rows[0].id;
      const permissionMatrix = async (actorId) => withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId,
        correlationId: `permission-matrix-${actorId}`,
      }, async (client) => (await client.query(`SELECT
        current_actor_has_permission('handoff.claim',
          (SELECT id FROM units WHERE tenant_id=current_app_tenant_id() AND code='POOL-A')) AS pool_a_claim,
        current_actor_has_permission('handoff.claim',
          (SELECT id FROM units WHERE tenant_id=current_app_tenant_id() AND code='POOL-A2')) AS pool_a2_claim,
        current_actor_has_permission('tenant.users.manage', NULL) AS tenant_users_manage,
        current_actor_has_permission('permission.unknown',
          (SELECT id FROM units WHERE tenant_id=current_app_tenant_id() AND code='POOL-A')) AS unknown_permission,
        current_actor_has_permission('handoff.claim', $1) AS cross_tenant_unit`,
      [crossTenantUnitId])).rows[0]);
      assert.deepEqual(await permissionMatrix(actorAId), {
        pool_a_claim: true, pool_a2_claim: false, tenant_users_manage: false,
        unknown_permission: false, cross_tenant_unit: false,
      });
      assert.deepEqual(await permissionMatrix(actorWithoutUnit), {
        pool_a_claim: false, pool_a2_claim: true, tenant_users_manage: false,
        unknown_permission: false, cross_tenant_unit: false,
      });
      assert.deepEqual(await permissionMatrix(tenantAdminId), {
        pool_a_claim: true, pool_a2_claim: true, tenant_users_manage: true,
        unknown_permission: false, cross_tenant_unit: false,
      });
      await target.query(`UPDATE units SET active=false
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      assert.deepEqual(await permissionMatrix(tenantAdminId), {
        pool_a_claim: false, pool_a2_claim: false, tenant_users_manage: false,
        unknown_permission: false, cross_tenant_unit: false,
      });
      await target.query(`UPDATE units SET active=true
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      const permissionFunctionPrivileges = await target.query(`SELECT
        has_function_privilege('zap_pronto_api', 'current_actor_has_permission(text,uuid)', 'EXECUTE') AS api_execute,
        has_function_privilege('zap_pronto_worker', 'current_actor_has_permission(text,uuid)', 'EXECUTE') AS worker_execute,
        has_function_privilege('zap_pronto_app', 'current_actor_has_permission(text,uuid)', 'EXECUTE') AS legacy_execute`);
      assert.deepEqual(permissionFunctionPrivileges.rows[0], {
        api_execute: true, worker_execute: false, legacy_execute: false,
      });
      const crossUnitCommercialVisibility = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorWithoutUnit,
        correlationId: "cross-unit-commercial-deny-a",
      }, async (client) => ({
        priceLists: Number((await client.query("SELECT count(*)::integer AS count FROM price_lists")).rows[0].count),
        quotes: Number((await client.query("SELECT count(*)::integer AS count FROM quotes")).rows[0].count),
        medicalOrders: Number((await client.query("SELECT count(*)::integer AS count FROM medical_orders")).rows[0].count),
      }));
      assert.deepEqual(crossUnitCommercialVisibility, { priceLists: 0, quotes: 0, medicalOrders: 0 });
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorWithoutUnit,
        correlationId: "medical-unreadable-forbidden-a",
      }, (client) => markMedicalOrderUnreadable(client, unreadableReceived.id,
        unreadableReceived.version, 1, "FORGED_UNREADABLE")), /MEDICAL_ORDER_UNREADABLE_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-processing-evidence-forgery-a",
      }, (client) => client.query("UPDATE medical_orders SET processing_provider='FORGED' WHERE id=$1",
        [unreadableReceived.id])), /MEDICAL_ORDER_EXTRACTION_IMMUTABLE/);
      const unreadable = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "medical-unreadable-mark-a",
      }, (client) => markMedicalOrderUnreadable(client, unreadableReceived.id, unreadableReceived.version, 1,
        "DOCUMENT_IMAGE_UNREADABLE"));
      assert.equal(unreadable.status, "UNREADABLE");
      const unreadableEvidence = await target.query(`SELECT medical.status, medical.failure_code,
        service_case.status AS case_status, conversation.automation_status,
        (SELECT count(*)::integer FROM human_handoffs h WHERE h.conversation_id=medical.conversation_id
          AND h.status IN ('REQUESTED','QUEUED','ACTIVE')) AS open_handoffs,
        (SELECT count(*)::integer FROM medical_order_review_events e WHERE e.medical_order_id=medical.id
          AND e.action='MARKED_UNREADABLE') AS events
        FROM medical_orders medical JOIN service_cases service_case ON service_case.id=medical.service_case_id
        JOIN conversations conversation ON conversation.id=medical.conversation_id WHERE medical.id=$1`,
      [unreadableReceived.id]);
      assert.deepEqual(unreadableEvidence.rows[0], { status: "UNREADABLE",
        failure_code: "DOCUMENT_IMAGE_UNREADABLE", case_status: "WAITING_HUMAN",
        automation_status: "HUMAN_QUEUED", open_handoffs: 1, events: 1 });

      await target.query(`
        UPDATE outbox_events SET available_at = now() + interval '1 day'
        WHERE tenant_id = '40000000-0000-4000-8000-000000000001' AND status = 'PENDING';
        INSERT INTO outbox_events
          (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, max_attempts) VALUES
          ('81000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.ack', '{}', 'worker-ack', 3),
          ('82000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.retry', '{}', 'worker-retry', 3),
          ('83000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.dead', '{}', 'worker-dead', 1);
        INSERT INTO outbox_events
          (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key,
           status, attempts, max_attempts, lease_token, leased_at, lease_expires_at) VALUES
          ('86000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.sweep', '{}', 'worker-sweep',
           'PROCESSING', 1, 1, '96000000-0000-4000-8000-000000000006', now() - interval '2 minutes', now() - interval '1 minute'),
          ('87000000-0000-4000-8000-000000000007', '50000000-0000-4000-8000-000000000002', 'test', '54000000-0000-4000-8000-000000000002', 'worker.tenant-b', '{}', 'worker-tenant-b',
           'PROCESSING', 1, 3, '97000000-0000-4000-8000-000000000007', now(), now() + interval '5 minutes');
      `);

      const worker = await workerPool.connect();
      try {
        await worker.query("BEGIN");
        await worker.query("SET LOCAL ROLE zap_pronto_worker");
        await worker.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
          ["40000000-0000-4000-8000-000000000001", actorAId],
        );
        await worker.query("SELECT assert_app_context_authorized()");
        const claimed = await worker.query("SELECT * FROM claim_outbox_events(3, 60) ORDER BY id");
        assert.equal(claimed.rowCount, 3);
        assert.deepEqual(claimed.rows.map((row) => row.attempts), [1, 1, 1]);
        assert.equal(new Set(claimed.rows.map((row) => row.lease_token)).size, 3);
        const [ackEvent, retryEvent, deadEvent] = claimed.rows;
        const wrongTenantAck = await worker.query(
          "SELECT acknowledge_outbox_event($1, $2) AS acknowledged",
          ["87000000-0000-4000-8000-000000000007", "97000000-0000-4000-8000-000000000007"],
        );
        assert.equal(wrongTenantAck.rows[0].acknowledged, false);
        const wrongTenantFail = await worker.query(
          "SELECT fail_outbox_event($1, $2, 'CROSS_TENANT', 30) AS status",
          ["87000000-0000-4000-8000-000000000007", "97000000-0000-4000-8000-000000000007"],
        );
        assert.equal(wrongTenantFail.rows[0].status, null);
        const acknowledged = await worker.query(
          "SELECT acknowledge_outbox_event($1, $2) AS acknowledged",
          [ackEvent.id, ackEvent.lease_token],
        );
        assert.equal(acknowledged.rows[0].acknowledged, true);
        const duplicateAck = await worker.query(
          "SELECT acknowledge_outbox_event($1, $2) AS acknowledged",
          [ackEvent.id, ackEvent.lease_token],
        );
        assert.equal(duplicateAck.rows[0].acknowledged, false);
        const retryStatus = await worker.query(
          "SELECT fail_outbox_event($1, $2, 'TEMPORARY_FAILURE', 30) AS status",
          [retryEvent.id, retryEvent.lease_token],
        );
        assert.equal(retryStatus.rows[0].status, "PENDING");
        const deadStatus = await worker.query(
          "SELECT fail_outbox_event($1, $2, 'PERMANENT_FAILURE', 30) AS status",
          [deadEvent.id, deadEvent.lease_token],
        );
        assert.equal(deadStatus.rows[0].status, "DEAD");
        await worker.query("COMMIT");
      } finally {
        worker.release();
      }

      const outboxEvidence = await target.query(`
        SELECT idempotency_key, status, attempts, lease_token, published_at IS NOT NULL AS published,
          dead_lettered_at IS NOT NULL AS dead_lettered, available_at > now() AS backoff_scheduled
        FROM outbox_events WHERE idempotency_key IN ('worker-ack', 'worker-retry', 'worker-dead')
        ORDER BY idempotency_key
      `);
      assert.deepEqual(outboxEvidence.rows, [
        { idempotency_key: "worker-ack", status: "PUBLISHED", attempts: 1, lease_token: null, published: true, dead_lettered: false, backoff_scheduled: false },
        { idempotency_key: "worker-dead", status: "DEAD", attempts: 1, lease_token: null, published: false, dead_lettered: true, backoff_scheduled: false },
        { idempotency_key: "worker-retry", status: "PENDING", attempts: 1, lease_token: null, published: false, dead_lettered: false, backoff_scheduled: true },
      ]);
      const deadAudit = await target.query(
        "SELECT count(*)::integer AS count FROM audit_events WHERE action = 'OUTBOX_DEAD_LETTERED' AND entity_id = '83000000-0000-4000-8000-000000000003'",
      );
      assert.equal(deadAudit.rows[0].count, 1);
      const isolationAndSweep = await target.query(`
        SELECT idempotency_key, status, lease_token,
          (SELECT count(*)::integer FROM audit_events audit
            WHERE audit.action = 'OUTBOX_DEAD_LETTERED' AND audit.entity_id = event.id::text) AS audits
        FROM outbox_events event
        WHERE idempotency_key IN ('worker-sweep', 'worker-tenant-b')
        ORDER BY idempotency_key
      `);
      assert.deepEqual(isolationAndSweep.rows, [
        { idempotency_key: "worker-sweep", status: "DEAD", lease_token: null, audits: 1 },
        { idempotency_key: "worker-tenant-b", status: "PROCESSING", lease_token: "97000000-0000-4000-8000-000000000007", audits: 0 },
      ]);

      await target.query(`
        UPDATE outbox_events SET available_at = now() - interval '1 second'
        WHERE idempotency_key = 'worker-retry'
      `);
      const reclaimWorker = await workerPool.connect();
      let firstLease;
      try {
        await reclaimWorker.query("BEGIN");
        await reclaimWorker.query("SET LOCAL ROLE zap_pronto_worker");
        await reclaimWorker.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
          ["40000000-0000-4000-8000-000000000001", actorAId],
        );
        const firstReclaim = await reclaimWorker.query("SELECT * FROM claim_outbox_events(1, 60)");
        assert.equal(firstReclaim.rows[0].attempts, 2);
        firstLease = firstReclaim.rows[0].lease_token;
        await reclaimWorker.query("COMMIT");
      } finally {
        reclaimWorker.release();
      }
      await target.query(`
        UPDATE outbox_events SET lease_expires_at = now() - interval '1 second'
        WHERE idempotency_key = 'worker-retry'
      `);
      const expiredLeaseWorker = await workerPool.connect();
      try {
        await expiredLeaseWorker.query("BEGIN");
        await expiredLeaseWorker.query("SET LOCAL ROLE zap_pronto_worker");
        await expiredLeaseWorker.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
          ["40000000-0000-4000-8000-000000000001", actorAId],
        );
        const reclaimed = await expiredLeaseWorker.query("SELECT * FROM claim_outbox_events(1, 60)");
        assert.equal(reclaimed.rows[0].attempts, 3);
        assert.notEqual(reclaimed.rows[0].lease_token, firstLease);
        const staleAck = await expiredLeaseWorker.query(
          "SELECT acknowledge_outbox_event($1, $2) AS acknowledged",
          [reclaimed.rows[0].id, firstLease],
        );
        assert.equal(staleAck.rows[0].acknowledged, false);
        const currentAck = await expiredLeaseWorker.query(
          "SELECT acknowledge_outbox_event($1, $2) AS acknowledged",
          [reclaimed.rows[0].id, reclaimed.rows[0].lease_token],
        );
        assert.equal(currentAck.rows[0].acknowledged, true);
        await expiredLeaseWorker.query("COMMIT");
      } finally {
        expiredLeaseWorker.release();
      }

      await target.query(`
        UPDATE outbox_events SET available_at = now() + interval '1 day'
        WHERE tenant_id = '40000000-0000-4000-8000-000000000001' AND status = 'PENDING';
        INSERT INTO outbox_events
          (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key) VALUES
          ('84000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.concurrent.a', '{}', 'worker-concurrent-a'),
          ('85000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.concurrent.b', '{}', 'worker-concurrent-b');
      `);
      const claimOne = async (pool) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE zap_pronto_worker");
          await client.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
            ["40000000-0000-4000-8000-000000000001", actorAId],
          );
          const result = await client.query("SELECT * FROM claim_outbox_events(1, 60)");
          await client.query("COMMIT");
          return result.rows[0];
        } finally {
          client.release();
        }
      };
      const concurrentOutboxClaims = await Promise.all([
        claimOne(workerPool),
        claimOne(competingWorkerPool),
      ]);
      assert.equal(new Set(concurrentOutboxClaims.map((event) => event.id)).size, 2);
      assert.equal(new Set(concurrentOutboxClaims.map((event) => event.lease_token)).size, 2);

      await target.query(`
        UPDATE outbox_events SET available_at = now() + interval '1 day'
        WHERE tenant_id = '40000000-0000-4000-8000-000000000001' AND status = 'PENDING';
        INSERT INTO outbox_events
          (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
        VALUES
          ('88000000-0000-4000-8000-000000000008', '40000000-0000-4000-8000-000000000001', 'test', '44000000-0000-4000-8000-000000000001', 'worker.locked', '{}', 'worker-locked');
      `);
      const lockingWorker = await workerPool.connect();
      const skippingWorker = await competingWorkerPool.connect();
      try {
        for (const client of [lockingWorker, skippingWorker]) {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE zap_pronto_worker");
          await client.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
            ["40000000-0000-4000-8000-000000000001", actorAId],
          );
        }
        const lockedClaim = await lockingWorker.query("SELECT * FROM claim_outbox_events(1, 60)");
        assert.equal(lockedClaim.rowCount, 1);
        const skippedClaim = await skippingWorker.query("SELECT * FROM claim_outbox_events(1, 60)");
        assert.equal(skippedClaim.rowCount, 0);
        await lockingWorker.query("ROLLBACK");
        await skippingWorker.query("COMMIT");
      } finally {
        await lockingWorker.query("ROLLBACK").catch(() => undefined);
        await skippingWorker.query("ROLLBACK").catch(() => undefined);
        lockingWorker.release();
        skippingWorker.release();
      }
      const rollbackEvidence = await target.query(`
        SELECT status, attempts, lease_token FROM outbox_events
        WHERE idempotency_key = 'worker-locked'
      `);
      assert.deepEqual(rollbackEvidence.rows[0], { status: "PENDING", attempts: 0, lease_token: null });

      const nullInputWorker = await workerPool.connect();
      try {
        await nullInputWorker.query("BEGIN");
        await nullInputWorker.query("SET LOCAL ROLE zap_pronto_worker");
        await nullInputWorker.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
          ["40000000-0000-4000-8000-000000000001", actorAId],
        );
        await assert.rejects(
          nullInputWorker.query("SELECT * FROM claim_outbox_events(NULL, 60)"),
          (error) => error instanceof Error && "code" in error && error.code === "22023",
        );
      } finally {
        await nullInputWorker.query("ROLLBACK").catch(() => undefined);
        nullInputWorker.release();
      }

      for (const forbiddenSql of [
        "SELECT * FROM prices",
        "INSERT INTO messages (tenant_id) VALUES ('40000000-0000-4000-8000-000000000001')",
        "UPDATE outbox_events SET attempts = attempts + 1 WHERE idempotency_key = 'outbox-a'",
      ]) {
        const workerCheck = await workerPool.connect();
        try {
          await workerCheck.query("BEGIN");
          await workerCheck.query("SET LOCAL ROLE zap_pronto_worker");
          await workerCheck.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
            ["40000000-0000-4000-8000-000000000001", actorAId],
          );
          await workerCheck.query("SELECT assert_app_context_authorized()");
          await assert.rejects(workerCheck.query(forbiddenSql), (error) =>
            error instanceof Error && "code" in error && error.code === "42501");
        } finally {
          await workerCheck.query("ROLLBACK").catch(() => undefined);
          workerCheck.release();
        }
      }
    } finally {
      await runtimePool.end();
      await competingRuntimePool.end();
      await workerPool.end();
      await competingWorkerPool.end();
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
  await admin.query(`DROP ROLE IF EXISTS ${quotedWorkerRuntimeRole}`).catch(() => undefined);
  await admin.end();
}
