import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const adminConnection = process.env.DATABASE_ADMIN_URL;
if (!adminConnection) throw new Error("DATABASE_ADMIN_URL_REQUIRED");

const databaseName = process.env.UPGRADE_TEST_DATABASE_NAME ?? "zap_pronto_upgrade_test";
if (!/^[a-z][a-z0-9_]{2,62}$/.test(databaseName)) throw new Error("INVALID_UPGRADE_TEST_DATABASE_NAME");

const quotedDatabase = `"${databaseName}"`;
const admin = new pg.Client({ connectionString: adminConnection });
const targetUrl = new URL(adminConnection);
targetUrl.pathname = `/${databaseName}`;
const suffix = randomBytes(4).toString("hex");
const migrationFiles = (await readdir(resolve("database/migrations")))
  .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
  .sort((left, right) => left.localeCompare(right));

function runMigrator() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/db-migrate.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: targetUrl.toString() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`DB_MIGRATE_FAILED:${code}\n${stdout}${stderr}`));
    });
  });
}

await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quotedDatabase}`);

  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    await target.query(`CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum_sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    for (const filename of [
      "0001_core.sql",
      "0002_tenant_context_hardening.sql",
      "0003_actor_context_authorization.sql",
      "0004_component_roles.sql",
    ]) {
      const sql = await readFile(resolve("database/migrations", filename), "utf8");
      await target.query(sql);
      await target.query(
        "INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1, $2)",
        [filename, createHash("sha256").update(sql).digest("hex")],
      );
    }

    await target.query(`
      INSERT INTO tenants (id, name) VALUES ('10000000-0000-4000-8000-000000000001', 'Legacy Tenant');
      INSERT INTO units (id, tenant_id, code, name) VALUES
        ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'LEGACY', 'Legacy Unit');
      INSERT INTO users (id, tenant_id, email, display_name) VALUES
        ('12000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', ' legacy-${suffix}@test.local ', 'Legacy User');
      INSERT INTO user_units (tenant_id, user_id, unit_id, role) VALUES
        ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'ATTENDANT');
      INSERT INTO channel_connections (id, tenant_id, type, scope, external_account_id) VALUES
        ('13000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'WHATSAPP', 'SINGLE_UNIT', 'legacy-${suffix}');
      INSERT INTO channel_connection_units (tenant_id, channel_connection_id, unit_id) VALUES
        ('10000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');
      INSERT INTO contacts (id, tenant_id, display_name) VALUES
        ('14000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Legacy Contact');
      INSERT INTO contact_identities (id, tenant_id, contact_id, channel_connection_id, external_user_id) VALUES
        ('15000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', 'legacy-contact');
      INSERT INTO conversations (id, tenant_id, channel_connection_id, contact_id, contact_identity_id, unit_id) VALUES
        ('16000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
        ('16000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
        ('16000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');
      INSERT INTO service_cases (id, tenant_id, conversation_id, unit_id, kind, status, collected_data) VALUES
        ('17000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'INFORMATION', 'COLLECTING', '{"legacy":true}'),
        ('17000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', 'INFORMATION', 'RESOLVED', '{"result":"kept"}'),
        ('17000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000001', 'INFORMATION', 'COLLECTING', '{}');
      INSERT INTO human_handoffs (id, tenant_id, conversation_id, service_case_id, unit_id, reason, status, assigned_user_id, idempotency_key, requested_at) VALUES
        ('18000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'LEGACY_ASSIGNED', 'ASSIGNED', '12000000-0000-4000-8000-000000000001', 'legacy-handoff-active', '2026-01-01T10:00:00Z'),
        ('18000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', 'LEGACY_RESOLVED', 'RESOLVED', NULL, 'legacy-handoff-resolved', '2026-01-02T10:00:00Z'),
        ('18000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000003', '17000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000001', 'LEGACY_ASSIGNED_EMPTY', 'ASSIGNED', NULL, 'legacy-handoff-queued', '2026-01-03T10:00:00Z');
      INSERT INTO catalog_items (id, tenant_id, code, name) VALUES
        ('19000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'LEGACY-ITEM', 'Legacy Item');
      INSERT INTO price_lists (id, tenant_id, unit_id, name) VALUES
        ('1a000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'Legacy Prices');
      INSERT INTO price_list_versions (id, tenant_id, price_list_id, version, status, effective_at) VALUES
        ('1b000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001', 1, 'ACTIVE', '2026-01-01T00:00:00Z'),
        ('1b000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001', 2, 'DRAFT', '2026-02-01T00:00:00Z');
      INSERT INTO prices (tenant_id, price_list_version_id, catalog_item_id, amount_minor) VALUES
        ('10000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', 12345);
      INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, occurred_at, published_at, attempts) VALUES
        ('1c000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'conversation', '16000000-0000-4000-8000-000000000001', 'legacy.pending', '{"keep":"pending"}', 'legacy-outbox-pending', '2026-01-04T10:00:00Z', NULL, 2),
        ('1c000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'conversation', '16000000-0000-4000-8000-000000000002', 'legacy.published', '{"keep":"published"}', 'legacy-outbox-published', '2026-01-05T10:00:00Z', '2026-01-05T10:01:00Z', 9);
    `);
  } finally {
    await target.end();
  }

  const firstRun = await runMigrator();
  assert.match(firstRun, /applied 0005_workflow_foundation\.sql/);
  assert.match(firstRun, /applied 0008_medical_orders\.sql/);
  assert.match(firstRun, /applied 0010_identity_rbac\.sql/);
  assert.match(firstRun, /applied 0011_permission_policy\.sql/);
  assert.match(firstRun, /applied 0012_user_lifecycle\.sql/);
  assert.match(firstRun, /applied 0013_admin_invitations\.sql/);

  const verify = new pg.Client({ connectionString: targetUrl.toString() });
  await verify.connect();
  try {
    const migrations = await verify.query("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(migrations.rows.map((row) => row.filename), migrationFiles);
    const conversations = await verify.query("SELECT count(*)::integer AS count, min(status::text) AS status FROM conversations");
    assert.deepEqual(conversations.rows[0], { count: 3, status: "OPEN" });
    const cases = await verify.query("SELECT id, status::text, version, resolved_at IS NOT NULL AS resolved, collected_data FROM service_cases ORDER BY id");
    assert.equal(cases.rowCount, 3);
    assert.deepEqual(cases.rows.map((row) => [row.status, row.version, row.resolved]), [
      ["COLLECTING", 1, false], ["RESOLVED", 1, true], ["COLLECTING", 1, false],
    ]);
    assert.deepEqual(cases.rows[1].collected_data, { result: "kept" });
    const handoffs = await verify.query("SELECT status::text, queued_at, claimed_at, resolved_at FROM human_handoffs ORDER BY id");
    assert.deepEqual(handoffs.rows.map((row) => row.status), ["ACTIVE", "RESOLVED", "QUEUED"]);
    assert.ok(handoffs.rows[0].queued_at && handoffs.rows[0].claimed_at && !handoffs.rows[0].resolved_at);
    assert.ok(!handoffs.rows[1].queued_at && !handoffs.rows[1].claimed_at && handoffs.rows[1].resolved_at);
    assert.ok(handoffs.rows[2].queued_at && !handoffs.rows[2].claimed_at && !handoffs.rows[2].resolved_at);
    const versions = await verify.query("SELECT status::text, effective_at, published_at, retired_at FROM price_list_versions ORDER BY version");
    assert.equal(versions.rows[0].status, "PUBLISHED");
    assert.equal(versions.rows[0].published_at.toISOString(), versions.rows[0].effective_at.toISOString());
    assert.deepEqual([versions.rows[1].status, versions.rows[1].published_at, versions.rows[1].retired_at], ["DRAFT", null, null]);
    const price = await verify.query("SELECT amount_minor::integer AS amount_minor FROM prices");
    assert.equal(price.rows[0].amount_minor, 12345);
    const outbox = await verify.query("SELECT status::text, payload, attempts, max_attempts, available_at, updated_at FROM outbox_events ORDER BY id");
    assert.deepEqual(outbox.rows.map((row) => [row.status, row.payload, row.attempts, row.max_attempts]), [
      ["PENDING", { keep: "pending" }, 2, 8], ["PUBLISHED", { keep: "published" }, 9, 9],
    ]);
    assert.ok(outbox.rows.every((row) => row.available_at && row.updated_at));
    const newDomainRows = await verify.query(`SELECT
      (SELECT count(*)::integer FROM workflow_transitions) AS workflow_count,
      (SELECT count(*)::integer FROM quotes) AS quote_count,
      (SELECT count(*)::integer FROM medical_orders) AS medical_count`);
    assert.deepEqual(newDomainRows.rows[0], { workflow_count: 0, quote_count: 0, medical_count: 0 });
    const identityUpgrade = await verify.query(`SELECT
      (SELECT count(*)::integer FROM app_roles) AS role_count,
      (SELECT count(*)::integer FROM app_permissions) AS permission_count,
      (SELECT count(*)::integer FROM oidc_providers) AS provider_count,
      (SELECT count(*)::integer FROM user_oidc_identities) AS identity_count,
      (SELECT count(*)::integer FROM user_units WHERE user_id='12000000-0000-4000-8000-000000000001') AS membership_count,
      (SELECT email FROM users WHERE id='12000000-0000-4000-8000-000000000001') AS normalized_email,
      (SELECT email_normalized FROM users WHERE id='12000000-0000-4000-8000-000000000001') AS generated_email,
      (SELECT version FROM users WHERE id='12000000-0000-4000-8000-000000000001') AS user_version,
      to_regprocedure('current_actor_has_permission(text,uuid)') IS NOT NULL AS permission_policy_exists`);
    assert.deepEqual(identityUpgrade.rows[0], {
      role_count: 5, permission_count: 9, provider_count: 0, identity_count: 0, membership_count: 1,
      normalized_email: `legacy-${suffix}@test.local`, generated_email: `legacy-${suffix}@test.local`, user_version: 1,
      permission_policy_exists: true,
    });
  } finally {
    await verify.end();
  }

  assert.equal(await runMigrator(), "");
  process.stdout.write("legacy upgrade: passed\n");
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
