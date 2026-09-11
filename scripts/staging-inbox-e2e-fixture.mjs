import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MAX_DATABASE_URL_BYTES = 4096;
const MAX_CONFIG_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RUN_KEY = /^[0-9]{1,20}-[1-9][0-9]{0,5}$/;
const ACTIONS = new Set(["prepare", "verify", "cleanup"]);
const CONFIG_KEYS = Object.freeze(["tenantId", "unitId", "attendantUserId"]);
const LOCK_NAMESPACE = "zap-pronto:staging-inbox-e2e";

function requiredUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${name}_INVALID`);
  return value.toLowerCase();
}

export function validateFixtureConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("FIXTURE_CONFIG_INVALID");
  const keys = Object.keys(input).sort();
  if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== [...CONFIG_KEYS].sort()[index])) {
    throw new Error("FIXTURE_CONFIG_KEYS_INVALID");
  }
  const tenantId = requiredUuid(input.tenantId, "TENANT_ID");
  const unitId = requiredUuid(input.unitId, "UNIT_ID");
  const attendantUserId = requiredUuid(input.attendantUserId, "ATTENDANT_USER_ID");
  if (new Set([tenantId, unitId, attendantUserId]).size !== 3) throw new Error("FIXTURE_IDS_NOT_DISTINCT");
  return Object.freeze({ tenantId, unitId, attendantUserId });
}

export function validateRunKey(value) {
  if (typeof value !== "string" || !RUN_KEY.test(value)) throw new Error("FIXTURE_RUN_KEY_INVALID");
  return value;
}

export function deterministicUuid(runKey, entity) {
  const bytes = Buffer.from(createHash("sha256").update(`${LOCK_NAMESPACE}:${validateRunKey(runKey)}:${entity}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function fixtureFor(runKey) {
  const key = validateRunKey(runKey);
  return Object.freeze({
    runKey: key,
    connectionId: deterministicUuid(key, "connection"),
    contactId: deterministicUuid(key, "contact"),
    contactIdentityId: deterministicUuid(key, "contact-identity"),
    conversationId: deterministicUuid(key, "conversation"),
    messageId: deterministicUuid(key, "message"),
    serviceCaseId: deterministicUuid(key, "service-case"),
    handoffId: deterministicUuid(key, "handoff"),
    contactName: `E2E Inbox ${key}`,
    messageBody: `Homologação externa Inbox ${key}`,
    externalAccountId: `staging-e2e-inbox-${key}`,
    externalUserId: `staging-e2e-customer-${key}`,
    externalMessageId: `staging-e2e-inbound-${key}`,
    handoffIdempotencyKey: `staging-e2e-handoff-${key}`,
  });
}

async function privateRegularFile(path, maximum, allowedUids) {
  let metadata;
  try { metadata = await lstat(path); } catch { throw new Error("FIXTURE_FILE_UNREADABLE"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) {
    throw new Error("FIXTURE_FILE_UNSAFE");
  }
  if (process.platform === "linux"
    && ((metadata.mode & 0o777) !== 0o400 || !allowedUids.includes(metadata.uid))) {
    throw new Error("FIXTURE_FILE_PERMISSIONS_INVALID");
  }
  return readFile(path, "utf8");
}

function postgresOwnerUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("DATABASE_URL_INVALID"); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)
    || decodeURIComponent(parsed.username) !== "zap_pronto_owner" || !parsed.password) {
    throw new Error("DATABASE_URL_INVALID");
  }
  return raw;
}

