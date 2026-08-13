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
const publishedOutboxWorker = (await readFile(resolve("database/migrations/0006_outbox_worker.sql"), "utf8"))
  .replace(/\r\n/gu, "\n");
assert.equal(createHash("sha256").update(publishedOutboxWorker).digest("hex"),
  "00c385c3b1a1a051d24e763268db530b9585ecefbd4873cda83211510d7cbde8");

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
  assert.match(firstRun, /applied 0014_invitation_user_lifecycle\.sql/);
  assert.match(firstRun, /applied 0015_oidc_invitation_acceptance\.sql/);
  assert.match(firstRun, /applied 0016_invitation_acceptance_rate_limit\.sql/);
  assert.match(firstRun, /applied 0018_inbound_channel_events\.sql/);
  assert.match(firstRun, /applied 0020_inbox_claim_target\.sql/);
  assert.match(firstRun, /applied 0021_human_text_outbound\.sql/);
  assert.match(firstRun, /applied 0022_outbound_cancellation_status\.sql/);
  assert.match(firstRun, /applied 0023_human_text_outbound_cancel\.sql/);
  assert.match(firstRun, /applied 0024_meta_delivery_status_receipts\.sql/);
  assert.match(firstRun, /applied 0025_meta_delivery_status_timestamp_guard\.sql/);
  assert.match(firstRun, /applied 0026_meta_delivery_status_message_time_guard\.sql/);
  assert.match(firstRun, /applied 0027_inbox_handoff_resolve\.sql/);
  assert.match(firstRun, /applied 0028_request_handoff_idempotency\.sql/);
  assert.match(firstRun, /applied 0029_outbound_worker_foundation\.sql/);
  assert.match(firstRun, /applied 0030_inbox_handoff_requeue\.sql/);
  assert.match(firstRun, /applied 0031_inbox_handoff_transfer\.sql/);
  assert.match(firstRun, /applied 0032_inbox_sla_priority\.sql/);
  assert.match(firstRun, /applied 0033_inbox_handoff_takeover\.sql/);
  assert.match(firstRun, /applied 0034_membership_lifecycle\.sql/);
  assert.match(firstRun, /applied 0035_medical_order_active_membership_rls\.sql/);
  assert.match(firstRun, /applied 0036_unit_membership_catalog\.sql/);
  assert.match(firstRun, /applied 0037_supervised_handoff_projection_types\.sql/);
  assert.match(firstRun, /applied 0038_handoff_transfer_active_membership\.sql/);
  assert.match(firstRun, /applied 0039_handoff_transfer_replay_authorization\.sql/);
  assert.match(firstRun, /applied 0040_handoff_transfer_reason\.sql/);
  assert.match(firstRun, /applied 0041_membership_assignment_serialization\.sql/);
  assert.match(firstRun, /applied 0042_handoff_resolution_disposition\.sql/);
  assert.match(firstRun, /applied 0043_handoff_replay_authorization\.sql/);
  assert.match(firstRun, /applied 0044_inbox_resolved_history\.sql/);
  assert.match(firstRun, /applied 0045_resolved_history_actor_join\.sql/);
  assert.match(firstRun, /applied 0046_closed_conversation_history_authorization\.sql/);
  assert.match(firstRun, /applied 0047_resolved_history_filters\.sql/);
  assert.match(firstRun, /applied 0048_closed_history_server_cutoff\.sql/);
  assert.match(firstRun, /applied 0049_handoff_reopen\.sql/);
  assert.match(firstRun, /applied 0050_handoff_reopen_latest_episode\.sql/);
  assert.match(firstRun, /applied 0051_attendant_availability\.sql/);
  assert.match(firstRun, /applied 0052_availability_authorization_hardening\.sql/);
  assert.match(firstRun, /applied 0053_inbox_sla_alerts\.sql/);
  assert.match(firstRun, /applied 0054_sla_alert_projection_hardening\.sql/);

  const verify = new pg.Client({ connectionString: targetUrl.toString() });
  await verify.connect();
  try {
    const migrations = await verify.query("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(migrations.rows.map((row) => row.filename), migrationFiles);
    const transferReplayUpgrade=await verify.query(`SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='handoff_transfer_commands' AND column_name='unit_id') unit_nullable,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='handoff_transfer_commands'::regclass
        AND conname='handoff_transfer_commands_unit_fk') unit_fk,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='handoff_transfer_commands' AND column_name='reason') reason_nullable,
      has_function_privilege('zap_pronto_api','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_api','transfer_inbox_handoff(uuid,integer,uuid,text,text)','EXECUTE') legacy_api_execute,
      has_function_privilege('zap_pronto_worker','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') worker_execute`);
    assert.deepEqual(transferReplayUpgrade.rows[0],{unit_nullable:"NO",unit_fk:true,reason_nullable:"NO",
      api_execute:true,legacy_api_execute:false,worker_execute:false});
    const reopenUpgrade=await verify.query(`SELECT
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='handoff.reopen' ORDER BY role_code) roles,
      has_function_privilege('zap_pronto_api','reopen_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','reopen_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') worker_execute,
      has_function_privilege('zap_pronto_app','reopen_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') app_execute,
      has_function_privilege('zap_pronto_api','reopen_inbox_handoff_v0049(uuid,integer,text,text,text)','EXECUTE') legacy_api_execute,
      has_function_privilege('zap_pronto_api','resolve_inbox_handoff_reopen_unit_v0049(uuid,integer,text,text,text)','EXECUTE') legacy_resolver_api_execute,
      has_table_privilege('zap_pronto_api','handoff_reopen_commands','SELECT') command_select`);
    assert.deepEqual(reopenUpgrade.rows[0],{roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],api_execute:true,
      worker_execute:false,app_execute:false,legacy_api_execute:false,legacy_resolver_api_execute:false,command_select:false});
    const availabilityUpgrade=await verify.query(`SELECT
      to_regclass('attendant_unit_availability') IS NOT NULL availability_table,
      to_regclass('attendant_availability_commands') IS NOT NULL command_table,
      has_function_privilege('zap_pronto_api','get_actor_unit_availability(uuid)','EXECUTE') read_api,
      has_function_privilege('zap_pronto_worker','get_actor_unit_availability(uuid)','EXECUTE') read_worker,
      has_function_privilege('zap_pronto_api','set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text)','EXECUTE') write_api,
      has_function_privilege('zap_pronto_app','set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text)','EXECUTE') write_app,
      has_function_privilege('zap_pronto_api','get_actor_unit_availability_v0051(uuid)','EXECUTE') internal_read_api,
      has_function_privilege('zap_pronto_api','set_actor_unit_availability_v0051(uuid,text,integer,text,timestamptz,integer,text,text)','EXECUTE') internal_write_api,
      pg_get_functiondef('get_actor_unit_availability(uuid)'::regprocedure) LIKE '%assert_app_context_authorized%' read_asserts_context,
      pg_get_functiondef('set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text)'::regprocedure)
        LIKE '%membership.status=''ACTIVE''%' write_reauthorizes,
      pg_get_functiondef('list_inbox_handoff_transfer_candidates(uuid)'::regprocedure)
        LIKE '%membership.role%' AND pg_get_functiondef('list_inbox_handoff_transfer_candidates(uuid)'::regprocedure)
        LIKE '%TENANT_ADMIN%' AND pg_get_functiondef('list_inbox_handoff_transfer_candidates(uuid)'::regprocedure)
        LIKE '%ATTENDANT%' transfer_role_filter,
      has_table_privilege('zap_pronto_api','attendant_unit_availability','SELECT') direct_select`);
    assert.deepEqual(availabilityUpgrade.rows[0],{availability_table:true,command_table:true,read_api:true,
      read_worker:false,write_api:true,write_app:false,internal_read_api:false,internal_write_api:false,
      read_asserts_context:true,write_reauthorizes:true,transfer_role_filter:true,direct_select:false});
    const slaAlertUpgrade=await verify.query(`SELECT
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='sla_alert.read' ORDER BY role_code) read_roles,
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='sla_alert.acknowledge' ORDER BY role_code) ack_roles,
      to_regclass('handoff_sla_acknowledgements') IS NOT NULL ack_table,
      to_regclass('handoff_sla_acknowledge_commands') IS NOT NULL command_table,
      has_function_privilege('zap_pronto_api','list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)','EXECUTE') list_api,
      has_function_privilege('zap_pronto_worker','list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)','EXECUTE') list_worker,
      has_function_privilege('zap_pronto_api','acknowledge_inbox_sla_alert(uuid,integer,text,text)','EXECUTE') ack_api,
      has_function_privilege('zap_pronto_worker','acknowledge_inbox_sla_alert(uuid,integer,text,text)','EXECUTE') ack_worker,
      has_function_privilege('zap_pronto_api','resolve_inbox_sla_alert_ack_unit(uuid,integer,text,text)','EXECUTE') resolver_api,
      has_function_privilege('zap_pronto_worker','resolve_inbox_sla_alert_ack_unit(uuid,integer,text,text)','EXECUTE') resolver_worker,
      has_function_privilege('zap_pronto_api','list_inbox_sla_alerts_v0053(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)','EXECUTE') internal_list_api,
      pg_get_functiondef('list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)'::regprocedure)
        LIKE '%handoff.version%' projects_handoff_version,
      has_table_privilege('zap_pronto_api','handoff_sla_acknowledgements','SELECT') direct_select,
      NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='handoff_sla_alerts') no_alert_table`);
    assert.deepEqual(slaAlertUpgrade.rows[0],{read_roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],
      ack_roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],ack_table:true,command_table:true,list_api:true,
      list_worker:false,ack_api:true,ack_worker:false,resolver_api:true,resolver_worker:false,internal_list_api:false,
      projects_handoff_version:true,direct_select:false,no_alert_table:true});
    const conversations = await verify.query(`SELECT count(*)::integer AS count,
      count(*) FILTER (WHERE status='OPEN')::integer AS open_count,
      count(*) FILTER (WHERE status='CLOSED')::integer AS closed_count FROM conversations`);
    assert.deepEqual(conversations.rows[0], { count: 3, open_count: 1, closed_count: 2 });
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
      (SELECT count(*)::integer FROM medical_orders) AS medical_count,
      (SELECT count(*)::integer FROM inbound_channel_events) AS inbound_count`);
    assert.deepEqual(newDomainRows.rows[0], { workflow_count: 0, quote_count: 0, medical_count: 0, inbound_count: 0 });
    await assert.rejects(verify.query(`INSERT INTO channel_connections
      (tenant_id,type,scope,external_account_id) VALUES
      ('10000000-0000-4000-8000-000000000001','WHATSAPP','SINGLE_UNIT','legacy-${suffix}')`),
    (error) => error instanceof Error && "code" in error && error.code === "23505");
    const inboundUpgrade = await verify.query(`SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='inbound_channel_events' AND column_name='unit_id') AS unit_nullable,
      to_regprocedure('resolve_inbound_channel_binding(text,text)') IS NOT NULL AS resolver_exists,
      to_regprocedure('persist_inbound_channel_event(text,text,text,text,text,timestamp with time zone,text,jsonb,text,text,uuid,uuid,text,text)') IS NOT NULL AS persistence_exists,
      has_function_privilege('zap_pronto_api','resolve_inbound_channel_binding(text,text)','EXECUTE') AS api_resolve,
      has_function_privilege('zap_pronto_worker','resolve_inbound_channel_binding(text,text)','EXECUTE') AS worker_resolve,
      has_table_privilege('zap_pronto_worker','inbound_channel_events','SELECT') AS worker_select_receipts,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='messages'
        AND column_name='source_inbound_event_id') AS message_source_nullable,
      to_regprocedure('materialize_inbound_channel_event(uuid,uuid)') IS NOT NULL AS materializer_exists,
      has_function_privilege('zap_pronto_worker','materialize_inbound_channel_event(uuid,uuid)','EXECUTE') AS worker_materialize,
      has_function_privilege('zap_pronto_api','materialize_inbound_channel_event(uuid,uuid)','EXECUTE') AS api_materialize,
      to_regprocedure('claim_inbound_materialization_events(integer,integer)') IS NOT NULL AS worker_claim_exists,
      has_function_privilege('zap_pronto_worker','claim_inbound_materialization_events(integer,integer)','EXECUTE') AS worker_claim,
      has_function_privilege('zap_pronto_api','claim_inbound_materialization_events(integer,integer)','EXECUTE') AS api_claim,
      to_regprocedure('list_inbound_routing_required(integer,timestamptz,uuid)') IS NOT NULL AS routing_list_exists,
      to_regprocedure('resolve_inbound_routing_required(uuid,uuid,text,text)') IS NOT NULL AS routing_resolve_exists,
      has_table_privilege('zap_pronto_api','inbound_routing_commands','SELECT') AS routing_commands_select,
      has_table_privilege('zap_pronto_worker','messages','SELECT') AS worker_message_select,
      has_function_privilege('zap_pronto_api','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') AS api_handoff_resolve,
      has_function_privilege('zap_pronto_worker','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') AS worker_handoff_resolve,
      has_function_privilege('zap_pronto_api','resolve_inbox_handoff_legacy_v0027(uuid,integer,text,text)','EXECUTE') AS legacy_api_handoff_resolve,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='handoff_resolve_commands' AND column_name='disposition') AS resolve_disposition_nullable,
      has_table_privilege('zap_pronto_api','handoff_resolve_commands','SELECT') AS resolve_commands_select`);
    assert.deepEqual(inboundUpgrade.rows[0], {
      unit_nullable: "YES", resolver_exists: true, persistence_exists: true,
      api_resolve: true, worker_resolve: false, worker_select_receipts: false,
      message_source_nullable:"YES",materializer_exists:true,worker_materialize:true,api_materialize:false,
      worker_claim_exists:true,worker_claim:true,api_claim:false,
      routing_list_exists:true,routing_resolve_exists:true,routing_commands_select:false,
      worker_message_select:false,api_handoff_resolve:true,worker_handoff_resolve:false,legacy_api_handoff_resolve:false,
      resolve_disposition_nullable:"NO",resolve_commands_select:false,
    });
    const outboundUpgrade=await verify.query(`SELECT
      to_regprocedure('claim_outbound_delivery_events(integer,integer)') IS NOT NULL claim_exists,
      to_regprocedure('finalize_outbound_delivery_event(uuid,uuid,text)') IS NOT NULL finalize_exists,
      to_regprocedure('fail_outbound_delivery_event(uuid,uuid,text,integer)') IS NOT NULL fail_exists,
      has_function_privilege('zap_pronto_worker','claim_outbound_delivery_events(integer,integer)','EXECUTE') worker_claim,
      has_function_privilege('zap_pronto_api','claim_outbound_delivery_events(integer,integer)','EXECUTE') api_claim,
      has_function_privilege('zap_pronto_worker','finalize_outbound_delivery_event(uuid,uuid,text)','EXECUTE') worker_finalize,
      has_function_privilege('zap_pronto_api','finalize_outbound_delivery_event(uuid,uuid,text)','EXECUTE') api_finalize`);
    assert.deepEqual(outboundUpgrade.rows[0],{claim_exists:true,finalize_exists:true,fail_exists:true,
      worker_claim:true,api_claim:false,worker_finalize:true,api_finalize:false});
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
      role_count: 5, permission_count: 23, provider_count: 0, identity_count: 0, membership_count: 1,
      normalized_email: `legacy-${suffix}@test.local`, generated_email: `legacy-${suffix}@test.local`, user_version: 1,
      permission_policy_exists: true,
    });
    const unitMembershipCatalogUpgrade=await verify.query(`SELECT
      to_regprocedure('admin_list_unit_memberships(uuid,text,uuid,integer)') IS NOT NULL function_exists,
      has_function_privilege('zap_pronto_api','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') worker_execute,
      has_function_privilege('zap_pronto_app','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') app_execute,
      NOT EXISTS(SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_name='admin_list_unit_memberships' AND grantee='PUBLIC') public_revoked`);
    assert.deepEqual(unitMembershipCatalogUpgrade.rows[0],{
      function_exists:true,api_execute:true,worker_execute:false,app_execute:false,public_revoked:true,
    });
    const assignmentSerializationUpgrade=await verify.query(`SELECT
      pg_get_functiondef('enforce_active_human_assignee()'::regprocedure) LIKE '%:membership-lifecycle%' serialized,
      to_regprocedure('transfer_inbox_handoff_reason_v0040(uuid,integer,uuid,text,text,text)') IS NOT NULL internal_exists,
      has_function_privilege('zap_pronto_api','transfer_inbox_handoff_reason_v0040(uuid,integer,uuid,text,text,text)','EXECUTE') internal_api,
      has_function_privilege('zap_pronto_api','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') canonical_api,
      pg_get_functiondef('resolve_inbox_handoff_transfer_unit(uuid,integer,uuid,text,text,text)'::regprocedure)
        LIKE '%reason<>''LEGACY_UNSPECIFIED''%' legacy_scope_closed`);
    assert.deepEqual(assignmentSerializationUpgrade.rows[0],{
      serialized:true,internal_exists:true,internal_api:false,canonical_api:true,legacy_scope_closed:true,
    });
    const replayAuthorizationUpgrade=await verify.query(`SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='handoff_resolve_commands' AND column_name='unit_id') resolve_unit_nullable,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
        AND table_name='handoff_requeue_commands' AND column_name='unit_id') requeue_unit_nullable,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='handoff_resolve_commands'::regclass
        AND conname='handoff_resolve_commands_unit_fk') resolve_unit_fk,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='handoff_requeue_commands'::regclass
        AND conname='handoff_requeue_commands_unit_fk') requeue_unit_fk,
      has_function_privilege('zap_pronto_api','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') resolve_api,
      has_function_privilege('zap_pronto_api','resolve_inbox_handoff_disposition_v0042(uuid,integer,text,text,text)','EXECUTE') resolve_internal_api,
      has_function_privilege('zap_pronto_api','requeue_inbox_handoff(uuid,integer,text)','EXECUTE') requeue_api,
      has_function_privilege('zap_pronto_api','requeue_inbox_handoff_v0030(uuid,integer,text)','EXECUTE') requeue_internal_api,
      pg_get_functiondef('resolve_inbox_handoff(uuid,integer,text,text,text)'::regprocedure)
        LIKE '%current_actor_has_permission(''handoff.resolve'',command_unit_id)%' resolve_reauthorizes,
      pg_get_functiondef('requeue_inbox_handoff(uuid,integer,text)'::regprocedure)
        LIKE '%current_actor_has_permission(''handoff.requeue'',command_unit_id)%' requeue_reauthorizes`);
    assert.deepEqual(replayAuthorizationUpgrade.rows[0],{
      resolve_unit_nullable:"NO",requeue_unit_nullable:"NO",resolve_unit_fk:true,requeue_unit_fk:true,
      resolve_api:true,resolve_internal_api:false,requeue_api:true,requeue_internal_api:false,
      resolve_reauthorizes:true,requeue_reauthorizes:true,
    });
    const resolvedHistoryUpgrade=await verify.query(`SELECT
      EXISTS(SELECT 1 FROM app_permissions WHERE code='handoff.history.read') permission_exists,
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='handoff.history.read' ORDER BY role_code) roles,
      has_function_privilege('zap_pronto_api','list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)','EXECUTE') worker_execute,
      pg_get_functiondef('list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)'::regprocedure)
        LIKE '%handoff.status=''RESOLVED''%' resolved_only,
      pg_get_functiondef('list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)'::regprocedure)
        LIKE '%actor.tenant_id=handoff.tenant_id%' actor_tenant_join`);
    assert.deepEqual(resolvedHistoryUpgrade.rows[0],{permission_exists:true,
      roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],api_execute:false,worker_execute:false,resolved_only:true,actor_tenant_join:true});
    const filteredResolvedHistoryUpgrade=await verify.query(`SELECT
      to_regprocedure('list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)') IS NOT NULL function_exists,
      has_function_privilege('zap_pronto_api','list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') worker_execute,
      has_function_privilege('zap_pronto_app','list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') app_execute,
      EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='handoff_resolve_commands_history_lookup_idx') lookup_index,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure)
        LIKE '%current_actor_has_permission(''handoff.history.read'',requested_unit_id)%' reauthorizes,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure)
        LIKE '%requested_before-requested_from>interval ''366 days''%' bounded_window,
      has_function_privilege('zap_pronto_api','list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') legacy_api_execute,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure)
        LIKE '%newer.status=''RESOLVED''%' latest_only`);
    assert.deepEqual(filteredResolvedHistoryUpgrade.rows[0],{function_exists:true,api_execute:true,worker_execute:false,
      app_execute:false,lookup_index:true,reauthorizes:true,bounded_window:true,legacy_api_execute:false,latest_only:true});
    const historyTimelineUpgrade=await verify.query(`SELECT
      has_function_privilege('zap_pronto_api','list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)','EXECUTE') worker_execute,
      pg_get_functiondef('list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)'::regprocedure)
        LIKE '%message.created_at<=effective_before%' cutoff_in_function,
      pg_get_functiondef('list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)'::regprocedure)
        LIKE '%LEAST(COALESCE(requested_before%detail.closed_at)%' caps_at_closed,
      pg_get_functiondef('list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)'::regprocedure)
        LIKE '%detail.status=''CLOSED''%detail.closed_at IS NULL%' rejects_invalid_closed`);
    assert.deepEqual(historyTimelineUpgrade.rows[0],{api_execute:true,worker_execute:false,cutoff_in_function:true,
      caps_at_closed:true,rejects_invalid_closed:true});
    const closedConversationAuthorizationUpgrade=await verify.query(`SELECT
      has_function_privilege('zap_pronto_api','get_inbox_conversation(uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','get_inbox_conversation(uuid)','EXECUTE') worker_execute,
      has_function_privilege('zap_pronto_app','get_inbox_conversation(uuid)','EXECUTE') app_execute,
      function.prosecdef,function.proconfig,
      pg_get_functiondef(function.oid)
        LIKE '%c.status=''CLOSED'' AND NOT public.current_actor_has_permission(''handoff.history.read'',c.unit_id)%' closed_reauthorized
      FROM pg_proc function WHERE function.oid='get_inbox_conversation(uuid)'::regprocedure`);
    assert.deepEqual(closedConversationAuthorizationUpgrade.rows[0],{api_execute:true,worker_execute:false,
      app_execute:false,prosecdef:true,proconfig:["search_path=pg_catalog, public","row_security=off"],
      closed_reauthorized:true});
  } finally {
    await verify.end();
  }

  assert.equal(await runMigrator(), "");
  process.stdout.write("legacy upgrade: passed\n");
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
