import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deterministicUuid, fixtureFor, loadFixtureInputs, runFixtureAction, validateFixtureConfig,
  validateRunKey } from "./staging-inbox-e2e-fixture.mjs";

const config = Object.freeze({
  tenantId: "10000000-0000-4000-8000-000000000001",
  unitId: "20000000-0000-4000-8000-000000000001",
  attendantUserId: "30000000-0000-4000-8000-000000000001",
});

test("validates the external run key and derives stable, distinct UUID v4 identifiers", () => {
  assert.equal(validateRunKey("34569418102-1"), "34569418102-1");
  for (const invalid of ["", "run-1", "1-0", "1-01", "1-1 extra", "1-1;id", "1-1000000"]) {
    assert.throws(() => validateRunKey(invalid), /RUN_KEY_INVALID/);
  }
  const fixture = fixtureFor("34569418102-1");
  const ids = [fixture.connectionId, fixture.contactId, fixture.contactIdentityId, fixture.conversationId,
    fixture.messageId, fixture.serviceCaseId, fixture.handoffId];
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id) && id[14] === "4" && /[89ab]/.test(id[19])));
  assert.equal(deterministicUuid("34569418102-1", "conversation"), fixture.conversationId);
  assert.equal(fixture.contactName, "E2E Inbox 34569418102-1");
  assert.equal(fixture.messageBody, "Homologação externa Inbox 34569418102-1");
});

test("configuration permits only one existing tenant/unit/dedicated-attendant tuple", () => {
  assert.deepEqual(validateFixtureConfig(config), config);
  assert.throws(() => validateFixtureConfig({ ...config, secret: "never" }), /KEYS_INVALID/);
  assert.throws(() => validateFixtureConfig({ ...config, unitId: config.tenantId }), /NOT_DISTINCT/);
  assert.throws(() => validateFixtureConfig({ tenantId:config.tenantId, unitId:config.unitId }), /KEYS_INVALID/);
  assert.throws(() => validateFixtureConfig({ ...config, attendantUserId:"not-a-uuid" }), /ATTENDANT_USER_ID_INVALID/);
});

test("private inputs require the owner database URL and never accept runtime credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-inbox-fixture-"));
  const database = join(directory, "database-url");
  const fixtureConfig = join(directory, "config.json");
  await writeFile(database, "postgresql://zap_pronto_owner:private@postgres/zap_pronto\n", { mode: 0o400 });
  await writeFile(fixtureConfig, JSON.stringify(config), { mode: 0o400 });
  await chmod(database, 0o400);
  await chmod(fixtureConfig, 0o400);
  const loaded = await loadFixtureInputs({ DATABASE_URL_FILE: database, INBOX_E2E_CONFIG_FILE: fixtureConfig });
  assert.equal(loaded.config.tenantId, config.tenantId);
  await chmod(database, 0o600);
  await writeFile(database, "postgresql://zap_pronto_runtime:private@postgres/zap_pronto\n", { mode: 0o400 });
  await chmod(database, 0o400);
  await assert.rejects(loadFixtureInputs({ DATABASE_URL_FILE: database, INBOX_E2E_CONFIG_FILE: fixtureConfig }), /DATABASE_URL_INVALID/);
  if (process.platform === "linux") {
    await chmod(database, 0o600);
    await writeFile(database, "postgresql://zap_pronto_owner:private@postgres/zap_pronto\n");
    await chmod(database, 0o400);
    await chmod(fixtureConfig, 0o600);
    await assert.rejects(loadFixtureInputs({ DATABASE_URL_FILE: database, INBOX_E2E_CONFIG_FILE: fixtureConfig }), /FIXTURE_FILE_PERMISSIONS_INVALID/);
  }
});