export async function loadFixtureInputs(env = process.env) {
  const databasePath = env.DATABASE_URL_FILE?.trim();
  const configPath = env.INBOX_E2E_CONFIG_FILE?.trim();
  if (!databasePath) throw new Error("DATABASE_URL_FILE_REQUIRED");
  if (!configPath) throw new Error("INBOX_E2E_CONFIG_FILE_REQUIRED");
  const uid = process.getuid?.();
  const localOwnerUids = [0, uid].filter(Number.isInteger);
  const [databaseRaw, configRaw] = await Promise.all([
    privateRegularFile(databasePath, MAX_DATABASE_URL_BYTES, [0, 1000, uid].filter(Number.isInteger)),
    privateRegularFile(configPath, MAX_CONFIG_BYTES, localOwnerUids),
  ]);
  let config;
  try { config = JSON.parse(configRaw); } catch { throw new Error("FIXTURE_CONFIG_INVALID"); }
  return { databaseUrl: postgresOwnerUrl(databaseRaw.trim()), config: validateFixtureConfig(config) };
}

async function assertTarget(client, config) {
  const target = await client.query(`SELECT
    EXISTS(SELECT 1 FROM tenants WHERE id=$1::uuid AND status='ACTIVE') tenant_exists,
    EXISTS(SELECT 1 FROM units WHERE tenant_id=$1::uuid AND id=$2::uuid AND active=true) unit_exists`,
  [config.tenantId, config.unitId]);
  if (target.rowCount !== 1 || target.rows[0]?.tenant_exists !== true || target.rows[0]?.unit_exists !== true) {
    throw new Error("FIXTURE_TARGET_NOT_FOUND");
  }
}

async function assertAttendantReady(client, config, fixture) {
  const readiness = await client.query(`SELECT
    EXISTS(SELECT 1 FROM users account WHERE account.tenant_id=$1 AND account.id=$3
      AND account.status='ACTIVE') actor_active,
    EXISTS(SELECT 1 FROM user_units membership WHERE membership.tenant_id=$1 AND membership.unit_id=$2
      AND membership.user_id=$3 AND membership.role='ATTENDANT' AND membership.status='ACTIVE') membership_active,
    EXISTS(SELECT 1 FROM unit_assignment_policies policy WHERE policy.tenant_id=$1 AND policy.unit_id=$2
      AND policy.mode='OBSERVE') policy_observe,
    EXISTS(SELECT 1 FROM attendant_unit_availability availability
      WHERE availability.tenant_id=$1 AND availability.unit_id=$2 AND availability.user_id=$3
        AND availability.status='OFFLINE' AND
          (SELECT count(*) FROM human_handoffs active WHERE active.tenant_id=$1 AND active.unit_id=$2
            AND active.assigned_user_id=$3 AND active.status='ACTIVE' AND active.id<>$4)<availability.max_active) capacity_available,
    NOT EXISTS(SELECT 1 FROM human_handoffs active WHERE active.tenant_id=$1 AND active.assigned_user_id=$3
      AND active.status='ACTIVE' AND active.id<>$4) no_active_work`,
  [config.tenantId, config.unitId, config.attendantUserId, fixture.handoffId]);
  const row = readiness.rows[0];
  if (readiness.rowCount !== 1 || row?.actor_active !== true || row.membership_active !== true
    || row.policy_observe !== true || row.capacity_available !== true || row.no_active_work !== true) {
    throw new Error("FIXTURE_ATTENDANT_NOT_READY");
  }
}

async function assertFixtureCleanupSafe(client, config, fixture) {
  const handoff = await client.query(`SELECT status,assigned_user_id FROM human_handoffs
    WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [config.tenantId, fixture.handoffId]);
  const conversation = await client.query(`SELECT assigned_user_id FROM conversations
    WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [config.tenantId, fixture.conversationId]);
  const forbiddenCommands = await client.query(`SELECT
    EXISTS(SELECT 1 FROM handoff_transfer_commands WHERE tenant_id=$1 AND handoff_id=$2) transfer_exists,
    EXISTS(SELECT 1 FROM handoff_takeover_commands WHERE tenant_id=$1 AND handoff_id=$2) takeover_exists`,
  [config.tenantId, fixture.handoffId]);
  const handoffRow = handoff.rows[0], conversationRow = conversation.rows[0], commandRow = forbiddenCommands.rows[0];
  if (handoff.rowCount > 1 || conversation.rowCount > 1
    || handoffRow?.status === "ACTIVE" || handoffRow?.assigned_user_id != null
    || conversationRow?.assigned_user_id != null || forbiddenCommands.rowCount !== 1
    || commandRow?.transfer_exists !== false || commandRow.takeover_exists !== false) {
    throw new Error("FIXTURE_CLEANUP_ACTIVE_WORK_CONFLICT");
  }
}