test("prepare is transactional, parameterized and verifies zero outbound or Hermes messages", async () => {
  const calls = [];
  class FakeClient {
    async connect() { calls.push(["CONNECT"]); }
    async query(text, values) {
      calls.push([text, values]);
      if (text.includes("tenant_exists")) return { rowCount: 1, rows: [{ tenant_exists: true, unit_exists: true }] };
      if (text.includes("FROM human_handoffs") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("FROM conversations") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("transfer_exists")) return { rowCount:1, rows:[{ transfer_exists:false, takeover_exists:false }] };
      if (text.includes("actor_active")) return { rowCount:1, rows:[{ actor_active:true, membership_active:true,
        policy_observe:true, capacity_available:true, no_active_work:true }] };
      if (text.includes("connection_type")) return { rowCount: 1, rows: [{ connection_type:"WHATSAPP",
        connection_scope:"CORPORATE", connection_status:"DISCONNECTED", secret_reference:null, unit_linked:true,
        contact_name:"E2E Inbox 34569418102-1", conversation_status:"OPEN", automation_status:"HUMAN_QUEUED",
        conversation_assignee:null, service_case_status:"WAITING_HUMAN", handoff_status:"QUEUED",
        handoff_assignee:null, conversation_version:1, service_case_version:1, handoff_version:1,
        attendant_availability_status:"OFFLINE",
        inbound_count:1, outbound_count:0, hermes_count:0, claim_count:0, requeue_count:0,
        same_actor_journey_count:0, meta_receipt_count:0, meta_inbound_event_count:0,
        forbidden_outbox_count:0, forbidden_audit_count:0 }] };
      return { rowCount: 0, rows: [] };
    }
    async end() { calls.push(["END"]); }
  }
  const result = await runFixtureAction("prepare", "34569418102-1", {
    databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config,
  }, FakeClient);
  assert.deepEqual(result, { status:"ok" });
  assert.equal(calls.some(([text]) => text === "BEGIN"), true);
  assert.equal(calls.some(([text]) => text === "COMMIT"), true);
  assert.equal(calls.some(([text]) => text.includes("pg_advisory_xact_lock")), true);
  assert.equal(calls.some(([text]) => text.includes("direction='OUTBOUND'")), true);
  assert.equal(calls.some(([text]) => text.includes("actor='HERMES'")), true);
  assert.equal(calls.some(([text]) => text.includes("handoff_claim_commands") && text.includes("expected_version=1")), true);
  assert.equal(calls.some(([text]) => text.includes("handoff_requeue_commands") && text.includes("expected_version=2")), true);
  assert.equal(calls.some(([text]) => text.includes("meta_delivery_status_receipts")), true);
  assert.equal(calls.some(([text]) => text.includes("forbidden_outbox_count")), true);
  assert.equal(calls.some(([text]) => text.includes("forbidden_audit_count")), true);
  assert.equal(calls.some(([text]) => text.includes("membership.role='ATTENDANT'")), true);
  assert.equal(calls.some(([text]) => text.includes("policy.mode='OBSERVE'")), true);
  assert.equal(calls.some(([text]) => text.includes("availability.status='OFFLINE'")), true);
  assert.equal(calls.some(([text]) => text.includes("no_active_work")), true);
  assert.equal(calls.some(([text]) => text.includes("34569418102-1")), false);
  assert.equal(calls.some(([text]) => /META|HERMES/.test(text) && text.startsWith("INSERT")), false);
  for (const [text, values] of calls.filter(([, values]) => values)) {
    const indexes = [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(values.length, Math.max(...indexes), `parameter count mismatch in: ${text}`);
  }
});

test("prepare fails closed when the dedicated attendant is not operationally ready", async () => {
  class UnreadyClient {
    async connect() {}
    async query(text) {
      if (text.includes("tenant_exists")) return { rowCount:1, rows:[{ tenant_exists:true, unit_exists:true }] };
      if (text.includes("FROM human_handoffs") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("FROM conversations") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("transfer_exists")) return { rowCount:1, rows:[{ transfer_exists:false, takeover_exists:false }] };
      if (text.includes("actor_active")) return { rowCount:1, rows:[{ actor_active:true, membership_active:true,
        policy_observe:true, capacity_available:false, no_active_work:true }] };
      return { rowCount:0, rows:[] };
    }
    async end() {}
  }
  await assert.rejects(runFixtureAction("prepare", "34569418102-1", {
    databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config,
  }, UnreadyClient), /FIXTURE_ATTENDANT_NOT_READY/);
});

test("verify proves one claim and one requeue by the same actor and rejects a merely prepared fixture", async () => {
  const completed = { connection_type:"WHATSAPP", connection_scope:"CORPORATE", connection_status:"DISCONNECTED",
    secret_reference:null, unit_linked:true, contact_name:"E2E Inbox 34569418102-1", conversation_status:"OPEN",
    automation_status:"HUMAN_QUEUED", conversation_assignee:null, service_case_status:"WAITING_HUMAN",
    handoff_status:"QUEUED", handoff_assignee:null, conversation_version:3, service_case_version:3,
    handoff_version:3, attendant_availability_status:"OFFLINE", inbound_count:1, outbound_count:0,
    hermes_count:0, claim_count:1, requeue_count:1,
    same_actor_journey_count:1, meta_receipt_count:0, meta_inbound_event_count:0,
    forbidden_outbox_count:0, forbidden_audit_count:0 };
  class VerifyClient {
    static row = completed;
    async connect() {}
    async query(text) {
      if (text.includes("connection_type")) return { rowCount:1, rows:[VerifyClient.row] };
      return { rowCount:0, rows:[] };
    }
    async end() {}
  }
  const inputs = { databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config };
  await runFixtureAction("verify", "34569418102-1", inputs, VerifyClient);
  VerifyClient.row = { ...completed, conversation_version:1, service_case_version:1, handoff_version:1,
    claim_count:0, requeue_count:0, same_actor_journey_count:0 };
  await assert.rejects(runFixtureAction("verify", "34569418102-1", inputs, VerifyClient), /FIXTURE_STATE_INVALID/);
  VerifyClient.row = { ...completed, forbidden_outbox_count:1 };
  await assert.rejects(runFixtureAction("verify", "34569418102-1", inputs, VerifyClient), /FIXTURE_STATE_INVALID/);
  VerifyClient.row = { ...completed, attendant_availability_status:"AVAILABLE" };
  await assert.rejects(runFixtureAction("verify", "34569418102-1", inputs, VerifyClient), /FIXTURE_STATE_INVALID/);
  const verifiedSql = [];
  class SqlClient extends VerifyClient { async query(text, values) { verifiedSql.push([text, values]); return super.query(text); } }
  VerifyClient.row = completed;
  await runFixtureAction("verify", "34569418102-1", inputs, SqlClient);
  const verification = verifiedSql.find(([text]) => text.includes("connection_type"));
  assert.match(verification[0], /handoff_claim_commands[\s\S]*actor_id=\$10/);
  assert.match(verification[0], /handoff_requeue_commands[\s\S]*actor_id=\$10/);
  assert.match(verification[0], /attendant_unit_availability[\s\S]*user_id=\$10/);
  assert.equal(verification[1][9], config.attendantUserId);
});

test("database failures roll back and the CLI never serializes inputs", async () => {
  const calls = [];
  class FailingClient {
    async connect() {}
    async query(text) { calls.push(text); if (text.includes("tenant_exists")) throw new Error("private database detail"); return { rows: [] }; }
    async end() {}
  }
  await assert.rejects(runFixtureAction("cleanup", "34569418102-1", {
    databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config,
  }, FailingClient), /private database detail/);
  assert.ok(calls.includes("ROLLBACK"));
  const script = fileURLToPath(new URL("./staging-inbox-e2e-fixture.mjs", import.meta.url));
  const cli = spawnSync(process.execPath, [script, "--prepare", "invalid"], { encoding:"utf8" });
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "STAGING_INBOX_E2E_FIXTURE_FAILED\n");
});