async function deleteFixtureRows(client, config, fixture) {
  await assertFixtureCleanupSafe(client, config, fixture);
  const handoff = [config.tenantId, fixture.handoffId];
  const aggregateIds = [config.tenantId, fixture.handoffId, fixture.serviceCaseId, fixture.conversationId];
  const entityIds = [...aggregateIds, fixture.messageId];
  await client.query("DELETE FROM handoff_sla_acknowledge_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_sla_acknowledgements WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_claim_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_resolve_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_requeue_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_transfer_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_takeover_commands WHERE tenant_id=$1 AND handoff_id=$2", handoff);
  await client.query("DELETE FROM handoff_reopen_commands WHERE tenant_id=$1 AND (source_handoff_id=$2 OR result_handoff_id=$2)", handoff);
  await client.query("DELETE FROM human_text_message_cancel_commands WHERE tenant_id=$1 AND conversation_id=$2",
    [config.tenantId, fixture.conversationId]);
  await client.query("DELETE FROM human_text_message_commands WHERE tenant_id=$1 AND conversation_id=$2",
    [config.tenantId, fixture.conversationId]);
  await client.query(`DELETE FROM message_attachments attachment WHERE attachment.tenant_id=$1
    AND attachment.message_id IN (SELECT id FROM messages WHERE tenant_id=$1 AND conversation_id=$2)`,
  [config.tenantId, fixture.conversationId]);
  await client.query(`DELETE FROM meta_delivery_status_applications application WHERE application.tenant_id=$1
    AND application.receipt_id IN (SELECT id FROM meta_delivery_status_receipts
      WHERE tenant_id=$1 AND channel_connection_id=$2)`, [config.tenantId, fixture.connectionId]);
  await client.query(`DELETE FROM audit_events event WHERE event.tenant_id=$1 AND event.entity_id IN
    (SELECT id::text FROM meta_delivery_status_receipts WHERE tenant_id=$1 AND channel_connection_id=$2)`,
  [config.tenantId, fixture.connectionId]);
  await client.query("DELETE FROM meta_delivery_status_receipts WHERE tenant_id=$1 AND channel_connection_id=$2",
    [config.tenantId, fixture.connectionId]);
  await client.query(`DELETE FROM outbox_events event WHERE event.tenant_id=$1 AND event.aggregate_id IN
    (SELECT id FROM inbound_channel_events WHERE tenant_id=$1 AND channel_connection_id=$2)`,
  [config.tenantId, fixture.connectionId]);
  await client.query("DELETE FROM workflow_transitions WHERE tenant_id=$1 AND aggregate_id IN ($2,$3,$4)", aggregateIds);
  await client.query("DELETE FROM audit_events WHERE tenant_id=$1 AND entity_id IN ($2::text,$3::text,$4::text,$5::text)", entityIds);
  await client.query("DELETE FROM outbox_events WHERE tenant_id=$1 AND aggregate_id IN ($2,$3,$4,$5)", entityIds);
  await client.query("DELETE FROM human_handoffs WHERE tenant_id=$1 AND id=$2", handoff);
  await client.query("DELETE FROM service_cases WHERE tenant_id=$1 AND id=$2", [config.tenantId, fixture.serviceCaseId]);
  await client.query("DELETE FROM messages WHERE tenant_id=$1 AND conversation_id=$2", [config.tenantId, fixture.conversationId]);
  await client.query("DELETE FROM inbound_channel_events WHERE tenant_id=$1 AND channel_connection_id=$2",
    [config.tenantId, fixture.connectionId]);
  await client.query("DELETE FROM conversations WHERE tenant_id=$1 AND id=$2", [config.tenantId, fixture.conversationId]);
  await client.query("DELETE FROM contact_identities WHERE tenant_id=$1 AND id=$2", [config.tenantId, fixture.contactIdentityId]);
  await client.query("DELETE FROM contacts WHERE tenant_id=$1 AND id=$2", [config.tenantId, fixture.contactId]);
  await client.query("DELETE FROM channel_connection_units WHERE tenant_id=$1 AND channel_connection_id=$2",
    [config.tenantId, fixture.connectionId]);
  await client.query("DELETE FROM channel_connections WHERE tenant_id=$1 AND id=$2", [config.tenantId, fixture.connectionId]);
}

export async function prepareFixture(client, config, fixture) {
  await assertTarget(client, config);
  await deleteFixtureRows(client, config, fixture);
  await assertAttendantReady(client, config, fixture);
  await client.query(`INSERT INTO channel_connections
    (id,tenant_id,type,scope,external_account_id,status,secret_reference,display_name)
    VALUES($2,$1,'WHATSAPP','CORPORATE',$3,'DISCONNECTED',NULL,$4)`,
  [config.tenantId, fixture.connectionId, fixture.externalAccountId, fixture.contactName]);
  await client.query("INSERT INTO channel_connection_units(tenant_id,channel_connection_id,unit_id) VALUES($1,$2,$3)",
    [config.tenantId, fixture.connectionId, config.unitId]);
  await client.query("INSERT INTO contacts(id,tenant_id,display_name) VALUES($2,$1,$3)",
    [config.tenantId, fixture.contactId, fixture.contactName]);
  await client.query(`INSERT INTO contact_identities(id,tenant_id,contact_id,channel_connection_id,external_user_id)
    VALUES($2,$1,$3,$4,$5)`, [config.tenantId, fixture.contactIdentityId, fixture.contactId,
    fixture.connectionId, fixture.externalUserId]);
  await client.query(`INSERT INTO conversations(id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,
    status,automation_status,assigned_user_id,version) VALUES($2,$1,$3,$4,$5,$6,'OPEN','HUMAN_QUEUED',NULL,1)`,
  [config.tenantId, fixture.conversationId, fixture.connectionId, fixture.contactId, fixture.contactIdentityId, config.unitId]);
  await client.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload)
    VALUES($2,$1,$3,'INBOUND','CUSTOMER',$4,$5,jsonb_build_object('kind','TEXT','fixture',true,'runKey',$6::text))`,
  [config.tenantId, fixture.messageId, fixture.conversationId, fixture.externalMessageId, fixture.messageBody, fixture.runKey]);
  await client.query(`INSERT INTO service_cases(id,tenant_id,conversation_id,unit_id,kind,status,collected_data,version)
    VALUES($2,$1,$3,$4,'EXTERNAL_E2E','WAITING_HUMAN','{}'::jsonb,1)`,
  [config.tenantId, fixture.serviceCaseId, fixture.conversationId, config.unitId]);
  await client.query(`INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,
    assigned_user_id,idempotency_key,queued_at,version) VALUES($2,$1,$3,$4,$5,'EXTERNAL_E2E','NORMAL','QUEUED',NULL,$6,clock_timestamp(),1)`,
  [config.tenantId, fixture.handoffId, fixture.conversationId, fixture.serviceCaseId, config.unitId, fixture.handoffIdempotencyKey]);
  return verifyFixture(client, config, fixture, false);
}

export async function verifyFixture(client, config, fixture, journeyCompleted = true) {
  const result = await client.query(`SELECT
    (SELECT type::text FROM channel_connections WHERE tenant_id=$1 AND id=$3) connection_type,
    (SELECT scope FROM channel_connections WHERE tenant_id=$1 AND id=$3) connection_scope,
    (SELECT status FROM channel_connections WHERE tenant_id=$1 AND id=$3) connection_status,
    (SELECT secret_reference FROM channel_connections WHERE tenant_id=$1 AND id=$3) secret_reference,
    (SELECT display_name FROM contacts WHERE tenant_id=$1 AND id=$4) contact_name,
    (SELECT status::text FROM conversations WHERE tenant_id=$1 AND id=$5) conversation_status,
    (SELECT automation_status::text FROM conversations WHERE tenant_id=$1 AND id=$5) automation_status,
    (SELECT assigned_user_id FROM conversations WHERE tenant_id=$1 AND id=$5) conversation_assignee,
    (SELECT status::text FROM service_cases WHERE tenant_id=$1 AND id=$6) service_case_status,
    (SELECT status::text FROM human_handoffs WHERE tenant_id=$1 AND id=$7) handoff_status,
    (SELECT assigned_user_id FROM human_handoffs WHERE tenant_id=$1 AND id=$7) handoff_assignee,
    (SELECT version FROM conversations WHERE tenant_id=$1 AND id=$5) conversation_version,
    (SELECT version FROM service_cases WHERE tenant_id=$1 AND id=$6) service_case_version,
    (SELECT version FROM human_handoffs WHERE tenant_id=$1 AND id=$7) handoff_version,
    (SELECT status::text FROM attendant_unit_availability WHERE tenant_id=$1 AND unit_id=$2
      AND user_id=$10) attendant_availability_status,
    (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND conversation_id=$5 AND direction='INBOUND'
      AND actor='CUSTOMER' AND id=$8 AND body=$9) inbound_count,
    (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND conversation_id=$5 AND direction='OUTBOUND') outbound_count,
    (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND conversation_id=$5 AND actor='HERMES') hermes_count,
    (SELECT count(*)::int FROM handoff_claim_commands WHERE tenant_id=$1 AND handoff_id=$7 AND actor_id=$10
      AND conversation_id=$5 AND service_case_id=$6 AND expected_version=1 AND result_version=2
      AND result_assigned_user_id=$10 AND result_automation_status='HUMAN_ACTIVE') claim_count,
    (SELECT count(*)::int FROM handoff_requeue_commands WHERE tenant_id=$1 AND handoff_id=$7 AND actor_id=$10
      AND conversation_id=$5 AND service_case_id=$6 AND expected_version=2 AND result_handoff_version=3
      AND result_conversation_version=3 AND result_service_case_version=3) requeue_count,
    (SELECT count(*)::int FROM handoff_claim_commands claimed JOIN handoff_requeue_commands requeued
      ON requeued.tenant_id=claimed.tenant_id AND requeued.handoff_id=claimed.handoff_id
      AND requeued.actor_id=claimed.actor_id WHERE claimed.tenant_id=$1 AND claimed.handoff_id=$7
        AND claimed.actor_id=$10) same_actor_journey_count,
    (SELECT count(*)::int FROM meta_delivery_status_receipts WHERE tenant_id=$1 AND channel_connection_id=$3) meta_receipt_count,
    (SELECT count(*)::int FROM inbound_channel_events WHERE tenant_id=$1 AND channel_connection_id=$3) meta_inbound_event_count,
    (SELECT count(*)::int FROM outbox_events event WHERE event.tenant_id=$1
      AND event.aggregate_id IN ($3,$5,$6,$7,$8)
      AND (event.event_type LIKE 'channel.outbound.%' OR event.event_type LIKE 'meta.%'
        OR event.event_type LIKE 'hermes.%')) forbidden_outbox_count,
    (SELECT count(*)::int FROM audit_events event WHERE event.tenant_id=$1
      AND event.entity_id IN ($3::text,$5::text,$6::text,$7::text,$8::text)
      AND (event.action LIKE 'META_%' OR event.action LIKE '%OUTBOUND%' OR event.action LIKE 'HERMES_%'
        OR event.actor_type='HERMES')) forbidden_audit_count,
    EXISTS(SELECT 1 FROM channel_connection_units WHERE tenant_id=$1 AND channel_connection_id=$3 AND unit_id=$2) unit_linked`,
  [config.tenantId, config.unitId, fixture.connectionId, fixture.contactId, fixture.conversationId,
    fixture.serviceCaseId, fixture.handoffId, fixture.messageId, fixture.messageBody, config.attendantUserId]);
  const row = result.rows[0];
  const expectedVersion = journeyCompleted ? 3 : 1;
  const expectedCommandCount = journeyCompleted ? 1 : 0;
  if (result.rowCount !== 1 || row?.connection_type !== "WHATSAPP" || row.connection_scope !== "CORPORATE"
    || row.connection_status !== "DISCONNECTED" || row.secret_reference !== null || row.unit_linked !== true
    || row.contact_name !== fixture.contactName || row.conversation_status !== "OPEN"
    || row.automation_status !== "HUMAN_QUEUED" || row.conversation_assignee !== null
    || row.service_case_status !== "WAITING_HUMAN" || row.handoff_status !== "QUEUED"
    || row.handoff_assignee !== null || row.conversation_version !== expectedVersion
    || row.service_case_version !== expectedVersion || row.handoff_version !== expectedVersion
    || row.attendant_availability_status !== "OFFLINE"
    || row.inbound_count !== 1 || row.outbound_count !== 0 || row.hermes_count !== 0
    || row.claim_count !== expectedCommandCount || row.requeue_count !== expectedCommandCount
    || row.same_actor_journey_count !== expectedCommandCount
    || row.meta_receipt_count !== 0 || row.meta_inbound_event_count !== 0
    || row.forbidden_outbox_count !== 0 || row.forbidden_audit_count !== 0) {
    throw new Error("FIXTURE_STATE_INVALID");
  }
  return fixtureResult(config, fixture);
}

export async function cleanupFixture(client, config, fixture) {
  await assertTarget(client, config);
  await deleteFixtureRows(client, config, fixture);
  const result = await client.query(`SELECT
    (SELECT count(*) FROM channel_connections WHERE tenant_id=$1 AND id=$2)
    +(SELECT count(*) FROM contacts WHERE tenant_id=$1 AND id=$3)
    +(SELECT count(*) FROM conversations WHERE tenant_id=$1 AND id=$4)
    +(SELECT count(*) FROM service_cases WHERE tenant_id=$1 AND id=$5)
    +(SELECT count(*) FROM human_handoffs WHERE tenant_id=$1 AND id=$6) remaining`,
  [config.tenantId, fixture.connectionId, fixture.contactId, fixture.conversationId, fixture.serviceCaseId, fixture.handoffId]);
  if (result.rowCount !== 1 || Number(result.rows[0]?.remaining) !== 0) throw new Error("FIXTURE_CLEANUP_INCOMPLETE");
  return fixtureResult(config, fixture);
}

function fixtureResult() {
  return Object.freeze({ status: "ok" });
}

export async function runFixtureAction(action, runKey, inputs, Client = pg.Client) {
  if (!ACTIONS.has(action)) throw new Error("FIXTURE_ACTION_INVALID");
  const fixture = fixtureFor(runKey);
  const client = new Client({ connectionString: inputs.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [`${LOCK_NAMESPACE}:${runKey}`]);
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.correlation_id',$2,true)",
      [inputs.config.tenantId, `staging-inbox-e2e:${runKey}`]);
    const result = action === "prepare" ? await prepareFixture(client, inputs.config, fixture)
      : action === "verify" ? await verifyFixture(client, inputs.config, fixture)
        : await cleanupFixture(client, inputs.config, fixture);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

async function main() {
  const match = process.argv.slice(2);
  if (match.length !== 2 || !/^--(?:prepare|verify|cleanup)$/.test(match[0])) {
    process.stderr.write("Usage (staging admin container only): node scripts/staging-inbox-e2e-fixture.mjs --prepare|--verify|--cleanup RUN_ID-RUN_ATTEMPT\n");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runFixtureAction(match[0].slice(2), match[1], await loadFixtureInputs());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("STAGING_INBOX_E2E_FIXTURE_FAILED\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