test("cleanup is replay-safe and leaves no deterministic fixture rows", async () => {
  const calls = [];
  class CleanupClient {
    async connect() {}
    async query(text) {
      calls.push(text);
      if (text.includes("tenant_exists")) return { rowCount:1, rows:[{ tenant_exists:true, unit_exists:true }] };
      if (text.includes("FROM human_handoffs") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("FROM conversations") && text.includes("FOR UPDATE")) return { rowCount:0, rows:[] };
      if (text.includes("transfer_exists")) return { rowCount:1, rows:[{ transfer_exists:false, takeover_exists:false }] };
      if (text.includes("remaining")) return { rowCount:1, rows:[{ remaining:"0" }] };
      return { rowCount:0, rows:[] };
    }
    async end() {}
  }
  const inputs = { databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config };
  await runFixtureAction("cleanup", "34569418102-1", inputs, CleanupClient);
  await runFixtureAction("cleanup", "34569418102-1", inputs, CleanupClient);
  assert.equal(calls.filter((text) => text === "COMMIT").length, 2);
  assert.equal(calls.filter((text) => text.includes("DELETE FROM human_handoffs")).length, 2);
});

test("cleanup fails closed before every DELETE while fixture work is active or assigned", async () => {
  for (const unsafe of [
    { handoff:{ status:"ACTIVE", assigned_user_id:null }, conversation:null, commands:{ transfer_exists:false, takeover_exists:false } },
    { handoff:{ status:"QUEUED", assigned_user_id:config.attendantUserId }, conversation:null, commands:{ transfer_exists:false, takeover_exists:false } },
    { handoff:null, conversation:{ assigned_user_id:config.attendantUserId }, commands:{ transfer_exists:false, takeover_exists:false } },
    { handoff:null, conversation:null, commands:{ transfer_exists:true, takeover_exists:false } },
    { handoff:null, conversation:null, commands:{ transfer_exists:false, takeover_exists:true } },
  ]) {
    const calls = [];
    class UnsafeCleanupClient {
      async connect() {}
      async query(text) {
        calls.push(text);
        if (text.includes("tenant_exists")) return { rowCount:1, rows:[{ tenant_exists:true, unit_exists:true }] };
        if (text.includes("FROM human_handoffs") && text.includes("FOR UPDATE")) {
          return { rowCount:unsafe.handoff?1:0, rows:unsafe.handoff?[unsafe.handoff]:[] };
        }
        if (text.includes("FROM conversations") && text.includes("FOR UPDATE")) {
          return { rowCount:unsafe.conversation?1:0, rows:unsafe.conversation?[unsafe.conversation]:[] };
        }
        if (text.includes("transfer_exists")) return { rowCount:1, rows:[unsafe.commands] };
        return { rowCount:0, rows:[] };
      }
      async end() {}
    }
    await assert.rejects(runFixtureAction("cleanup", "34569418102-1", {
      databaseUrl:"postgresql://zap_pronto_owner:private@postgres/zap_pronto", config,
    }, UnsafeCleanupClient), /FIXTURE_CLEANUP_ACTIVE_WORK_CONFLICT/);
    assert.equal(calls.some((text) => text.startsWith("DELETE FROM")), false);
    assert.equal(calls.includes("ROLLBACK"), true);
    assert.equal(calls.includes("COMMIT"), false);
  }
});
