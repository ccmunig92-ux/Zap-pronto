import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { withTenantTransaction } from "../dist/database/tenant-transaction.js";
import { claimHandoff, listHandoffs, listResolvedHandoffs, requestHandoff, resolveHandoff, requeueHandoff,listTransferCandidates,transferHandoff } from "../dist/domain/handoffs.js";
import { acceptInboundEnvelope, normalizeWhatsAppInbound } from "../dist/domain/channel-inbound.js";
import { materializeInboundChannelEvent } from "../dist/domain/inbound-materialization.js";
import { listRoutingRequired, resolveRoutingRequired } from "../dist/domain/inbound-routing.js";
import { getConversation, listConversationMessages, sendHumanTextMessage, cancelHumanTextMessage } from "../dist/domain/inbox-conversations.js";
import { reconcileMetaDeliveryStatus } from "../dist/domain/meta-delivery-status.js";
import { acceptQuote, approveQuoteReview, cancelQuote, createReadyQuote, expireQuote, publishPriceListVersion, sendQuote } from "../dist/domain/quotes.js";
import { applyMedicalOrderExtraction, markMedicalOrderUnreadable, receiveMedicalOrder, reviewMedicalOrder } from "../dist/domain/medical-orders.js";
import { listAdministrativeInvitations, listAdministrativeUsers, unitMembershipFingerprint } from "../dist/domain/user-administration.js";
import { buildApp } from "../apps/api/dist/app.js";
import { createOidcIdentityVerifier } from "../apps/api/dist/auth/oidc-verifier.js";
import { claimInboundMaterializationEvents, processInboundClaim } from "../apps/api/dist/worker/inbound-runner.js";
import { getActorUnitAvailability, setActorUnitAvailability } from "../dist/domain/availability.js";

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
      "0015_oidc_invitation_acceptance.sql",
      "0016_invitation_acceptance_rate_limit.sql",
      "0017_inbox_handoff_unit_rls.sql",
      "0018_inbound_channel_events.sql",
      "0019_inbox_conversation_read.sql",
      "0020_inbox_claim_target.sql",
      "0021_human_text_outbound.sql",
      "0022_outbound_cancellation_status.sql",
      "0023_human_text_outbound_cancel.sql",
      "0024_meta_delivery_status_receipts.sql",
      "0025_meta_delivery_status_timestamp_guard.sql",
      "0026_meta_delivery_status_message_time_guard.sql",
      "0027_inbox_handoff_resolve.sql",
      "0028_request_handoff_idempotency.sql",
      "0029_outbound_worker_foundation.sql",
      "0030_inbox_handoff_requeue.sql",
      "0031_inbox_handoff_transfer.sql",
      "0032_inbox_sla_priority.sql",
      "0033_inbox_handoff_takeover.sql",
      "0034_membership_lifecycle.sql",
      "0035_medical_order_active_membership_rls.sql",
      "0036_unit_membership_catalog.sql",
      "0037_supervised_handoff_projection_types.sql",
      "0038_handoff_transfer_active_membership.sql",
      "0039_handoff_transfer_replay_authorization.sql",
      "0040_handoff_transfer_reason.sql",
      "0041_membership_assignment_serialization.sql",
      "0042_handoff_resolution_disposition.sql",
      "0043_handoff_replay_authorization.sql",
      "0044_inbox_resolved_history.sql",
      "0045_resolved_history_actor_join.sql",
      "0046_closed_conversation_history_authorization.sql",
      "0047_resolved_history_filters.sql",
      "0048_closed_history_server_cutoff.sql",
      "0049_handoff_reopen.sql",
      "0050_handoff_reopen_latest_episode.sql",
      "0051_attendant_availability.sql",
      "0052_availability_authorization_hardening.sql",
      "0053_inbox_sla_alerts.sql",
      "0054_sla_alert_projection_hardening.sql",
      "0055_sla_acknowledgement_episodes.sql",
      "0056_unit_sla_policy.sql",
      "0057_sla_policy_idempotency_serialization.sql",
      "0058_team_availability_projection.sql",
    ]) {
      const migration = await readFile(resolve("database/migrations", filename), "utf8");
      await target.query(migration);
    }

    for (const filename of ["0001_rls.sql", "0002_integrity.sql"]) {
      const testSql = await readFile(resolve("database/tests", filename), "utf8");
      await target.query(testSql);
    }
    const availabilityTestClient = new pg.Client({ connectionString: targetUrl.toString() });
    await availabilityTestClient.connect();
    try {
      await availabilityTestClient.query(await readFile(resolve("database/tests", "0003_availability.sql"), "utf8"));
    } finally {
      await availabilityTestClient.end();
    }
    const slaAlertTestClient = new pg.Client({ connectionString: targetUrl.toString() });
    await slaAlertTestClient.connect();
    try {
      await slaAlertTestClient.query(await readFile(resolve("database/tests", "0004_sla_alerts.sql"), "utf8"));
    } finally {
      await slaAlertTestClient.end();
    }
    const slaPolicyTestClient = new pg.Client({ connectionString: targetUrl.toString() });
    await slaPolicyTestClient.connect();
    try {
      await slaPolicyTestClient.query(await readFile(resolve("database/tests", "0005_sla_policy.sql"), "utf8"));
    } finally {
      await slaPolicyTestClient.end();
    }

    const policyRaceTenant="94000000-0000-4000-8000-000000000001";
    const policyRaceActor="94000000-0000-4000-8000-000000000002";
    const policyRaceUnits=["94000000-0000-4000-8000-000000000003","94000000-0000-4000-8000-000000000004"];
    const teamSupervisor="94000000-0000-4000-8000-000000000005",teamAttendant="94000000-0000-4000-8000-000000000006",
      teamRevoked="94000000-0000-4000-8000-000000000007";
    await target.query("INSERT INTO tenants(id,name) VALUES($1,'SLA policy race')",[policyRaceTenant]);
    await target.query("INSERT INTO units(id,tenant_id,code,name) VALUES($2,$1,'RACE-A','Race A'),($3,$1,'RACE-B','Race B')",
      [policyRaceTenant,...policyRaceUnits]);
    await target.query("INSERT INTO users(id,tenant_id,email,display_name) VALUES($2,$1,'sla-race@test.local','SLA Race Manager')",
      [policyRaceTenant,policyRaceActor]);
    await target.query("INSERT INTO user_units(tenant_id,user_id,unit_id,role) VALUES($1,$4,$2,'UNIT_MANAGER'),($1,$4,$3,'UNIT_MANAGER')",
      [policyRaceTenant,...policyRaceUnits,policyRaceActor]);
    await target.query(`INSERT INTO users(id,tenant_id,email,display_name) VALUES
      ($2,$1,'team-supervisor@test.local','ana'),($3,$1,'team-attendant@test.local','Ana'),($4,$1,'team-revoked@test.local','Zed')`,
      [policyRaceTenant,teamSupervisor,teamAttendant,teamRevoked]);
    await target.query(`INSERT INTO user_units(tenant_id,user_id,unit_id,role,status,revoked_at,revoked_by_user_id,revocation_reason) VALUES
      ($1,$2,$5,'SUPERVISOR','ACTIVE',NULL,NULL,NULL),($1,$3,$5,'ATTENDANT','ACTIVE',NULL,NULL,NULL),
      ($1,$4,$5,'SUPERVISOR','REVOKED',now(),$2,'SECURITY_REVIEW')`,
      [policyRaceTenant,teamSupervisor,teamAttendant,teamRevoked,policyRaceUnits[0]]);
    await target.query("UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=2 WHERE tenant_id=$1 AND user_id=$2 AND unit_id=$3",
      [policyRaceTenant,teamSupervisor,policyRaceUnits[0]]);
    await target.query("UPDATE attendant_unit_availability SET status='PAUSED',max_active=1,pause_reason='BREAK' WHERE tenant_id=$1 AND user_id=$2 AND unit_id=$3",
      [policyRaceTenant,teamAttendant,policyRaceUnits[0]]);
    const policyRaceClients=await Promise.all([0,1].map(async()=>{const client=new pg.Client({connectionString:targetUrl.toString()});
      await client.connect();await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_api");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.correlation_id',$3,true)",
        [policyRaceTenant,policyRaceActor,`sla-policy-race-${randomUUID()}`]);return client}));
    const policyRaceTargets=JSON.stringify([{priority:"LOW",targetMinutes:120},{priority:"NORMAL",targetMinutes:60},
      {priority:"HIGH",targetMinutes:30},{priority:"URGENT",targetMinutes:15}]);
    const policyRaceCalls=policyRaceClients.map((client,index)=>client.query(
      "SELECT * FROM set_unit_sla_policy($1,0,$2::jsonb,'sla-policy-shared-race-key',$3)",
      [policyRaceUnits[index],policyRaceTargets,index===0?"a".repeat(64):"b".repeat(64)]));
    const firstPolicyRace=await Promise.race(policyRaceCalls.map((call,index)=>call.then(result=>({index,result}))));
    assert.equal(firstPolicyRace.result.rows.length,1);assert.equal(firstPolicyRace.result.rows[0].replayed,false);
    await policyRaceClients[firstPolicyRace.index].query("COMMIT");
    const losingPolicyRaceIndex=firstPolicyRace.index===0?1:0;
    await assert.rejects(policyRaceCalls[losingPolicyRaceIndex],/SLA_POLICY_IDEMPOTENCY_CONFLICT/);
    await policyRaceClients[losingPolicyRaceIndex].query("ROLLBACK");
    await Promise.all(policyRaceClients.map(client=>client.end()));
    const policyRaceEvidence=(await target.query(`SELECT
      (SELECT count(*)::int FROM unit_sla_policy_publish_commands WHERE tenant_id=$1) commands,
      (SELECT count(*)::int FROM unit_sla_policy_versions WHERE tenant_id=$1) versions,
      (SELECT count(*)::int FROM unit_sla_policy_targets WHERE tenant_id=$1) targets,
      (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND action='SLA_POLICY_PUBLISHED') audits`,[policyRaceTenant])).rows[0];
    assert.deepEqual(policyRaceEvidence,{commands:1,versions:1,targets:4,audits:1});
    const teamQuery=async(actorId,unitId,limit=101,status=null,anchorName=null,anchorId=null)=>{const client=new pg.Client({connectionString:targetUrl.toString()});
      await client.connect();try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_api");
        await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.correlation_id','team-test',true)",[policyRaceTenant,actorId]);
        const result=await client.query("SELECT * FROM list_unit_team_availability($1,$2,$3,$4,$5)",[unitId,limit,status,anchorName,anchorId]);
        await client.query("ROLLBACK");return result.rows}finally{await client.end()}};
    const teamBefore=(await target.query("SELECT count(*)::int count FROM attendant_unit_availability WHERE tenant_id=$1",[policyRaceTenant])).rows[0].count;
    const managerTeam=await teamQuery(policyRaceActor,policyRaceUnits[0]);
    assert.deepEqual(managerTeam.map(row=>row.display_name),["Ana","ana","SLA Race Manager"]);
    assert.deepEqual(managerTeam.slice(0,2).map(row=>({status:row.status,active:row.active_count,remaining:row.remaining_capacity})),
      [{status:"PAUSED",active:0,remaining:1},{status:"AVAILABLE",active:0,remaining:2}]);
    assert.deepEqual((await teamQuery(teamSupervisor,policyRaceUnits[0],101,"PAUSED")).map(row=>row.user_id),[teamAttendant]);
    const firstTeamPage=await teamQuery(teamSupervisor,policyRaceUnits[0],1);assert.equal(firstTeamPage.length,1);
    assert.deepEqual((await teamQuery(teamSupervisor,policyRaceUnits[0],2,null,firstTeamPage[0].display_name,firstTeamPage[0].user_id)).map(row=>row.display_name),["ana","SLA Race Manager"]);
    await assert.rejects(teamQuery(teamSupervisor,policyRaceUnits[1]),/TEAM_AVAILABILITY_NOT_FOUND/);
    await assert.rejects(teamQuery(teamAttendant,policyRaceUnits[0]),/TEAM_AVAILABILITY_NOT_FOUND/);
    await assert.rejects(teamQuery(teamRevoked,policyRaceUnits[0]),/TEAM_AVAILABILITY_NOT_FOUND/);
    await assert.rejects(teamQuery(teamSupervisor,policyRaceUnits[0],2,null,"missing",teamAttendant),/TEAM_AVAILABILITY_CURSOR_INVALID/);
    assert.equal((await target.query("SELECT count(*)::int count FROM attendant_unit_availability WHERE tenant_id=$1",[policyRaceTenant])).rows[0].count,teamBefore);

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
      "contact_identities", "contacts", "conversations", "handoff_claim_commands", "human_handoffs",
      "inbound_channel_events",
      "medical_order_items", "medical_order_pages", "medical_order_review_events", "medical_orders",
      "message_attachments", "messages", "oidc_providers", "outbox_events", "price_list_versions", "price_lists", "prices",
      "quote_events", "quote_items", "quotes", "service_cases", "tenants", "units", "user_units", "users", "workflow_transitions",
      "user_invitations", "user_invitation_units", "user_lifecycle_commands", "user_oidc_identities",
    ];
    protectedTables.sort();
    const globalHiddenTables = ["attendant_unit_availability","attendant_availability_commands","invitation_acceptance_rate_limits","inbound_routing_commands","human_text_message_commands",
      "human_text_message_cancel_commands","meta_delivery_status_receipts","meta_delivery_status_applications","handoff_resolve_commands","handoff_requeue_commands","handoff_transfer_commands",
      "handoff_takeover_commands","handoff_reopen_commands","membership_lifecycle_commands"];
    globalHiddenTables.push("handoff_sla_acknowledgements","handoff_sla_acknowledge_commands");
    globalHiddenTables.push("unit_sla_policy_publish_commands","unit_sla_policy_targets","unit_sla_policy_versions");
    const allProtectedTables = [...catalogTables, ...protectedTables, ...globalHiddenTables].sort();
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
      "medical_order_review_events", "handoff_claim_commands",
    ]);
    const apiHidden = new Set([
      "attendant_unit_availability", "attendant_availability_commands",
      "user_invitations", "user_invitation_units", "user_lifecycle_commands",
      "invitation_acceptance_rate_limits",
      "inbound_routing_commands",
      "human_text_message_commands",
      "human_text_message_cancel_commands",
      "meta_delivery_status_receipts", "meta_delivery_status_applications",
      "handoff_resolve_commands",
      "handoff_requeue_commands",
      "handoff_transfer_commands",
      "handoff_takeover_commands",
      "handoff_reopen_commands",
      "membership_lifecycle_commands",
      "handoff_sla_acknowledgements", "handoff_sla_acknowledge_commands",
      "unit_sla_policy_versions", "unit_sla_policy_targets", "unit_sla_policy_publish_commands",
    ]);
    const workerReadable = new Set([
      "tenants", "units", "channel_connections", "channel_connection_units",
      "service_cases", "message_attachments",
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
    const inboundSecurity = await target.query(`SELECT
      resolver.prosecdef AS resolver_security_definer,
      persistence.prosecdef AS persistence_security_definer,
      resolver.proconfig AS resolver_config,
      persistence.proconfig AS persistence_config,
      resolver_owner.rolname=table_owner.tableowner AS resolver_owner_matches,
      persistence_owner.rolname=table_owner.tableowner AS persistence_owner_matches,
      has_function_privilege('zap_pronto_api','resolve_inbound_channel_binding(text,text)','EXECUTE') AS api_resolve,
      has_function_privilege('zap_pronto_api','persist_inbound_channel_event(text,text,text,text,text,timestamptz,text,jsonb,text,text,uuid,uuid,text,text)','EXECUTE') AS api_persist,
      has_function_privilege('zap_pronto_worker','resolve_inbound_channel_binding(text,text)','EXECUTE') AS worker_resolve,
      has_function_privilege('zap_pronto_worker','persist_inbound_channel_event(text,text,text,text,text,timestamptz,text,jsonb,text,text,uuid,uuid,text,text)','EXECUTE') AS worker_persist
      FROM pg_proc resolver
      JOIN pg_roles resolver_owner ON resolver_owner.oid=resolver.proowner
      JOIN pg_proc persistence ON persistence.oid='persist_inbound_channel_event(text,text,text,text,text,timestamptz,text,jsonb,text,text,uuid,uuid,text,text)'::regprocedure
      JOIN pg_roles persistence_owner ON persistence_owner.oid=persistence.proowner
      CROSS JOIN (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='channel_connections') table_owner
      WHERE resolver.oid='resolve_inbound_channel_binding(text,text)'::regprocedure`);
    assert.deepEqual(inboundSecurity.rows[0], {
      resolver_security_definer: true, persistence_security_definer: true,
      resolver_config: ["search_path=pg_catalog, public", "row_security=off"],
      persistence_config: ["search_path=pg_catalog, public", "row_security=off"],
      resolver_owner_matches: true, persistence_owner_matches: true,
      api_resolve: true, api_persist: true, worker_resolve: false, worker_persist: false,
    });
    const materializerSecurity=await target.query(`SELECT function.prosecdef,
      function.proconfig,owner.rolname=table_owner.tableowner AS owner_matches,
      has_function_privilege('zap_pronto_worker','materialize_inbound_channel_event(uuid,uuid)','EXECUTE') AS worker_execute,
      has_function_privilege('zap_pronto_api','materialize_inbound_channel_event(uuid,uuid)','EXECUTE') AS api_execute,
      has_table_privilege('zap_pronto_worker','outbox_events','SELECT') AS worker_outbox_select,
      has_table_privilege('zap_pronto_worker','contacts','SELECT') AS worker_contacts_select,
      has_table_privilege('zap_pronto_worker','messages','INSERT') AS worker_messages_insert
      FROM pg_proc function JOIN pg_roles owner ON owner.oid=function.proowner
      CROSS JOIN (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='messages') table_owner
      WHERE function.oid='materialize_inbound_channel_event(uuid,uuid)'::regprocedure`);
    assert.deepEqual(materializerSecurity.rows[0],{prosecdef:true,
      proconfig:["search_path=pg_catalog, public","row_security=off"],owner_matches:true,
      worker_execute:true,api_execute:false,worker_outbox_select:false,worker_contacts_select:false,
      worker_messages_insert:false});
    const inboundWorkerSecurity=await target.query(`SELECT
      has_function_privilege('zap_pronto_worker','claim_inbound_materialization_events(integer,integer)','EXECUTE') AS worker_claim,
      has_function_privilege('zap_pronto_api','claim_inbound_materialization_events(integer,integer)','EXECUTE') AS api_claim,
      has_function_privilege('zap_pronto_worker','fail_inbound_materialization_event(uuid,uuid,text,integer)','EXECUTE') AS worker_fail,
      has_function_privilege('zap_pronto_api','fail_inbound_materialization_event(uuid,uuid,text,integer)','EXECUTE') AS api_fail,
      (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public','row_security=off'])
        FROM pg_proc WHERE oid IN ('claim_inbound_materialization_events(integer,integer)'::regprocedure,
          'fail_inbound_materialization_event(uuid,uuid,text,integer)'::regprocedure)) AS hardened,
      (SELECT bool_and(owner.rolname=table_owner.tableowner) FROM pg_proc function
        JOIN pg_roles owner ON owner.oid=function.proowner
        CROSS JOIN (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='outbox_events') table_owner
        WHERE function.oid IN ('claim_inbound_materialization_events(integer,integer)'::regprocedure,
          'fail_inbound_materialization_event(uuid,uuid,text,integer)'::regprocedure)) AS owner_matches`);
    assert.deepEqual(inboundWorkerSecurity.rows[0],{worker_claim:true,api_claim:false,worker_fail:true,api_fail:false,
      hardened:true,owner_matches:true});
    const routingSecurity=await target.query(`SELECT
      has_function_privilege('zap_pronto_api','list_inbound_routing_required(integer,timestamptz,uuid)','EXECUTE') AS api_list,
      has_function_privilege('zap_pronto_api','resolve_inbound_routing_required(uuid,uuid,text,text)','EXECUTE') AS api_resolve,
      has_function_privilege('zap_pronto_worker','list_inbound_routing_required(integer,timestamptz,uuid)','EXECUTE') AS worker_list,
      has_function_privilege('zap_pronto_worker','resolve_inbound_routing_required(uuid,uuid,text,text)','EXECUTE') AS worker_resolve,
      has_table_privilege('zap_pronto_api','inbound_routing_commands','SELECT') AS api_command_select,
      has_table_privilege('zap_pronto_api','inbound_channel_events','UPDATE') AS api_receipt_update,
      (SELECT count(*)::int FROM app_role_permissions WHERE permission_code LIKE 'inbound.routing.%'
        AND role_code<>'TENANT_ADMIN') AS non_admin_grants`);
    assert.deepEqual(routingSecurity.rows[0],{api_list:true,api_resolve:true,worker_list:false,worker_resolve:false,
      api_command_select:false,api_receipt_update:false,non_admin_grants:0});
    const teamAvailabilitySecurity=await target.query(`SELECT
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='availability.supervise' ORDER BY role_code) roles,
      has_function_privilege('zap_pronto_api','list_unit_team_availability(uuid,integer,text,text,uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_unit_team_availability(uuid,integer,text,text,uuid)','EXECUTE') worker_execute,
      has_function_privilege('zap_pronto_app','list_unit_team_availability(uuid,integer,text,text,uuid)','EXECUTE') app_execute,
      (SELECT provolatile='s' AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public','row_security=off']
        FROM pg_proc WHERE oid='list_unit_team_availability(uuid,integer,text,text,uuid)'::regprocedure) pure_hardened`);
    assert.deepEqual(teamAvailabilitySecurity.rows[0],{roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],
      api_execute:true,worker_execute:false,app_execute:false,pure_hardened:true});
    const historySecurity=await target.query(`SELECT
      ARRAY(SELECT role_code FROM app_role_permissions WHERE permission_code='handoff.history.read' ORDER BY role_code) roles,
      has_function_privilege('zap_pronto_api','list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)','EXECUTE') worker_execute,
      function.prosecdef,function.proconfig,
      pg_get_functiondef(function.oid) LIKE '%handoff.status=''RESOLVED''%' resolved_only,
      pg_get_functiondef(function.oid) LIKE '%current_app_tenant_id()%' tenant_scoped,
      pg_get_functiondef(function.oid) LIKE '%current_actor_has_permission(''handoff.history.read'',requested_unit_id)%' authorized,
      pg_get_functiondef(function.oid) LIKE '%actor.tenant_id=handoff.tenant_id%' actor_tenant_join
      FROM pg_proc function WHERE function.oid='list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)'::regprocedure`);
    assert.deepEqual(historySecurity.rows[0],{roles:["SUPERVISOR","TENANT_ADMIN","UNIT_MANAGER"],api_execute:false,
      worker_execute:false,prosecdef:true,proconfig:["search_path=pg_catalog, public","row_security=off"],resolved_only:true,
      tenant_scoped:true,authorized:true,actor_tenant_join:true});
    const filteredHistorySecurity=await target.query(`SELECT
      has_function_privilege('zap_pronto_api','list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)','EXECUTE') worker_execute,
      function.prosecdef,function.proconfig,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure) LIKE '%current_actor_has_permission(''handoff.history.read'',requested_unit_id)%' authorized,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure) LIKE '%handoff.tenant_id=public.current_app_tenant_id()%' tenant_scoped,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure) LIKE '%requested_before-requested_from>interval ''366 days''%' bounded_window,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure) LIKE '%handoff.resolved_at>=requested_from%' inclusive_from,
      pg_get_functiondef('list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure) LIKE '%handoff.resolved_at<requested_before%' exclusive_before,
      EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='handoff_resolve_commands_history_lookup_idx'
        AND indexdef LIKE '%tenant_id, handoff_id, result_handoff_version, created_at DESC, idempotency_key DESC%') lookup_index
      FROM pg_proc function WHERE function.oid=
        'list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)'::regprocedure`);
    assert.deepEqual(filteredHistorySecurity.rows[0],{api_execute:true,worker_execute:false,prosecdef:true,
      proconfig:["search_path=pg_catalog, public","row_security=off"],authorized:true,tenant_scoped:true,
      bounded_window:true,inclusive_from:true,exclusive_before:true,lookup_index:true});
    const historyTimelineSecurity=await target.query(`SELECT
      has_function_privilege('zap_pronto_api','list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)','EXECUTE') api_execute,
      has_function_privilege('zap_pronto_worker','list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)','EXECUTE') worker_execute,
      function.prosecdef,function.proconfig,
      position('message.created_at<=effective_before' in pg_get_functiondef(function.oid))
        < position('ORDER BY date_trunc' in pg_get_functiondef(function.oid)) cutoff_before_order,
      pg_get_functiondef(function.oid) LIKE '%detail.status=''CLOSED''%detail.closed_at IS NULL%' rejects_invalid_closed,
      pg_get_functiondef(function.oid) LIKE '%LEAST(COALESCE(requested_before%detail.closed_at)%' caps_at_closed
      FROM pg_proc function WHERE function.oid='list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)'::regprocedure`);
    assert.deepEqual(historyTimelineSecurity.rows[0],{api_execute:true,worker_execute:false,prosecdef:true,
      proconfig:["search_path=pg_catalog, public","row_security=off"],cutoff_before_order:true,
      rejects_invalid_closed:true,caps_at_closed:true});
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
    const concurrentMaterializerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 20 });
    let closingPools = false;
    const guardedPools = [runtimePool, competingRuntimePool, workerPool, competingWorkerPool,
      concurrentMaterializerPool];
    for (const pool of guardedPools) {
      pool.on("error", (error) => {
        if (closingPools && error && typeof error === "object" && "code" in error && error.code === "57P01") return;
        process.nextTick(() => { throw error; });
      });
    }
    try {
      const materializeInbound = async (pool, tenantId, actorId, outboxId, leaseToken) => {
        const client=await pool.connect();
        try{
          await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
          await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),
            set_config('app.correlation_id',$3,true)`,[tenantId,actorId,`materialize-${outboxId}`]);
          const result=await materializeInboundChannelEvent(client,outboxId,leaseToken);
          await client.query("COMMIT");return result;
        }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
      };
      const leaseInboundOutbox=async(receiptId,leaseToken,seconds=300)=>{
        const leased=await target.query(`UPDATE outbox_events SET status='PROCESSING',published_at=NULL,
          dead_lettered_at=NULL,attempts=attempts+1,
          lease_token=$2,leased_at=clock_timestamp(),lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
          updated_at=clock_timestamp() WHERE aggregate_id=$1 AND event_type LIKE 'channel.inbound.%'
          RETURNING id`,[receiptId,leaseToken,seconds]);
        assert.equal(leased.rowCount,1);return leased.rows[0].id;
      };
      const inboundWorkerOptions={batchSize:1,leaseSeconds:60,pollIntervalMs:1000,backoffSeconds:1};
      const consumeInvitationAcceptanceRateLimit = async (pool, principalKeyHash) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE zap_pronto_api");
          const result = await client.query(
            "SELECT * FROM consume_invitation_acceptance_rate_limit($1)",
            [principalKeyHash],
          );
          await client.query("COMMIT");
          return result.rows[0];
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      const limiterPrivileges = await target.query(`SELECT
        has_function_privilege('zap_pronto_api','consume_invitation_acceptance_rate_limit(bytea)','EXECUTE') AS api_execute,
        has_function_privilege('zap_pronto_worker','consume_invitation_acceptance_rate_limit(bytea)','EXECUTE') AS worker_execute,
        has_function_privilege('zap_pronto_app','consume_invitation_acceptance_rate_limit(bytea)','EXECUTE') AS app_execute,
        has_table_privilege('zap_pronto_api','invitation_acceptance_rate_limits','SELECT') AS api_select,
        has_table_privilege('zap_pronto_api','invitation_acceptance_rate_limits','INSERT') AS api_insert,
        has_table_privilege('zap_pronto_worker','invitation_acceptance_rate_limits','SELECT') AS worker_select`);
      assert.deepEqual(limiterPrivileges.rows[0], {
        api_execute: true, worker_execute: false, app_execute: false,
        api_select: false, api_insert: false, worker_select: false,
      });

      await assert.rejects(
        consumeInvitationAcceptanceRateLimit(runtimePool, Buffer.alloc(31, 0x16)),
        (error) => error instanceof Error && "code" in error && error.code === "22023"
          && /INVALID_RATE_LIMIT_PRINCIPAL_KEY_HASH/.test(error.message),
      );

      const concurrentLimiterKey = Buffer.alloc(32, 0x16);
      const concurrentLimiterResults = await Promise.all(
        Array.from({ length: 12 }, (_, index) => consumeInvitationAcceptanceRateLimit(
          index % 2 === 0 ? runtimePool : competingRuntimePool,
          concurrentLimiterKey,
        )),
      );
      assert.equal(concurrentLimiterResults.filter((result) => result.allowed).length, 10);
      assert.equal(concurrentLimiterResults.filter((result) => !result.allowed).length, 2);
      assert.equal(Math.min(...concurrentLimiterResults.map((result) => result.remaining)), 0);
      for (const denied of concurrentLimiterResults.filter((result) => !result.allowed)) {
        assert.ok(denied.retry_after_seconds >= 1 && denied.retry_after_seconds <= 900);
        assert.ok(denied.reset_at instanceof Date && denied.reset_at.getTime() > Date.now());
      }
      const concurrentLimiterEvidence = await target.query(
        "SELECT attempts FROM invitation_acceptance_rate_limits WHERE principal_key_hash=$1",
        [concurrentLimiterKey],
      );
      assert.equal(concurrentLimiterEvidence.rows[0].attempts, 12);

      const persistedLimiterKey = Buffer.alloc(32, 0x17);
      const firstPersistedConsumption = await consumeInvitationAcceptanceRateLimit(runtimePool, persistedLimiterKey);
      assert.deepEqual(
        { allowed: firstPersistedConsumption.allowed, remaining: firstPersistedConsumption.remaining,
          retry_after_seconds: firstPersistedConsumption.retry_after_seconds },
        { allowed: true, remaining: 9, retry_after_seconds: 0 },
      );
      const failedApplicationTransaction = await runtimePool.connect();
      try {
        await failedApplicationTransaction.query("BEGIN");
        await failedApplicationTransaction.query("SET LOCAL ROLE zap_pronto_api");
        await failedApplicationTransaction.query("SELECT 1");
        await failedApplicationTransaction.query("ROLLBACK");
      } finally {
        await failedApplicationTransaction.query("ROLLBACK").catch(() => undefined);
        failedApplicationTransaction.release();
      }
      const persistedLimiterEvidence = await target.query(
        "SELECT attempts FROM invitation_acceptance_rate_limits WHERE principal_key_hash=$1",
        [persistedLimiterKey],
      );
      assert.equal(persistedLimiterEvidence.rows[0].attempts, 1);

      const staleLimiterKey = Buffer.alloc(32, 0x18);
      await target.query(`INSERT INTO invitation_acceptance_rate_limits
        (principal_key_hash,window_started_at,attempts,updated_at)
        VALUES ($1,clock_timestamp()-interval '2 days',1,clock_timestamp()-interval '2 days')`, [staleLimiterKey]);
      await consumeInvitationAcceptanceRateLimit(runtimePool, Buffer.alloc(32, 0x19));
      const staleLimiterEvidence = await target.query(
        "SELECT count(*)::integer AS count FROM invitation_acceptance_rate_limits WHERE principal_key_hash=$1",
        [staleLimiterKey],
      );
      assert.equal(staleLimiterEvidence.rows[0].count, 0);

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
        assert.equal(currentUserResponse.statusCode, 200, JSON.stringify(currentUserResponse.json()));
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

      const acceptanceDigest = Buffer.alloc(32, 0xe4);
      await createInvitation({ key: "admin-invite-acceptance", fingerprint: Buffer.alloc(32, 0xd6),
        id: "6d000000-0000-4000-8000-000000000001", email: "accepted-invite@test.local",
        digest: acceptanceDigest });
      const acceptInvitation = async (pool, overrides = {}) => {
        const values = { key: "accept-invitation-security", fingerprint: Buffer.alloc(32, 0xe6),
          digest: acceptanceDigest, userId: "6f000000-0000-4000-8000-000000000001",
          issuer: "https://identity.test", audience: "zap-pronto", subject: "accepted-subject",
          organizationClaim: "org_id", organizationValue: "tenant-a",
          email: "accepted-invite@test.local", emailVerified: true,
          correlationId: "accept-invitation-security", ...overrides };
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE zap_pronto_api");
          const accepted = await client.query(
            "SELECT * FROM accept_user_invitation_oidc($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            [values.key, values.fingerprint, values.digest, values.userId, values.issuer, values.audience,
              values.subject, values.organizationClaim, values.organizationValue, values.email,
              values.emailVerified, values.correlationId],
          );
          const context = await client.query(`SELECT current_app_tenant_id() AS tenant_id,
            current_app_actor_id() AS actor_id`);
          await client.query("COMMIT");
          return { accepted, context: context.rows[0] };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      };
      await assert.rejects(acceptInvitation(runtimePool, { email: "wrong-email@test.local" }),
        (error) => error instanceof Error && "code" in error && error.code === "28000");
      await assert.rejects(acceptInvitation(runtimePool, { organizationValue: "tenant-b" }),
        (error) => error instanceof Error && "code" in error && error.code === "28000");
      await assert.rejects(acceptInvitation(runtimePool, { digest: Buffer.alloc(32, 0xbb),
        email: "invite-b@test.local", organizationValue: "tenant-a" }),
      (error) => error instanceof Error && "code" in error && error.code === "28000");
      await assert.rejects(acceptInvitation(runtimePool, { digest: Buffer.alloc(32, 0xf1),
        email: "security-invite@test.local" }),
        (error) => error instanceof Error && "code" in error && error.code === "28000");
      await assert.rejects(acceptInvitation(runtimePool, { emailVerified: false }),
        (error) => error instanceof Error && "code" in error && error.code === "22023");
      const acceptedInvitation = await acceptInvitation(runtimePool);
      assert.deepEqual(acceptedInvitation.accepted.rows.map((row) => ({
        tenant_id: row.tenant_id, user_id: row.user_id, invitation_id: row.invitation_id,
        replayed: row.replayed,
      })), [{ tenant_id: "40000000-0000-4000-8000-000000000001",
        user_id: "6f000000-0000-4000-8000-000000000001",
        invitation_id: "6d000000-0000-4000-8000-000000000001", replayed: false }]);
      assert.deepEqual(acceptedInvitation.context, {
        tenant_id: "40000000-0000-4000-8000-000000000001",
        actor_id: "6f000000-0000-4000-8000-000000000001",
      });
      const acceptedReplay = await acceptInvitation(runtimePool, {
        userId: "6f000000-0000-4000-8000-000000000099",
      });
      assert.equal(acceptedReplay.accepted.rows[0].user_id, "6f000000-0000-4000-8000-000000000001");
      assert.equal(acceptedReplay.accepted.rows[0].replayed, true);
      await assert.rejects(acceptInvitation(runtimePool, { key: "accept-invitation-other-key",
        fingerprint: Buffer.alloc(32, 0xe7) }),
      (error) => error instanceof Error && "code" in error && error.code === "28000");

      const concurrentAcceptanceDigest = Buffer.alloc(32, 0xe5);
      await createInvitation({ key: "admin-invite-accept-concurrent", fingerprint: Buffer.alloc(32, 0xd7),
        id: "6e000000-0000-4000-8000-000000000001", email: "accepted-concurrent@test.local",
        digest: concurrentAcceptanceDigest });
      const concurrentAcceptances = await Promise.allSettled([
        acceptInvitation(runtimePool, { key: "accept-concurrent-first", fingerprint: Buffer.alloc(32, 0xe8),
          digest: concurrentAcceptanceDigest, userId: "6f000000-0000-4000-8000-000000000002",
          subject: "accepted-concurrent-first", email: "accepted-concurrent@test.local" }),
        acceptInvitation(competingRuntimePool, { key: "accept-concurrent-second", fingerprint: Buffer.alloc(32, 0xe9),
          digest: concurrentAcceptanceDigest, userId: "6f000000-0000-4000-8000-000000000003",
          subject: "accepted-concurrent-second", email: "accepted-concurrent@test.local" }),
      ]);
      assert.equal(concurrentAcceptances.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrentAcceptances.filter((result) => result.status === "rejected").length, 1);
      const acceptanceEvidence = await target.query(`SELECT
        (SELECT count(*)::integer FROM users WHERE email_normalized='accepted-concurrent@test.local') AS concurrent_users,
        (SELECT count(*)::integer FROM user_oidc_identities WHERE subject LIKE 'accepted-concurrent-%') AS concurrent_identities,
        (SELECT count(*)::integer FROM audit_events WHERE action='USER_INVITATION_ACCEPTED'
          AND entity_id IN ('6d000000-0000-4000-8000-000000000001','6e000000-0000-4000-8000-000000000001')) AS audits,
        (SELECT count(*)::integer FROM outbox_events WHERE event_type='user.invitation.accepted'
          AND aggregate_id IN ('6d000000-0000-4000-8000-000000000001','6e000000-0000-4000-8000-000000000001')) AS outbox`);
      assert.deepEqual(acceptanceEvidence.rows[0], {
        concurrent_users: 1, concurrent_identities: 1, audits: 2, outbox: 2,
      });
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
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001',
         '6d000000-0000-4000-8000-000000000001','6e000000-0000-4000-8000-000000000001')`);
      await target.query(`DELETE FROM outbox_events WHERE aggregate_id IN
        ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001',
         '6d000000-0000-4000-8000-000000000001','6e000000-0000-4000-8000-000000000001')`);
      await target.query(`DELETE FROM user_lifecycle_commands WHERE idempotency_key LIKE 'admin-%security%'
        OR idempotency_key LIKE 'admin-invite-accept%' OR idempotency_key LIKE 'accept-%'`);
      await target.query(`DELETE FROM user_invitations WHERE id IN
        ('66000000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001',
         '6a000000-0000-4000-8000-000000000001','6b000000-0000-4000-8000-000000000001',
         '6d000000-0000-4000-8000-000000000001','6e000000-0000-4000-8000-000000000001')`);
      await target.query("DELETE FROM user_oidc_identities WHERE subject LIKE 'accepted-%'");
      await target.query(`DELETE FROM attendant_availability_commands WHERE user_id IN
        ('6f000000-0000-4000-8000-000000000001','6f000000-0000-4000-8000-000000000002',
         '6f000000-0000-4000-8000-000000000003')`);
      await target.query(`DELETE FROM attendant_unit_availability WHERE user_id IN
        ('6f000000-0000-4000-8000-000000000001','6f000000-0000-4000-8000-000000000002',
         '6f000000-0000-4000-8000-000000000003')`);
      await target.query(`DELETE FROM user_units WHERE user_id IN
        ('6f000000-0000-4000-8000-000000000001','6f000000-0000-4000-8000-000000000002',
         '6f000000-0000-4000-8000-000000000003')`);
      await target.query(`DELETE FROM users WHERE id IN
        ('6f000000-0000-4000-8000-000000000001','6f000000-0000-4000-8000-000000000002',
         '6f000000-0000-4000-8000-000000000003')`);

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
        has_function_privilege('zap_pronto_api','accept_user_invitation_oidc(text,bytea,bytea,uuid,text,text,text,text,text,text,boolean,text)','EXECUTE') AS api_accept_invite_execute,
        has_function_privilege('zap_pronto_worker','accept_user_invitation_oidc(text,bytea,bytea,uuid,text,text,text,text,text,text,boolean,text)','EXECUTE') AS worker_accept_invite_execute,
        has_function_privilege('zap_pronto_app','accept_user_invitation_oidc(text,bytea,bytea,uuid,text,text,text,text,text,text,boolean,text)','EXECUTE') AS app_accept_invite_execute,
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
        api_accept_invite_execute: true, worker_accept_invite_execute: false, app_accept_invite_execute: false,
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
      await target.query("DELETE FROM attendant_availability_commands WHERE user_id=$1", [competingAdminId]);
      await target.query("DELETE FROM attendant_unit_availability WHERE user_id=$1", [competingAdminId]);
      await target.query("DELETE FROM user_units WHERE user_id=$1", [competingAdminId]);
      await target.query("DELETE FROM users WHERE id=$1", [competingAdminId]);
      await target.query(`UPDATE user_units SET role='ATTENDANT'
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND user_id=$1`, [actorAId]);
      await target.query("DELETE FROM audit_events WHERE entity_id=$1::text", [lifecycleTargetId]);
      await target.query("DELETE FROM outbox_events WHERE aggregate_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM user_lifecycle_commands WHERE target_user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM user_oidc_identities WHERE user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM attendant_availability_commands WHERE user_id=$1", [lifecycleTargetId]);
      await target.query("DELETE FROM attendant_unit_availability WHERE user_id=$1", [lifecycleTargetId]);
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

      // A migration de inbox nao pode redefinir current_actor_has_unit_access: as policies
      // legadas de precos, orcamentos e pedidos medicos preservam a semantica da 0009.
      await target.query(`UPDATE units SET active=false
        WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      try {
        const legacyUnitPolicyVisibility = await withTenantTransaction(runtimePool, {
          tenantId: "40000000-0000-4000-8000-000000000001",
          actorId: actorAId,
          correlationId: "legacy-unit-policy-regression",
        }, (client) => client.query(`SELECT
          (SELECT count(*)::integer FROM prices) AS prices,
          (SELECT count(*)::integer FROM quotes) AS quotes,
          (SELECT count(*)::integer FROM medical_orders) AS medical_orders`));
        assert.deepEqual(legacyUnitPolicyVisibility.rows[0], {
          prices: 1,
          quotes: 1,
          medical_orders: 1,
        }, "CURRENT_ACTOR_HAS_UNIT_ACCESS_WAS_REDEFINED");
      } finally {
        await target.query(`UPDATE units SET active=true
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`);
      }

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
        const expectedCount = ["handoff_claim_commands", "inbound_channel_events"].includes(table) ? 0 : 1;
        assert.equal(result.rows[0].count, expectedCount, `${table}:TENANT_A_VISIBILITY_FAILED`);
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

      for (const table of protectedTables.filter((name) =>
        name !== "users" && name !== "handoff_claim_commands" && name !== "inbound_channel_events")) {
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
        idempotencyKey: "claim-concurrent-a",
      };
      const availabilityUnitId=(await target.query("SELECT unit_id FROM human_handoffs WHERE id=$1",
        [handoffA.rows[0].id])).rows[0].unit_id;
      const availabilityCommand={unitId:availabilityUnitId,status:"OFFLINE",maxActive:10,pauseReason:null,
        pausedUntil:null,expectedVersion:1,idempotencyKey:"availability-auth-replay"};
      const availabilityChanged=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-create"},
        client=>setActorUnitAvailability(client,availabilityCommand));
      assert.equal(availabilityChanged.replayed,false);assert.equal(availabilityChanged.status,"OFFLINE");
      assert.equal((await withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-replay"},
        client=>setActorUnitAvailability(client,availabilityCommand))).replayed,true);
      const availabilityEffects=(await target.query(`SELECT
        (SELECT count(*)::int FROM attendant_availability_commands WHERE tenant_id=$1 AND user_id=$2) commands,
        (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND actor_id=$2::text
          AND action='ATTENDANT_AVAILABILITY_CHANGED') audits`,[claimContext.tenantId,claimContext.actorId])).rows[0];
      await target.query(`UPDATE user_units SET status='REVOKED',revoked_at=now(),revoked_by_user_id=$2,
        revocation_reason='Availability replay authorization test' WHERE tenant_id=$1 AND user_id=$2`,
      [claimContext.tenantId,claimContext.actorId]);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-get-revoked"},
        client=>getActorUnitAvailability(client,availabilityUnitId)),/AVAILABILITY_NOT_FOUND/);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-replay-revoked"},
        client=>setActorUnitAvailability(client,availabilityCommand)),/AVAILABILITY_NOT_FOUND/);
      assert.deepEqual((await target.query(`SELECT
        (SELECT count(*)::int FROM attendant_availability_commands WHERE tenant_id=$1 AND user_id=$2) commands,
        (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND actor_id=$2::text
          AND action='ATTENDANT_AVAILABILITY_CHANGED') audits`,[claimContext.tenantId,claimContext.actorId])).rows[0],availabilityEffects);
      await target.query(`UPDATE user_units SET status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL
        WHERE tenant_id=$1 AND user_id=$2`,[claimContext.tenantId,claimContext.actorId]);
      assert.equal((await withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-get-restored"},
        client=>getActorUnitAvailability(client,availabilityUnitId))).status,"OFFLINE");
      const availabilityRestored=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"availability-auth-available"},
        client=>setActorUnitAvailability(client,{...availabilityCommand,status:"AVAILABLE",expectedVersion:2,
          idempotencyKey:"availability-auth-available"}));
      assert.equal(availabilityRestored.status,"AVAILABLE");
      await target.query(`UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=100,
        pause_reason=NULL,paused_until=NULL WHERE tenant_id=$1 AND user_id=$2`,
        [claimContext.tenantId,claimContext.actorId]);
      const claimResults = await Promise.allSettled([
        withTenantTransaction(
          runtimePool,
          { ...claimContext, correlationId: "concurrent-claim-a" },
          (client) => claimHandoff(client, claimInput),
        ),
        withTenantTransaction(
          competingRuntimePool,
          { ...claimContext, correlationId: "concurrent-claim-b" },
          (client) => claimHandoff(client, { ...claimInput, idempotencyKey: "claim-concurrent-b" }),
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

      const winningKey = claimResults[0].status === "fulfilled" ? "claim-concurrent-a" : "claim-concurrent-b";
      const replayedClaim = await withTenantTransaction(runtimePool,
        { ...claimContext, correlationId: "claim-replay-same-winner" },
        (client) => claimHandoff(client, { ...claimInput, idempotencyKey: winningKey }));
      assert.equal(replayedClaim.replayed, true);
      assert.equal(replayedClaim.version, 2);
      await assert.rejects(
        withTenantTransaction(runtimePool,
          { ...claimContext, correlationId: "claim-replay-divergent" },
          (client) => claimHandoff(client, { ...claimInput, expectedVersion: 2, idempotencyKey: winningKey })),
        (error) => error instanceof Error && /IDEMPOTENCY_KEY_REUSED/.test(error.message),
      );

      const claimEvidence = await target.query(`
        SELECT h.status, h.version, h.assigned_user_id,
          (SELECT count(*)::integer FROM workflow_transitions wt
            WHERE wt.aggregate_type = 'HANDOFF' AND wt.aggregate_id = h.id AND wt.to_status = 'ACTIVE') AS transitions,
          (SELECT count(*)::integer FROM outbox_events oe
            WHERE oe.idempotency_key = 'handoff.claimed:' || h.id::text || ':' || h.version::text) AS outbox_events
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

      const requeueBefore=(await target.query(`SELECT conversation.version conversation_version,service_case.version case_version
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
        JOIN service_cases service_case ON service_case.id=handoff.service_case_id WHERE handoff.id=$1`,[handoffA.rows[0].id])).rows[0];
      const requeueInput={handoffId:handoffA.rows[0].id,expectedVersion:2,idempotencyKey:"handoff-requeue-key"};
      const requeueResults=await Promise.all(Array.from({length:12},(_,index)=>withTenantTransaction(index%2?competingRuntimePool:runtimePool,
        {...claimContext,correlationId:`handoff-requeue-${index}`},client=>requeueHandoff(client,requeueInput))));
      assert.equal(requeueResults.filter(result=>!result.replayed).length,1);
      assert.ok(requeueResults.every(result=>result.handoffVersion===3&&result.conversationVersion===requeueBefore.conversation_version+1
        &&result.serviceCaseVersion===requeueBefore.case_version+1));
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"handoff-requeue-divergent"},client=>requeueHandoff(client,
        {...requeueInput,expectedVersion:3})),/HANDOFF_REQUEUE_IDEMPOTENCY_CONFLICT/);
      const requeueEvidence=(await target.query(`SELECT handoff.status,handoff.version,handoff.assigned_user_id,handoff.claimed_at,
        service_case.status case_status,conversation.automation_status,conversation.assigned_user_id conversation_owner,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_REQUEUED' AND aggregate_id IN(handoff.id,service_case.id,conversation.id)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_REQUEUED' AND entity_id=handoff.id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.requeued' AND aggregate_id=handoff.id) outbox
        FROM human_handoffs handoff JOIN service_cases service_case ON service_case.id=handoff.service_case_id
        JOIN conversations conversation ON conversation.id=handoff.conversation_id WHERE handoff.id=$1`,[handoffA.rows[0].id])).rows[0];
      assert.deepEqual(requeueEvidence,{status:"QUEUED",version:3,assigned_user_id:null,claimed_at:null,case_status:"WAITING_HUMAN",
        automation_status:"HUMAN_QUEUED",conversation_owner:null,transitions:3,audits:1,outbox:1});
      await target.query("UPDATE user_units SET role='SUPERVISOR' WHERE tenant_id=$1 AND user_id=$2",
        [claimContext.tenantId,claimContext.actorId]);
      const slaProjection=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"sla-projection-version"},async client=>
        (await client.query(`SELECT handoff_id,acknowledgement_version FROM list_inbox_sla_alerts($1,101,NULL,NULL,
          clock_timestamp()+interval '1 day',NULL,NULL,NULL,NULL,NULL)`,[(await target.query(
          "SELECT unit_id FROM human_handoffs WHERE id=$1",[handoffA.rows[0].id])).rows[0].unit_id])).rows);
      assert.equal(slaProjection.find(row=>row.handoff_id===handoffA.rows[0].id)?.acknowledgement_version,3);
      const slaResolverKey="sla-resolver-unacked",slaResolverFingerprint=createHash("sha256").update(
        `{"expectedVersion":3,"handoffId":"${handoffA.rows[0].id.toLowerCase()}"}`).digest("hex");
      const slaHandoffUnit=(await target.query("SELECT unit_id FROM human_handoffs WHERE id=$1",
        [handoffA.rows[0].id])).rows[0].unit_id;
      const resolvedSlaUnit=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"sla-resolver-owned"},
        async client=>(await client.query("SELECT resolve_inbox_sla_alert_ack_unit($1,$2,$3,$4) unit_id",
          [handoffA.rows[0].id,3,slaResolverKey,slaResolverFingerprint])).rows[0].unit_id);
      assert.equal(resolvedSlaUnit,slaHandoffUnit);
      const slaAckKey="sla-ack-version-three",slaAckFingerprint=createHash("sha256").update(
        `{"expectedVersion":3,"handoffId":"${handoffA.rows[0].id.toLowerCase()}"}`).digest("hex");
      const slaAckResults=await Promise.all(Array.from({length:12},(_,index)=>withTenantTransaction(
        index%2?competingRuntimePool:runtimePool,{...claimContext,correlationId:`sla-ack-v3-${index}`},async client=>(await client.query(
          "SELECT * FROM acknowledge_inbox_sla_alert($1,$2,$3,$4)",
          [handoffA.rows[0].id,3,slaAckKey,slaAckFingerprint])).rows[0])));
      assert.equal(slaAckResults.filter(result=>!result.replayed).length,1);
      assert.ok(slaAckResults.every(result=>result.version===1));
      assert.equal((await target.query(`SELECT count(*)::int count FROM handoff_sla_acknowledgements
        WHERE tenant_id=$1 AND handoff_id=$2 AND handoff_version=3`,[claimContext.tenantId,handoffA.rows[0].id])).rows[0].count,1);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"sla-resolver-cross-tenant"},client=>client.query(
        "SELECT resolve_inbox_sla_alert_ack_unit($1,$2,$3,$4)",[handoffA.rows[0].id,3,slaResolverKey,
          slaResolverFingerprint])),/SLA_ALERT_NOT_FOUND/);
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE tenant_id=$1 AND user_id=$2",
        [claimContext.tenantId,claimContext.actorId]);
      const requeueEffectsBefore=(await target.query(`SELECT
        (SELECT count(*)::int FROM handoff_requeue_commands WHERE handoff_id=$1) commands,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_REQUEUED' AND aggregate_id IN(
          SELECT id FROM human_handoffs WHERE id=$1 UNION SELECT conversation_id FROM human_handoffs WHERE id=$1
          UNION SELECT service_case_id FROM human_handoffs WHERE id=$1)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_REQUEUED' AND entity_id=$1::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.requeued' AND aggregate_id=$1) outbox`,
      [handoffA.rows[0].id])).rows[0];
      await target.query(`UPDATE user_units SET status='REVOKED',revoked_at=now(),revoked_by_user_id=$2,
        revocation_reason='Replay authorization test' WHERE tenant_id=$1 AND user_id=$2`,
        [claimContext.tenantId,claimContext.actorId]);
      assert.equal(await withTenantTransaction(runtimePool,{...claimContext,correlationId:"handoff-requeue-permission-revoked"},
        async client=>(await client.query("SELECT current_actor_has_permission('handoff.requeue',$1) allowed",
          [(await target.query("SELECT unit_id FROM human_handoffs WHERE id=$1",[handoffA.rows[0].id])).rows[0].unit_id])).rows[0].allowed),false);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"handoff-requeue-replay-downgraded"},
        client=>requeueHandoff(client,requeueInput)),/HANDOFF_REQUEUE_NOT_FOUND/);
      assert.deepEqual((await target.query(`SELECT
        (SELECT count(*)::int FROM handoff_requeue_commands WHERE handoff_id=$1) commands,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_REQUEUED' AND aggregate_id IN(
          SELECT id FROM human_handoffs WHERE id=$1 UNION SELECT conversation_id FROM human_handoffs WHERE id=$1
          UNION SELECT service_case_id FROM human_handoffs WHERE id=$1)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_REQUEUED' AND entity_id=$1::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.requeued' AND aggregate_id=$1) outbox`,
      [handoffA.rows[0].id])).rows[0],requeueEffectsBefore);
      await target.query(`UPDATE user_units SET status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,
        revocation_reason=NULL WHERE tenant_id=$1 AND user_id=$2`,
        [claimContext.tenantId,claimContext.actorId]);
      assert.equal((await withTenantTransaction(runtimePool,{...claimContext,correlationId:"handoff-requeue-replay-restored"},
        client=>requeueHandoff(client,requeueInput))).replayed,true);
      const oldClaimReplay=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"claim-replay-after-requeue"},
        client=>claimHandoff(client,{...claimInput,idempotencyKey:winningKey}));
      assert.deepEqual({status:oldClaimReplay.status,version:oldClaimReplay.version,assignedUserId:oldClaimReplay.assignedUserId,
        automationStatus:oldClaimReplay.automationStatus,replayed:oldClaimReplay.replayed},
      {status:"ACTIVE",version:2,assignedUserId:actorAId,automationStatus:"HUMAN_ACTIVE",replayed:true});
      const claimedAgain=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"claim-after-requeue"},client=>claimHandoff(client,
        {handoffId:handoffA.rows[0].id,expectedVersion:3,idempotencyKey:"claim-after-requeue"}));
      assert.equal(claimedAgain.version,4);assert.equal(claimedAgain.replayed,false);
      assert.equal((await target.query("SELECT count(*)::int count FROM outbox_events WHERE event_type='handoff.claimed' AND aggregate_id=$1",
        [handoffA.rows[0].id])).rows[0].count,2);
      const transferTargetId="60000000-0000-4000-8000-000000000099";
      await target.query(`INSERT INTO users(id,tenant_id,email,display_name,status) VALUES($1,'40000000-0000-4000-8000-000000000001','transfer-target@test.local','Transfer Target','ACTIVE')`,[transferTargetId]);
      await target.query(`INSERT INTO user_units(tenant_id,user_id,unit_id,role) SELECT '40000000-0000-4000-8000-000000000001',$1,unit_id,'ATTENDANT' FROM human_handoffs WHERE id=$2`,[transferTargetId,handoffA.rows[0].id]);
      await target.query("UPDATE users SET status='BLOCKED',blocked_at=now() WHERE id=$1",[transferTargetId]);
      assert.deepEqual(await withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-candidates-blocked"},client=>listTransferCandidates(client,handoffA.rows[0].id)),{items:[]});
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-blocked"},client=>transferHandoff(client,
        {handoffId:handoffA.rows[0].id,expectedVersion:4,targetUserId:transferTargetId,reason:"LOAD_BALANCING",idempotencyKey:"handoff-transfer-blocked"})),/HANDOFF_TRANSFER_NOT_FOUND/);
      await target.query("UPDATE users SET status='ACTIVE',blocked_at=NULL WHERE id=$1",[transferTargetId]);
      await target.query(`UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=100,
        pause_reason=NULL,paused_until=NULL WHERE user_id=$1`,[transferTargetId]);
      await target.query("UPDATE user_units SET role='AUDITOR' WHERE user_id=$1",[transferTargetId]);
      assert.deepEqual(await withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-candidates-auditor"},client=>listTransferCandidates(client,handoffA.rows[0].id)),{items:[]});
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE user_id=$1",[transferTargetId]);
      const legacyTransferKey="handoff-transfer-legacy-key";
      const legacyTransferFingerprint=createHash("sha256").update(`{"expectedVersion":4,"handoffId":"${handoffA.rows[0].id.toLowerCase()}","targetUserId":"${transferTargetId.toLowerCase()}"}`).digest("hex");
      await target.query(`INSERT INTO handoff_transfer_commands(tenant_id,idempotency_key,handoff_id,expected_version,target_user_id,
        actor_id,request_fingerprint,conversation_id,service_case_id,handoff_version,conversation_version,correlation_id,unit_id,reason)
        SELECT handoff.tenant_id,$2,handoff.id,4,$3,$4,$5,handoff.conversation_id,handoff.service_case_id,handoff.version,
          conversation.version,'legacy-transfer-fixture',handoff.unit_id,'LEGACY_UNSPECIFIED'
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id WHERE handoff.id=$1`,
      [handoffA.rows[0].id,legacyTransferKey,transferTargetId,actorAId,legacyTransferFingerprint]);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-legacy-replay"},
        client=>transferHandoff(client,{handoffId:handoffA.rows[0].id,expectedVersion:4,targetUserId:transferTargetId,
          reason:"OPERATIONAL_CONTINUITY",idempotencyKey:legacyTransferKey})),/HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-legacy-divergent"},
        client=>transferHandoff(client,{handoffId:handoffA.rows[0].id,expectedVersion:4,targetUserId:actorAId,
          reason:"OPERATIONAL_CONTINUITY",idempotencyKey:legacyTransferKey})),/HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT/);
      await target.query("DELETE FROM handoff_transfer_commands WHERE idempotency_key=$1",[legacyTransferKey]);
      const revokedTransferTargetId="60000000-0000-4000-8000-000000000097";
      await target.query(`INSERT INTO users(id,tenant_id,email,display_name,status)
        VALUES($1,'40000000-0000-4000-8000-000000000001','revoked-transfer-target@test.local','Revoked Transfer Target','ACTIVE')`,
      [revokedTransferTargetId]);
      await target.query(`INSERT INTO user_units(tenant_id,user_id,unit_id,role,status,version,state_changed_at,
        revoked_at,revoked_by_user_id,revocation_reason)
        SELECT '40000000-0000-4000-8000-000000000001',$1,unit_id,'ATTENDANT','REVOKED',1,now(),now(),$2,
          'DB transfer eligibility test' FROM human_handoffs WHERE id=$3`,
      [revokedTransferTargetId,actorAId,handoffA.rows[0].id]);
      assert.deepEqual(await withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-candidates-revoked"},
        client=>listTransferCandidates(client,handoffA.rows[0].id)),{items:[{id:transferTargetId,displayName:"Transfer Target"}]});
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-revoked"},client=>transferHandoff(client,
        {handoffId:handoffA.rows[0].id,expectedVersion:4,targetUserId:revokedTransferTargetId,reason:"LOAD_BALANCING",idempotencyKey:"handoff-transfer-revoked"})),
      /HANDOFF_TRANSFER_NOT_FOUND/);
      const rejectedTransferEvidence=(await target.query(`SELECT
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED' AND aggregate_id IN(handoff.id,conversation.id)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED' AND entity_id=handoff.id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred' AND aggregate_id=handoff.id) outbox,
        (SELECT count(*)::int FROM handoff_transfer_commands WHERE handoff_id=handoff.id) commands
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
        WHERE handoff.id=$1`,[handoffA.rows[0].id])).rows[0];
      assert.deepEqual(rejectedTransferEvidence,{transitions:0,audits:0,outbox:0,commands:0});
      const assertTransferAggregateConflict=async(label,mutate,restore)=>{
        await mutate();
        try {
          await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:`transfer-inconsistent-${label}`},
            client=>transferHandoff(client,{handoffId:handoffA.rows[0].id,expectedVersion:4,
              targetUserId:transferTargetId,reason:"LOAD_BALANCING",idempotencyKey:`handoff-transfer-${label}`})),/HANDOFF_TRANSFER_CONFLICT/);
          const evidence=(await target.query(`SELECT
            (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED'
              AND aggregate_id IN(handoff.id,conversation.id)) transitions,
            (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED' AND entity_id=handoff.id::text) audits,
            (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred' AND aggregate_id=handoff.id) outbox,
            (SELECT count(*)::int FROM handoff_transfer_commands WHERE handoff_id=handoff.id) commands
            FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
            WHERE handoff.id=$1`,[handoffA.rows[0].id])).rows[0];
          assert.deepEqual(evidence,{transitions:0,audits:0,outbox:0,commands:0});
        } finally { await restore(); }
      };
      const updateCorruptFixture=async(sql,values)=>{await target.query("SET session_replication_role=replica");
        try{await target.query(sql,values)}finally{await target.query("SET session_replication_role=origin")}};
      await assertTransferAggregateConflict("closed-conversation",
        ()=>updateCorruptFixture(`UPDATE conversations SET status='CLOSED',closed_at=now() WHERE id=(
          SELECT conversation_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id]),
        ()=>updateCorruptFixture(`UPDATE conversations SET status='OPEN',closed_at=NULL WHERE id=(
          SELECT conversation_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id]));
      const inconsistentUnitId="40000000-0000-4000-8000-000000000097";
      await target.query(`INSERT INTO units(id,tenant_id,code,name)
        VALUES($1,'40000000-0000-4000-8000-000000000001','TRANSFER-INCONSISTENT','Transfer Inconsistent')`,
      [inconsistentUnitId]);
      await target.query(`INSERT INTO user_units(tenant_id,user_id,unit_id,role)
        VALUES('40000000-0000-4000-8000-000000000001',$1,$2,'ATTENDANT')`,[actorAId,inconsistentUnitId]);
      await assertTransferAggregateConflict("conversation-unit",
        ()=>updateCorruptFixture(`UPDATE conversations SET unit_id=$2 WHERE id=(
          SELECT conversation_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id,inconsistentUnitId]),
        ()=>updateCorruptFixture(`UPDATE conversations SET unit_id=(SELECT unit_id FROM human_handoffs WHERE id=$1)
          WHERE id=(SELECT conversation_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id]));
      await assertTransferAggregateConflict("case-unit",
        ()=>updateCorruptFixture(`UPDATE service_cases SET unit_id=$2 WHERE id=(
          SELECT service_case_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id,inconsistentUnitId]),
        ()=>updateCorruptFixture(`UPDATE service_cases SET unit_id=(SELECT unit_id FROM human_handoffs WHERE id=$1)
          WHERE id=(SELECT service_case_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id]));
      const inconsistentConversationId="44000000-0000-4000-8000-000000000097";
      await target.query(`INSERT INTO conversations(id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,status,closed_at)
        SELECT $2,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,'CLOSED',now() FROM conversations
        WHERE id=(SELECT conversation_id FROM human_handoffs WHERE id=$1)`,
      [handoffA.rows[0].id,inconsistentConversationId]);
      await assertTransferAggregateConflict("case-conversation",
        ()=>updateCorruptFixture(`UPDATE service_cases SET conversation_id=$2 WHERE id=(
          SELECT service_case_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id,inconsistentConversationId]),
        ()=>updateCorruptFixture(`UPDATE service_cases SET conversation_id=(SELECT conversation_id FROM human_handoffs WHERE id=$1)
          WHERE id=(SELECT service_case_id FROM human_handoffs WHERE id=$1)`,[handoffA.rows[0].id]));
      await target.query("DELETE FROM conversations WHERE id=$1",[inconsistentConversationId]);
      await target.query("DELETE FROM attendant_availability_commands WHERE user_id=$1 AND unit_id=$2",[actorAId,inconsistentUnitId]);
      await target.query("DELETE FROM attendant_unit_availability WHERE user_id=$1 AND unit_id=$2",[actorAId,inconsistentUnitId]);
      await target.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2",[actorAId,inconsistentUnitId]);
      await target.query("DELETE FROM units WHERE id=$1",[inconsistentUnitId]);
      const candidates=await withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-candidates"},client=>listTransferCandidates(client,handoffA.rows[0].id));
      assert.deepEqual(candidates,{items:[{id:transferTargetId,displayName:"Transfer Target"}]});
      const transferInput={handoffId:handoffA.rows[0].id,expectedVersion:4,targetUserId:transferTargetId,reason:"LOAD_BALANCING",idempotencyKey:"handoff-transfer-key"};
      const transferResults=await Promise.all(Array.from({length:10},(_,index)=>withTenantTransaction(index%2?competingRuntimePool:runtimePool,
        {...claimContext,correlationId:`handoff-transfer-${index}`},client=>transferHandoff(client,transferInput))));
      assert.equal(transferResults.filter(result=>!result.replayed).length,1);assert.ok(transferResults.every(result=>result.handoffVersion===5&&result.targetUserId===transferTargetId));
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-divergent"},client=>transferHandoff(client,
        {...transferInput,targetUserId:actorAId})),/HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-reason-divergent"},client=>transferHandoff(client,
        {...transferInput,reason:"SHIFT_CHANGE"})),/HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-stale"},client=>transferHandoff(client,
        {...transferInput,idempotencyKey:"handoff-transfer-stale"})),/HANDOFF_TRANSFER_NOT_FOUND|HANDOFF_TRANSFER_CONFLICT/);
      const transferEvidence=(await target.query(`SELECT handoff.status,handoff.version,handoff.assigned_user_id,conversation.automation_status,
        conversation.assigned_user_id conversation_owner,service_case.status case_status,service_case.version case_version,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED' AND aggregate_id IN(handoff.id,conversation.id)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED' AND entity_id=handoff.id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred' AND aggregate_id=handoff.id) outbox,
        (SELECT count(*)::int FROM messages WHERE conversation_id=conversation.id AND actor='HERMES') hermes,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=handoff.id AND event_type LIKE 'meta.%') meta,
        (SELECT reason FROM handoff_transfer_commands WHERE idempotency_key='handoff-transfer-key') command_reason
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
        JOIN service_cases service_case ON service_case.id=handoff.service_case_id WHERE handoff.id=$1`,[handoffA.rows[0].id])).rows[0];
      assert.deepEqual(transferEvidence,{status:"ACTIVE",version:5,assigned_user_id:transferTargetId,automation_status:"HUMAN_ACTIVE",conversation_owner:transferTargetId,
        case_status:"IN_REVIEW",case_version:4,transitions:2,audits:1,outbox:1,hermes:0,meta:0,command_reason:"LOAD_BALANCING"});
      const handoffUnitId=(await target.query("SELECT unit_id FROM human_handoffs WHERE id=$1",[handoffA.rows[0].id])).rows[0].unit_id;
      const authorizedTransferReplay=await withTenantTransaction(runtimePool,
        {...claimContext,correlationId:"transfer-authorized-replay"},client=>transferHandoff(client,transferInput));
      assert.equal(authorizedTransferReplay.replayed,true);
      assert.equal(authorizedTransferReplay.handoffVersion,5);
      assert.equal((await target.query(`SELECT unit_id=(SELECT unit_id FROM human_handoffs WHERE id=handoff_id) unit_matches
        FROM handoff_transfer_commands WHERE idempotency_key=$1`,[transferInput.idempotencyKey])).rows[0].unit_matches,true);
      const transferEffectsBeforeRevocation=(await target.query(`SELECT
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED') transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED') audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred') outbox,
        (SELECT count(*)::int FROM handoff_transfer_commands) commands`)).rows[0];
      await target.query(`UPDATE user_units SET status='REVOKED',version=version+1,state_changed_at=now(),revoked_at=now(),
        revoked_by_user_id=$1,revocation_reason='Replay authorization regression' WHERE tenant_id=$2 AND user_id=$1 AND unit_id=$3`,
      [actorAId,claimContext.tenantId,handoffUnitId]);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-revoked-replay"},
        client=>transferHandoff(client,transferInput)),/HANDOFF_TRANSFER_NOT_FOUND/);
      const transferEffectsAfterRevocation=(await target.query(`SELECT
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED') transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED') audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred') outbox,
        (SELECT count(*)::int FROM handoff_transfer_commands) commands`)).rows[0];
      assert.deepEqual(transferEffectsAfterRevocation,transferEffectsBeforeRevocation);
      await target.query(`UPDATE user_units SET status='ACTIVE',version=version+1,state_changed_at=now(),revoked_at=NULL,
        revoked_by_user_id=NULL,revocation_reason=NULL WHERE tenant_id=$2 AND user_id=$1 AND unit_id=$3`,
      [actorAId,claimContext.tenantId,handoffUnitId]);
      await target.query("UPDATE users SET status='BLOCKED',blocked_at=now() WHERE tenant_id=$2 AND id=$1",
        [actorAId,claimContext.tenantId]);
      await assert.rejects(withTenantTransaction(runtimePool,{...claimContext,correlationId:"transfer-blocked-actor-replay"},
        client=>transferHandoff(client,transferInput)),/APP_CONTEXT_UNAUTHORIZED/);
      assert.deepEqual((await target.query(`SELECT
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_TRANSFERRED') transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TRANSFERRED') audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.transferred') outbox,
        (SELECT count(*)::int FROM handoff_transfer_commands) commands`)).rows[0],transferEffectsBeforeRevocation);
      await target.query("UPDATE users SET status='ACTIVE',blocked_at=NULL WHERE tenant_id=$2 AND id=$1",
        [actorAId,claimContext.tenantId]);

      const takeoverActorId="60000000-0000-4000-8000-000000000098";
      await target.query(`INSERT INTO users(id,tenant_id,email,display_name,status)
        VALUES($1,'40000000-0000-4000-8000-000000000001','takeover-manager@test.local','Takeover Manager','ACTIVE')`,[takeoverActorId]);
      await target.query(`INSERT INTO user_units(tenant_id,user_id,unit_id,role)
        VALUES('40000000-0000-4000-8000-000000000001',$1,$2,'UNIT_MANAGER')`,[takeoverActorId,handoffUnitId]);
      await target.query(`UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=100,
        pause_reason=NULL,paused_until=NULL WHERE user_id=$1 AND unit_id=$2`,[takeoverActorId,handoffUnitId]);
      const takeoverFingerprint=(handoffId,expectedVersion)=>createHash("sha256")
        .update(`{"expectedVersion":${expectedVersion},"handoffId":"${handoffId.toLowerCase()}"}`).digest("hex");
      const callTakeover=(pool,actorId,input,correlationId)=>withTenantTransaction(pool,{
        tenantId:"40000000-0000-4000-8000-000000000001",actorId,correlationId,
      },async client=>(await client.query("SELECT * FROM takeover_inbox_handoff($1,$2,$3,$4)",[
        input.handoffId,input.expectedVersion,input.idempotencyKey,
        takeoverFingerprint(input.handoffId,input.expectedVersion),
      ])).rows[0]);
      const takeoverInput={handoffId:handoffA.rows[0].id,expectedVersion:5,idempotencyKey:"handoff-takeover-key"};
      await assert.rejects(callTakeover(runtimePool,actorAId,takeoverInput,"takeover-attendant-denied"),
        /HANDOFF_TAKEOVER_NOT_FOUND/);
      const takeoverPendingMessage="6f000000-0000-4000-8000-000000000098";
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,body,payload,delivery_status)
        SELECT $1,tenant_id,id,'OUTBOUND','HUMAN','Pending takeover fence','{}','QUEUED'
        FROM conversations WHERE id=(SELECT conversation_id FROM human_handoffs WHERE id=$2)`,
      [takeoverPendingMessage,handoffA.rows[0].id]);
      await assert.rejects(callTakeover(runtimePool,takeoverActorId,takeoverInput,"takeover-pending-outbound"),
        /HANDOFF_TAKEOVER_PENDING_OUTBOUND/);
      await target.query("DELETE FROM messages WHERE id=$1",[takeoverPendingMessage]);
      const takeoverResults=await Promise.all(Array.from({length:8},(_,index)=>callTakeover(
        index%2?competingRuntimePool:runtimePool,takeoverActorId,takeoverInput,`takeover-concurrent-${index}`)));
      assert.equal(takeoverResults.filter(result=>!result.replayed).length,1);
      assert.ok(takeoverResults.every(result=>result.handoff_version===6
        &&result.previous_assigned_user_id===transferTargetId));
      await assert.rejects(callTakeover(runtimePool,takeoverActorId,
        {...takeoverInput,expectedVersion:6},"takeover-divergent"),/HANDOFF_TAKEOVER_IDEMPOTENCY_CONFLICT/);
      const takeoverEvidence=(await target.query(`SELECT handoff.status,handoff.version,handoff.assigned_user_id,
        conversation.automation_status,conversation.assigned_user_id conversation_owner,service_case.status case_status,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='SUPERVISOR_TAKEOVER'
          AND aggregate_id IN(handoff.id,conversation.id)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_TAKEN_OVER' AND entity_id=handoff.id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.taken_over' AND aggregate_id=handoff.id) outbox,
        (SELECT count(*)::int FROM messages WHERE conversation_id=conversation.id AND actor='HERMES') hermes
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
        JOIN service_cases service_case ON service_case.id=handoff.service_case_id WHERE handoff.id=$1`,
      [handoffA.rows[0].id])).rows[0];
      assert.deepEqual(takeoverEvidence,{status:"ACTIVE",version:6,assigned_user_id:takeoverActorId,
        automation_status:"HUMAN_ACTIVE",conversation_owner:takeoverActorId,case_status:"IN_REVIEW",
        transitions:2,audits:1,outbox:1,hermes:0});

      await target.query("UPDATE user_units SET role='UNIT_MANAGER' WHERE user_id=$1 AND unit_id=$2",
        [transferTargetId,handoffUnitId]);
      const membershipFingerprint=({userId,unitId,expectedVersion,operation,reason})=>unitMembershipFingerprint({
        userId:userId.toLowerCase(),unitId:unitId.toLowerCase(),expectedVersion,operation,reason:reason.trim(),
      });
      const callMembership=(input,correlationId,fingerprint=membershipFingerprint(input))=>withTenantTransaction(runtimePool,{
        tenantId:"40000000-0000-4000-8000-000000000001",actorId:takeoverActorId,correlationId,
      },async client=>(await client.query("SELECT * FROM admin_change_unit_membership($1,$2,$3,$4,$5,$6,$7)",[
        input.idempotencyKey,fingerprint,input.userId,input.unitId,input.expectedVersion,input.operation,input.reason,
      ])).rows[0]);
      const revokeMembership={idempotencyKey:"membership-revoke-key",userId:transferTargetId,unitId:handoffUnitId,
        expectedVersion:1,operation:"REVOKE",reason:"Operational access removed"};
      await assert.rejects(callMembership(revokeMembership,"membership-invalid-fingerprint",Buffer.alloc(32,0)),
        /INVALID_MEMBERSHIP_LIFECYCLE_REQUEST/);
      const beforeRevokePermission=await withTenantTransaction(runtimePool,{
        tenantId:"40000000-0000-4000-8000-000000000001",actorId:transferTargetId,correlationId:"membership-before-revoke",
      },async client=>(await client.query("SELECT current_actor_has_permission('unit.members.manage',$1) allowed",[handoffUnitId])).rows[0].allowed);
      assert.equal(beforeRevokePermission,true);
      const revokedMembership=await callMembership(revokeMembership,"membership-revoke");
      assert.deepEqual(revokedMembership,{user_id:transferTargetId,unit_id:handoffUnitId,status:"REVOKED",version:2,replayed:false});
      const listUnitMembershipCatalog=(actorId,unitId,anchorDisplayName=null,anchorUserId=null,limit=101)=>
        withTenantTransaction(runtimePool,{
          tenantId:"40000000-0000-4000-8000-000000000001",actorId,
          correlationId:`unit-membership-catalog-${actorId}-${unitId}`,
        },async client=>(await client.query("SELECT * FROM admin_list_unit_memberships($1,$2,$3,$4)",[
          unitId,anchorDisplayName,anchorUserId,limit,
        ])).rows);
      const revokedCatalog=await listUnitMembershipCatalog(takeoverActorId,handoffUnitId);
      const revokedCatalogTarget=revokedCatalog.find(row=>row.user_id===transferTargetId);
      assert.deepEqual(revokedCatalogTarget,{
        user_id:transferTargetId,display_name:"Transfer Target",role:"UNIT_MANAGER",status:"REVOKED",
        version:2,allowed_actions:["REACTIVATE"],
      });
      assert.ok(revokedCatalog.every(row=>!("email" in row)&&!("tenant_id" in row)));
      assert.ok(!revokedCatalog.some(row=>row.role==="TENANT_ADMIN"));
      const firstCatalogRow=revokedCatalog[0];
      const anchoredCatalog=await listUnitMembershipCatalog(takeoverActorId,handoffUnitId,
        firstCatalogRow.display_name,firstCatalogRow.user_id);
      assert.deepEqual(anchoredCatalog,revokedCatalog.slice(1));
      const otherUnitId="40000000-0000-4000-8000-000000000099";
      await target.query(`INSERT INTO units(id,tenant_id,code,name)
        VALUES($1,'40000000-0000-4000-8000-000000000001','CATALOG-OTHER','Catalog Other Unit')`,[otherUnitId]);
      assert.deepEqual(await listUnitMembershipCatalog(takeoverActorId,otherUnitId),[]);
      assert.deepEqual(await listUnitMembershipCatalog(takeoverActorId,"40000000-0000-4000-8000-000000000098"),[]);
      await target.query("UPDATE user_units SET role='SUPERVISOR' WHERE user_id=$1 AND unit_id=$2",
        [actorAId,handoffUnitId]);
      assert.deepEqual(await listUnitMembershipCatalog(actorAId,handoffUnitId),[]);
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE user_id=$1 AND unit_id=$2",
        [actorAId,handoffUnitId]);
      assert.equal((await callMembership(revokeMembership,"membership-revoke-replay")).replayed,true);
      const divergentMembership={...revokeMembership,reason:"Different lifecycle reason"};
      await assert.rejects(callMembership(divergentMembership,"membership-revoke-divergent"),
        /MEMBERSHIP_IDEMPOTENCY_CONFLICT/);
      const afterRevokePermission=await withTenantTransaction(runtimePool,{
        tenantId:"40000000-0000-4000-8000-000000000001",actorId:transferTargetId,correlationId:"membership-after-revoke",
      },async client=>(await client.query("SELECT current_actor_has_permission('unit.members.manage',$1) allowed",[handoffUnitId])).rows[0].allowed);
      assert.equal(afterRevokePermission,false);
      const reactivateMembership={idempotencyKey:"membership-reactivate-key",userId:transferTargetId,unitId:handoffUnitId,
        expectedVersion:2,operation:"REACTIVATE",reason:"Operational access restored"};
      assert.deepEqual(await callMembership(reactivateMembership,"membership-reactivate"),
        {user_id:transferTargetId,unit_id:handoffUnitId,status:"ACTIVE",version:3,replayed:false});
      const activeCatalog=await listUnitMembershipCatalog(takeoverActorId,handoffUnitId);
      assert.deepEqual(activeCatalog.find(row=>row.user_id===transferTargetId),{
        user_id:transferTargetId,display_name:"Transfer Target",role:"UNIT_MANAGER",status:"ACTIVE",
        version:3,allowed_actions:["REVOKE"],
      });
      assert.deepEqual((await target.query(`SELECT
        has_function_privilege('zap_pronto_api','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','admin_list_unit_memberships(uuid,text,uuid,integer)','EXECUTE') app,
        NOT EXISTS(SELECT 1 FROM information_schema.routine_privileges
          WHERE routine_name='admin_list_unit_memberships' AND grantee='PUBLIC') public_revoked`)).rows[0],
      {api:true,worker:false,app:false,public_revoked:true});
      await target.query("UPDATE human_handoffs SET assigned_user_id=$1 WHERE id=$2",
        [transferTargetId,handoffA.rows[0].id]);
      await target.query(`UPDATE conversations SET assigned_user_id=$1
        WHERE id=(SELECT conversation_id FROM human_handoffs WHERE id=$2)`,
      [transferTargetId,handoffA.rows[0].id]);
      const activeWorkRevoke={idempotencyKey:"membership-active-work",userId:transferTargetId,unitId:handoffUnitId,
        expectedVersion:3,operation:"REVOKE",reason:"Must reject active ownership"};
      await assert.rejects(callMembership(activeWorkRevoke,"membership-active-work"),/MEMBERSHIP_HAS_ACTIVE_WORK/);
      await target.query("UPDATE human_handoffs SET assigned_user_id=$1 WHERE id=$2",
        [takeoverActorId,handoffA.rows[0].id]);
      await target.query(`UPDATE conversations SET assigned_user_id=$1
        WHERE id=(SELECT conversation_id FROM human_handoffs WHERE id=$2)`,
      [takeoverActorId,handoffA.rows[0].id]);
      /* The trigger and lifecycle command must serialize in both directions. */
      const serializationKey=`${claimContext.tenantId}:membership-lifecycle`;
      const lockFirst=new pg.Client({connectionString:targetUrl.toString()});await lockFirst.connect();
      const assignSecond=new pg.Client({connectionString:targetUrl.toString()});await assignSecond.connect();
      try {
        await lockFirst.query("BEGIN");
        await lockFirst.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[serializationKey]);
        await assignSecond.query("BEGIN");
        const blockedAssignment=assignSecond.query("UPDATE human_handoffs SET assigned_user_id=$1 WHERE id=$2",
          [transferTargetId,handoffA.rows[0].id]);
        await new Promise(resolve=>setTimeout(resolve,50));
        await lockFirst.query(`UPDATE user_units SET status='REVOKED',version=version+1,state_changed_at=now(),
          revoked_at=now(),revoked_by_user_id=$1,revocation_reason='Concurrent serialization test'
          WHERE tenant_id=$2 AND user_id=$3 AND unit_id=$4`,[takeoverActorId,claimContext.tenantId,transferTargetId,handoffUnitId]);
        await lockFirst.query("COMMIT");
        await assert.rejects(blockedAssignment,/ASSIGNEE_NOT_ELIGIBLE/);
        await assignSecond.query("ROLLBACK");
        assert.deepEqual((await target.query(`SELECT membership.status,handoff.assigned_user_id
          FROM user_units membership JOIN human_handoffs handoff ON handoff.id=$1
          WHERE membership.tenant_id=$2 AND membership.user_id=$3 AND membership.unit_id=$4`,
        [handoffA.rows[0].id,claimContext.tenantId,transferTargetId,handoffUnitId])).rows[0],
        {status:"REVOKED",assigned_user_id:takeoverActorId});
      } finally { await lockFirst.query("ROLLBACK").catch(()=>undefined);await lockFirst.end();await assignSecond.end(); }
      await target.query(`UPDATE user_units SET status='ACTIVE',version=version+1,state_changed_at=now(),
        revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL WHERE tenant_id=$1 AND user_id=$2 AND unit_id=$3`,
      [claimContext.tenantId,transferTargetId,handoffUnitId]);
      const assignFirst=new pg.Client({connectionString:targetUrl.toString()});await assignFirst.connect();
      const lifecycleSecond=await competingRuntimePool.connect();
      try {
        await assignFirst.query("BEGIN");
        await assignFirst.query("UPDATE human_handoffs SET assigned_user_id=$1 WHERE id=$2",[transferTargetId,handoffA.rows[0].id]);
        await lifecycleSecond.query("BEGIN");
        await lifecycleSecond.query("SET LOCAL ROLE zap_pronto_api");
        await lifecycleSecond.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),
          set_config('app.correlation_id','membership-serialization-reverse',true)`,[claimContext.tenantId,takeoverActorId]);
        const blockedLifecycle=lifecycleSecond.query("SELECT * FROM admin_change_unit_membership($1,$2,$3,$4,$5,$6,$7)",[
          "membership-serialization-reverse-key",membershipFingerprint({idempotencyKey:"ignored",userId:transferTargetId,
            unitId:handoffUnitId,expectedVersion:5,operation:"REVOKE",reason:"Concurrent reverse serialization"}),
          transferTargetId,handoffUnitId,5,"REVOKE","Concurrent reverse serialization"]);
        await new Promise(resolve=>setTimeout(resolve,50));
        await assignFirst.query("COMMIT");
        await assert.rejects(blockedLifecycle,/MEMBERSHIP_HAS_ACTIVE_WORK/);
        await lifecycleSecond.query("ROLLBACK");
        assert.deepEqual((await target.query(`SELECT membership.status,handoff.assigned_user_id
          FROM user_units membership JOIN human_handoffs handoff ON handoff.id=$1
          WHERE membership.tenant_id=$2 AND membership.user_id=$3 AND membership.unit_id=$4`,
        [handoffA.rows[0].id,claimContext.tenantId,transferTargetId,handoffUnitId])).rows[0],
        {status:"ACTIVE",assigned_user_id:transferTargetId});
      } finally { await assignFirst.query("ROLLBACK").catch(()=>undefined);await assignFirst.end();lifecycleSecond.release(); }
      await target.query("UPDATE human_handoffs SET assigned_user_id=$1 WHERE id=$2",[takeoverActorId,handoffA.rows[0].id]);
      const membershipEvidence=(await target.query(`SELECT membership.status,membership.version,
        (SELECT count(*)::int FROM audit_events WHERE action IN('UNIT_MEMBERSHIP_REVOKE','UNIT_MEMBERSHIP_REACTIVATE')
          AND entity_id=membership.user_id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='user_membership'
          AND aggregate_id=membership.user_id) outbox
        FROM user_units membership WHERE membership.user_id=$1 AND membership.unit_id=$2`,
      [transferTargetId,handoffUnitId])).rows[0];
      assert.deepEqual(membershipEvidence,{status:"ACTIVE",version:5,audits:2,outbox:2});
      assert.deepEqual((await target.query(`SELECT
        has_function_privilege('zap_pronto_api','requeue_inbox_handoff(uuid,integer,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','requeue_inbox_handoff(uuid,integer,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','requeue_inbox_handoff(uuid,integer,text)','EXECUTE') app,
        has_table_privilege('zap_pronto_api','handoff_requeue_commands','SELECT') command_select`)).rows[0],
      {api:true,worker:false,app:false,command_select:false});
      assert.deepEqual((await target.query(`SELECT
        has_function_privilege('zap_pronto_api','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','transfer_inbox_handoff(uuid,integer,uuid,text,text,text)','EXECUTE') app,
        has_function_privilege('zap_pronto_api','transfer_inbox_handoff(uuid,integer,uuid,text,text)','EXECUTE') legacy_api,
        has_table_privilege('zap_pronto_api','handoff_transfer_commands','SELECT') command_select`)).rows[0],
      {api:true,worker:false,app:false,legacy_api:false,command_select:false});

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
      assert.equal(
        concurrentHandoffRequests.filter((result) => result.status === "fulfilled").length,
        2,
        concurrentHandoffRequests.map((result) => result.status === "rejected"
          ? String(result.reason?.message ?? result.reason)
          : "FULFILLED").join(" | "),
      );
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

      const cursorAnchor = await target.query(`
        SELECT id, unit_id, queued_at, sla_due_at,
          CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END AS priority
        FROM human_handoffs WHERE id=$1
      `, [requestedHandoff.id]);
      const anchor = cursorAnchor.rows[0];
      const cursorAsOf = new Date().toISOString();
      const validCursor = Buffer.from(JSON.stringify({ v: 2, unitId: anchor.unit_id,
        priorityFilter: null, slaStatusFilter: null, asOf: cursorAsOf, priorityRank: anchor.priority,
        slaMissing: anchor.sla_due_at === null, slaDueAt: anchor.sla_due_at?.toISOString() ?? null,
        queuedAt: anchor.queued_at.toISOString(), id: anchor.id })).toString("base64url");
      const pageAfterAnchor = await withTenantTransaction(runtimePool, {
        tenantId: "50000000-0000-4000-8000-000000000002", actorId: actorBId,
        correlationId: "handoff-cursor-valid-anchor",
      }, (client) => listHandoffs(client, { unitId: anchor.unit_id, cursor: validCursor }));
      assert.deepEqual(pageAfterAnchor.items, []);
      const forgedCursor = Buffer.from(JSON.stringify({ v: 2, unitId: anchor.unit_id,
        priorityFilter: null, slaStatusFilter: null, asOf: cursorAsOf, priorityRank: anchor.priority,
        slaMissing: anchor.sla_due_at === null, slaDueAt: anchor.sla_due_at?.toISOString() ?? null,
        queuedAt: anchor.queued_at.toISOString(), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })).toString("base64url");
      await assert.rejects(withTenantTransaction(runtimePool, {
        tenantId: "50000000-0000-4000-8000-000000000002", actorId: actorBId,
        correlationId: "handoff-cursor-forged-anchor",
      }, (client) => listHandoffs(client, { unitId: anchor.unit_id, cursor: forgedCursor })),
      /INVALID_PAGE_CURSOR/);

      await target.query(`UPDATE channel_connections SET status='ACTIVE'
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND external_account_id='account-b'`);
      const inboundEnvelope = normalizeWhatsAppInbound({ entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "account-b" },
        messages: [{ id: "wamid.db-inbound-b", from: "sender-b", timestamp: "1786381200",
          type: "text", text: { body: "Mensagem sintética" } }],
      } }] }] })[0];
      const concurrentInbound = await Promise.all([
        acceptInboundEnvelope(runtimePool, inboundEnvelope, "inbound-accept-b-concurrent-1"),
        acceptInboundEnvelope(competingRuntimePool, inboundEnvelope, "inbound-accept-b-concurrent-2"),
      ]);
      assert.deepEqual(concurrentInbound.map((result) => result.replayed).sort(), [false, true]);
      assert.equal(concurrentInbound[0].id, concurrentInbound[1].id);
      const inboundReceiptCount = await target.query(`SELECT count(*)::int AS count
        FROM inbound_channel_events
        WHERE tenant_id='50000000-0000-4000-8000-000000000002'
          AND provider='META_WHATSAPP' AND provider_event_id='wamid.db-inbound-b'
          AND channel_account_id='account-b'`);
      assert.equal(inboundReceiptCount.rows[0].count, 1);
      const sequentialReplay = await acceptInboundEnvelope(runtimePool, inboundEnvelope, "inbound-sequential-replay-b");
      assert.equal(sequentialReplay.replayed, true);
      const routedOutbox = await target.query(`SELECT payload,idempotency_key FROM outbox_events
        WHERE tenant_id='50000000-0000-4000-8000-000000000002'
          AND event_type='channel.inbound.received' AND aggregate_id=$1`, [concurrentInbound[0].id]);
      assert.equal(routedOutbox.rowCount, 1);
      assert.deepEqual(Object.keys(routedOutbox.rows[0].payload).sort(),
        ["channelConnectionId","kind","provider","receiptId","routingStatus","unitId"]);
      assert.deepEqual(routedOutbox.rows[0].payload, {
        receiptId: concurrentInbound[0].id, provider: "META_WHATSAPP", kind: "TEXT",
        channelConnectionId: concurrentInbound[0].channelConnectionId, unitId: concurrentInbound[0].unitId,
        routingStatus: "ROUTED",
      });
      assert.equal(routedOutbox.rows[0].idempotency_key, `channel.inbound.received:${concurrentInbound[0].id}`);
      assert.doesNotMatch(JSON.stringify(routedOutbox.rows[0].payload), /sender-b|Mensagem sintética|wamid|account-b/);
      const firstInboundLease="97000000-0000-4000-8000-000000000101";
      const firstInboundOutboxId=await leaseInboundOutbox(concurrentInbound[0].id,firstInboundLease);
      const firstMaterialized=await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",
        actorBId,firstInboundOutboxId,firstInboundLease);
      assert.equal(firstMaterialized.replayed,false);
      const firstMaterializedEvidence=await target.query(`SELECT message.direction,message.actor,message.body,
        message.payload,message.source_inbound_event_id,conversation.automation_status,conversation.status,
        identity.external_user_id,contact.display_name,contact.phone_e164
        FROM messages message JOIN conversations conversation ON conversation.tenant_id=message.tenant_id
          AND conversation.id=message.conversation_id
        JOIN contact_identities identity ON identity.tenant_id=conversation.tenant_id
          AND identity.id=conversation.contact_identity_id
        JOIN contacts contact ON contact.tenant_id=identity.tenant_id AND contact.id=identity.contact_id
        WHERE message.tenant_id='50000000-0000-4000-8000-000000000002'
          AND message.source_inbound_event_id=$1`,[concurrentInbound[0].id]);
      assert.deepEqual(firstMaterializedEvidence.rows[0],{
        direction:"INBOUND",actor:"CUSTOMER",body:"Mensagem sintética",
        payload:{kind:"TEXT",trust:"UNTRUSTED"},source_inbound_event_id:concurrentInbound[0].id,
        automation_status:"ACTIVE",status:"OPEN",external_user_id:"sender-b",display_name:null,phone_e164:null,
      });

      const replayLease="97000000-0000-4000-8000-000000000102";
      await leaseInboundOutbox(concurrentInbound[0].id,replayLease);
      const replayMaterialized=await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",
        actorBId,firstInboundOutboxId,replayLease);
      assert.equal(replayMaterialized.replayed,true);
      assert.deepEqual([replayMaterialized.contactId,replayMaterialized.contactIdentityId,
        replayMaterialized.conversationId,replayMaterialized.messageId],
      [firstMaterialized.contactId,firstMaterialized.contactIdentityId,firstMaterialized.conversationId,
        firstMaterialized.messageId]);

      const concurrentReplayLease="97000000-0000-4000-8000-000000000103";
      await leaseInboundOutbox(concurrentInbound[0].id,concurrentReplayLease);
      const concurrentMaterializations=await Promise.allSettled(Array.from({length:20},()=>
        materializeInbound(concurrentMaterializerPool,"50000000-0000-4000-8000-000000000002",actorBId,
          firstInboundOutboxId,concurrentReplayLease)));
      assert.equal(concurrentMaterializations.filter(result=>result.status==="fulfilled").length,1);
      assert.equal(concurrentMaterializations.filter(result=>result.status==="rejected").length,19);
      const afterConcurrentReplay=await target.query(`SELECT
        (SELECT count(*)::int FROM messages WHERE source_inbound_event_id=$1) AS messages,
        (SELECT count(*)::int FROM contacts WHERE tenant_id='50000000-0000-4000-8000-000000000002'
          AND id=$2) AS contacts`,[concurrentInbound[0].id,firstMaterialized.contactId]);
      assert.deepEqual(afterConcurrentReplay.rows[0],{messages:1,contacts:1});

      const secondSameSender=await acceptInboundEnvelope(runtimePool,
        {...inboundEnvelope,providerEventId:"wamid.db-inbound-b-second"},"inbound-second-same-sender-b");
      const secondLease="97000000-0000-4000-8000-000000000104";
      const secondOutboxId=await leaseInboundOutbox(secondSameSender.id,secondLease);
      const secondMaterialized=await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",
        actorBId,secondOutboxId,secondLease);
      assert.deepEqual([secondMaterialized.contactId,secondMaterialized.contactIdentityId,secondMaterialized.conversationId],
        [firstMaterialized.contactId,firstMaterialized.contactIdentityId,firstMaterialized.conversationId]);
      assert.notEqual(secondMaterialized.messageId,firstMaterialized.messageId);

      const concurrentSenderReceipts=await Promise.all(["one","two"].map(label=>acceptInboundEnvelope(runtimePool,
        {...inboundEnvelope,providerEventId:`wamid.db-inbound-b-concurrent-${label}`},
        `inbound-sender-concurrent-${label}`)));
      const concurrentSenderLeases=["97000000-0000-4000-8000-000000000105","97000000-0000-4000-8000-000000000106"];
      const concurrentSenderOutboxes=await Promise.all(concurrentSenderReceipts.map((receipt,index)=>
        leaseInboundOutbox(receipt.id,concurrentSenderLeases[index])));
      const concurrentSenderMessages=await Promise.all(concurrentSenderOutboxes.map((outboxId,index)=>
        materializeInbound(index===0?workerPool:competingWorkerPool,"50000000-0000-4000-8000-000000000002",
          actorBId,outboxId,concurrentSenderLeases[index])));
      assert.equal(new Set(concurrentSenderMessages.map(result=>result.contactId)).size,1);
      assert.equal(new Set(concurrentSenderMessages.map(result=>result.contactIdentityId)).size,1);
      assert.equal(new Set(concurrentSenderMessages.map(result=>result.conversationId)).size,1);
      assert.equal(new Set(concurrentSenderMessages.map(result=>result.messageId)).size,2);

      const guardedLease="97000000-0000-4000-8000-000000000107";
      await leaseInboundOutbox(concurrentInbound[0].id,guardedLease);
      await assert.rejects(materializeInbound(workerPool,"40000000-0000-4000-8000-000000000001",actorAId,
        firstInboundOutboxId,guardedLease),/INBOUND_MATERIALIZATION_LEASE_REJECTED/);
      await assert.rejects(materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        firstInboundOutboxId,"97000000-0000-4000-8000-000000000199"),/INBOUND_MATERIALIZATION_LEASE_REJECTED/);
      assert.equal((await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        firstInboundOutboxId,guardedLease)).replayed,true);
      const staleLease="97000000-0000-4000-8000-000000000108";
      await leaseInboundOutbox(concurrentInbound[0].id,staleLease,-1);
      await assert.rejects(materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        firstInboundOutboxId,staleLease),/INBOUND_MATERIALIZATION_LEASE_REJECTED/);
      await target.query(`UPDATE outbox_events SET status='PUBLISHED',published_at=clock_timestamp(),lease_token=NULL,
        leased_at=NULL,lease_expires_at=NULL WHERE id=$1`,[firstInboundOutboxId]);

      await target.query("UPDATE conversations SET automation_status='HUMAN_REQUESTED' WHERE id=$1",
        [firstMaterialized.conversationId]);
      await target.query("UPDATE conversations SET automation_status='HUMAN_QUEUED' WHERE id=$1",
        [firstMaterialized.conversationId]);
      const queuedReceipt=await acceptInboundEnvelope(runtimePool,
        {...inboundEnvelope,providerEventId:"wamid.human-queued-b"},"inbound-human-queued-b");
      const queuedLease="97000000-0000-4000-8000-000000000109";
      const queuedOutbox=await leaseInboundOutbox(queuedReceipt.id,queuedLease);
      await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,queuedOutbox,queuedLease);
      assert.deepEqual((await target.query("SELECT automation_status,assigned_user_id FROM conversations WHERE id=$1",
        [firstMaterialized.conversationId])).rows[0],{automation_status:"HUMAN_QUEUED",assigned_user_id:null});
      await target.query("UPDATE conversations SET automation_status='HUMAN_ACTIVE',assigned_user_id=$2 WHERE id=$1",
        [firstMaterialized.conversationId,actorBId]);
      const activeReceipt=await acceptInboundEnvelope(runtimePool,
        {...inboundEnvelope,providerEventId:"wamid.human-active-b"},"inbound-human-active-b");
      const activeLease="97000000-0000-4000-8000-00000000010a";
      const activeOutbox=await leaseInboundOutbox(activeReceipt.id,activeLease);
      await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,activeOutbox,activeLease);
      assert.deepEqual((await target.query("SELECT automation_status,assigned_user_id FROM conversations WHERE id=$1",
        [firstMaterialized.conversationId])).rows[0],{automation_status:"HUMAN_ACTIVE",assigned_user_id:actorBId});

      const readerId="7a000000-0000-4000-8000-000000000005";const unitB=(await target.query("SELECT unit_id FROM conversations WHERE id=$1",[firstMaterialized.conversationId])).rows[0].unit_id;
      await target.query("INSERT INTO users(id,tenant_id,email,display_name) VALUES($1,'50000000-0000-4000-8000-000000000002','reader-b@test.local','Reader B')",[readerId]);
      await target.query("INSERT INTO user_units(tenant_id,user_id,unit_id,role) VALUES('50000000-0000-4000-8000-000000000002',$1,$2,'ATTENDANT')",[readerId,unitB]);
      const snapshotBefore=(await target.query("SELECT (SELECT count(*)::int FROM messages) messages,(SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM audit_events) audit")).rows[0];
      const ownerDetail=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"conversation-owner"},
        client=>getConversation(client,firstMaterialized.conversationId));assert.equal(ownerDetail.assignedUserId,actorBId);
      const ownerMessages=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"conversation-history"},
        client=>listConversationMessages(client,{conversationId:firstMaterialized.conversationId,limit:1}));assert.equal(ownerMessages.items.length,1);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:readerId,correlationId:"conversation-other-attendant"},
        client=>getConversation(client,firstMaterialized.conversationId)),/INBOX_CONVERSATION_NOT_FOUND/);
      for(const role of["SUPERVISOR","UNIT_MANAGER","TENANT_ADMIN"]){await target.query("UPDATE user_units SET role=$2 WHERE user_id=$1",[readerId,role]);
        const visible=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:readerId,correlationId:`conversation-${role}`},
          client=>getConversation(client,firstMaterialized.conversationId));assert.equal(visible.conversationId,firstMaterialized.conversationId);}
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE user_id=$1",[readerId]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"40000000-0000-4000-8000-000000000001",actorId:actorAId,correlationId:"conversation-cross-tenant"},
        client=>getConversation(client,firstMaterialized.conversationId)),/INBOX_CONVERSATION_NOT_FOUND/);
      const unitlessId="7b000000-0000-4000-8000-000000000006";await target.query(`INSERT INTO conversations(id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id)
        SELECT $1,tenant_id,channel_connection_id,contact_id,contact_identity_id,NULL FROM conversations WHERE id=$2`,[unitlessId,firstMaterialized.conversationId]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"conversation-unitless"},
        client=>getConversation(client,unitlessId)),/INBOX_CONVERSATION_NOT_FOUND/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"conversation-bad-anchor"},
        client=>client.query("SELECT * FROM list_inbox_conversation_messages($1,25,now(),$2)",[firstMaterialized.conversationId,"ffffffff-ffff-4fff-8fff-ffffffffffff"])),/INVALID_PAGE_CURSOR/);
      const privileges=await target.query(`SELECT has_function_privilege('zap_pronto_api','get_inbox_conversation(uuid)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','get_inbox_conversation(uuid)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','get_inbox_conversation(uuid)','EXECUTE') app,
        NOT EXISTS(SELECT 1 FROM information_schema.routine_privileges WHERE routine_name='get_inbox_conversation' AND grantee='PUBLIC') public_revoked,
        has_function_privilege('zap_pronto_api','get_inbox_conversation_claim_target(uuid)','EXECUTE') target_api,
        has_function_privilege('zap_pronto_worker','get_inbox_conversation_claim_target(uuid)','EXECUTE') target_worker,
        has_function_privilege('zap_pronto_app','get_inbox_conversation_claim_target(uuid)','EXECUTE') target_app,
        NOT EXISTS(SELECT 1 FROM information_schema.routine_privileges WHERE routine_name='get_inbox_conversation_claim_target' AND grantee='PUBLIC') target_public_revoked`);
      assert.deepEqual(privileges.rows[0],{api:true,worker:false,app:false,public_revoked:true,target_api:true,target_worker:false,target_app:false,target_public_revoked:true});
      const snapshotAfter=(await target.query("SELECT (SELECT count(*)::int FROM messages) messages,(SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM audit_events) audit")).rows[0];assert.deepEqual(snapshotAfter,snapshotBefore);

      const sendCaseId="7c000000-0000-4000-8000-000000000007",sendHandoffId="7c000000-0000-4000-8000-000000000008";
      await target.query(`UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=100,
        pause_reason=NULL,paused_until=NULL WHERE tenant_id=$1 AND user_id=$2 AND unit_id=$3`,
        ["50000000-0000-4000-8000-000000000002",actorBId,unitB]);
      await target.query(`INSERT INTO service_cases(id,tenant_id,conversation_id,unit_id,kind,status)
        VALUES($1,'50000000-0000-4000-8000-000000000002',$2,$3,'HUMAN_TEXT_TEST','IN_REVIEW')`,[sendCaseId,firstMaterialized.conversationId,unitB]);
      await target.query(`INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,assigned_user_id,idempotency_key,queued_at,claimed_at)
        VALUES($1,'50000000-0000-4000-8000-000000000002',$2,$3,$4,'TEST','NORMAL','ACTIVE',$5,'human-text-test',clock_timestamp(),clock_timestamp())`,
        [sendHandoffId,firstMaterialized.conversationId,sendCaseId,unitB,actorBId]);
      const beforeSend=await target.query(`SELECT conversation.version,(SELECT count(*)::int FROM messages WHERE conversation_id=conversation.id) messages,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='channel.outbound.requested') outbox,
        (SELECT count(*)::int FROM audit_events WHERE action='HUMAN_TEXT_MESSAGE_QUEUED') audit
        FROM conversations conversation WHERE id=$1`,[firstMaterialized.conversationId]);const sendVersion=beforeSend.rows[0].version;
      const sent=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-send"},
        client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:sendVersion,body:"  Resposta humana\n",idempotencyKey:"  human-text-key-1  "}));
      assert.equal(sent.deliveryStatus,"QUEUED");assert.equal(sent.replayed,false);
      const replay=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-replay"},
        client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:sendVersion,body:"Resposta humana",idempotencyKey:"human-text-key-1"}));
      assert.equal(replay.replayed,true);assert.equal(replay.messageId,sent.messageId);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-divergent"},
        client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:sendVersion,body:"Outro texto",idempotencyKey:"human-text-key-1"})),/MESSAGE_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:readerId,correlationId:"human-text-other-owner"},
        client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:sendVersion+1,body:"Não autorizado",idempotencyKey:"human-text-key-reader"})),/(MESSAGE_SEND_STATE_CONFLICT|INBOX_CONVERSATION_NOT_FOUND)/);
      const sendEvidence=await target.query(`SELECT message.body,message.direction,message.actor,message.external_message_id,message.delivery_status,message.payload,
        conversation.version,handoff.first_human_response_at IS NOT NULL first_response,
        (SELECT count(*)::int FROM outbox_events event WHERE event.aggregate_id=message.id AND event.event_type='channel.outbound.requested' AND event.status='PENDING') outbox,
        (SELECT count(*)::int FROM audit_events audit WHERE audit.entity_id=message.id::text AND audit.action='HUMAN_TEXT_MESSAGE_QUEUED') audit,
        (SELECT bool_and(NOT payload::text~'(Resposta humana|external|recipient|secret)') FROM outbox_events event WHERE event.aggregate_id=message.id) outbox_safe,
        (SELECT bool_and(NOT metadata::text~'(Resposta humana|human-text-key|fingerprint)') FROM audit_events audit WHERE audit.entity_id=message.id::text) audit_safe
        FROM messages message JOIN conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
        JOIN human_handoffs handoff ON handoff.tenant_id=conversation.tenant_id AND handoff.conversation_id=conversation.id AND handoff.status='ACTIVE'
        WHERE message.id=$1`,[sent.messageId]);
      assert.deepEqual(sendEvidence.rows[0],{body:"Resposta humana",direction:"OUTBOUND",actor:"HUMAN",external_message_id:null,delivery_status:"QUEUED",payload:{kind:"TEXT"},
        version:sendVersion+1,first_response:true,outbox:1,audit:1,outbox_safe:true,audit_safe:true});
      const concurrentVersion=sendVersion+1;const concurrentSend=await Promise.allSettled(["a","b"].map(label=>withTenantTransaction(runtimePool,
        {tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:`human-text-concurrent-${label}`},client=>sendHumanTextMessage(client,
          {conversationId:firstMaterialized.conversationId,expectedConversationVersion:concurrentVersion,body:`Concorrente ${label}`,idempotencyKey:`human-text-concurrent-${label}`}))));
      assert.equal(concurrentSend.filter(result=>result.status==="fulfilled").length,1);assert.equal(concurrentSend.filter(result=>result.status==="rejected").length,1);
      const sendPrivileges=await target.query(`SELECT has_function_privilege('zap_pronto_api','send_human_text_message(uuid,integer,text,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','send_human_text_message(uuid,integer,text,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','send_human_text_message(uuid,integer,text,text)','EXECUTE') app,
        has_table_privilege('zap_pronto_api','human_text_message_commands','SELECT') table_select`);
      assert.deepEqual(sendPrivileges.rows[0],{api:true,worker:false,app:false,table_select:false});

      const cancelVersion=(await target.query("SELECT version FROM conversations WHERE id=$1",[firstMaterialized.conversationId])).rows[0].version;
      const cancelResults=await Promise.all(Array.from({length:20},(_,index)=>withTenantTransaction(runtimePool,
        {tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:`human-text-cancel-${index}`},client=>cancelHumanTextMessage(client,
          {conversationId:firstMaterialized.conversationId,messageId:sent.messageId,expectedConversationVersion:cancelVersion,idempotencyKey:"human-text-cancel-key-1"}))));
      assert.equal(cancelResults.filter(result=>!result.replayed).length,1);assert.equal(cancelResults.filter(result=>result.replayed).length,19);
      assert.ok(cancelResults.every(result=>result.messageId===sent.messageId&&result.deliveryStatus==="CANCELLED"));
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-divergent"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:sent.messageId,expectedConversationVersion:cancelVersion+1,idempotencyKey:"human-text-cancel-key-1"})),/MESSAGE_CANCEL_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:readerId,correlationId:"human-text-cancel-owner"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:sent.messageId,expectedConversationVersion:cancelVersion,idempotencyKey:"human-text-cancel-reader"})),/(MESSAGE_CANCEL_STATE_CONFLICT|INBOX_CONVERSATION_NOT_FOUND)/);
      const cancelEvidence=await target.query(`SELECT message.delivery_status,event.status,event.cancelled_at IS NOT NULL cancelled,event.attempts,event.lease_token,event.published_at,
        conversation.version,(SELECT count(*)::int FROM audit_events audit WHERE audit.entity_id=message.id::text AND audit.action='HUMAN_TEXT_MESSAGE_CANCELLED') audit,
        (SELECT count(*)::int FROM outbox_events extra WHERE extra.aggregate_id=message.id AND extra.event_type='channel.outbound.requested') outbound_count,
        (SELECT bool_and(NOT metadata::text~'(Resposta humana|human-text-cancel|fingerprint)') FROM audit_events audit WHERE audit.entity_id=message.id::text) audit_safe
        FROM messages message JOIN conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
        JOIN human_text_message_commands original ON original.tenant_id=message.tenant_id AND original.message_id=message.id
        JOIN outbox_events event ON event.tenant_id=original.tenant_id AND event.id=original.outbox_id WHERE message.id=$1 GROUP BY message.id,event.id,conversation.id`,[sent.messageId]);
      assert.deepEqual(cancelEvidence.rows[0],{delivery_status:"CANCELLED",status:"CANCELLED",cancelled:true,attempts:0,lease_token:null,published_at:null,
        version:cancelVersion+1,audit:1,outbound_count:1,audit_safe:true});
      const secondSendConversation="7e000000-0000-4000-8000-000000000001";
      const secondSendCase="7e000000-0000-4000-8000-000000000002";
      const secondSendHandoff="7e000000-0000-4000-8000-000000000003";
      const secondSendContact="7e000000-0000-4000-8000-000000000004";
      const secondSendIdentity="7e000000-0000-4000-8000-000000000005";
      await target.query(`INSERT INTO contacts(id,tenant_id,display_name)
        VALUES($1,'50000000-0000-4000-8000-000000000002','Segundo contato idempotência')`,[secondSendContact]);
      await target.query(`INSERT INTO contact_identities(id,tenant_id,contact_id,channel_connection_id,external_user_id)
        SELECT $1,tenant_id,$2,channel_connection_id,'external-idempotency-second'
        FROM conversations WHERE id=$3`,[secondSendIdentity,secondSendContact,firstMaterialized.conversationId]);
      await target.query(`INSERT INTO conversations(id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,
          status,automation_status,assigned_user_id,version)
        SELECT $1,tenant_id,channel_connection_id,$2,$3,unit_id,'OPEN','HUMAN_ACTIVE',$4,1
        FROM conversations WHERE id=$5`,[secondSendConversation,secondSendContact,secondSendIdentity,actorBId,firstMaterialized.conversationId]);
      await target.query(`INSERT INTO service_cases(id,tenant_id,conversation_id,unit_id,kind,status)
        SELECT $1,tenant_id,$2,unit_id,'HUMAN_TEXT_IDEMPOTENCY','IN_REVIEW' FROM conversations WHERE id=$2`,
      [secondSendCase,secondSendConversation]);
      await target.query(`INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,
          assigned_user_id,idempotency_key,queued_at,claimed_at)
        SELECT $1,tenant_id,$2,$3,unit_id,'IDEMPOTENCY_TEST','NORMAL','ACTIVE',$4,$5,clock_timestamp(),clock_timestamp()
        FROM conversations WHERE id=$2`,[secondSendHandoff,secondSendConversation,secondSendCase,actorBId,"human-text-second-case"]);
      const crossConversationKey="human-text-cross-conversation-key";
      const crossConversationSend=await Promise.allSettled([
        withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cross-first"},
          client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:cancelVersion+1,
            body:"Primeiro caso",idempotencyKey:crossConversationKey})),
        withTenantTransaction(competingRuntimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cross-second"},
          client=>sendHumanTextMessage(client,{conversationId:secondSendConversation,expectedConversationVersion:1,
            body:"Segundo caso",idempotencyKey:crossConversationKey})),
      ]);
      assert.equal(crossConversationSend.filter(result=>result.status==="fulfilled").length,1);
      const crossRejected=crossConversationSend.find(result=>result.status==="rejected");
      assert.ok(crossRejected&&crossRejected.status==="rejected");
      assert.match(String(crossRejected.reason?.message??crossRejected.reason),/MESSAGE_IDEMPOTENCY_CONFLICT/);
      assert.notEqual(crossRejected.reason?.code,"23505");
      const firstVersionAfterCross=(await target.query("SELECT version FROM conversations WHERE id=$1",
        [firstMaterialized.conversationId])).rows[0].version;
      const secondVersionAfterCross=(await target.query("SELECT version FROM conversations WHERE id=$1",
        [secondSendConversation])).rows[0].version;
      const firstCancelable=await withTenantTransaction(runtimePool,
        {tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-cross-create-first"},
        client=>sendHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,expectedConversationVersion:firstVersionAfterCross,
          body:"Cancelar primeiro",idempotencyKey:"human-text-cancel-cross-create-first"}));
      const secondCancelable=await withTenantTransaction(runtimePool,
        {tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-cross-create-second"},
        client=>sendHumanTextMessage(client,{conversationId:secondSendConversation,expectedConversationVersion:secondVersionAfterCross,
          body:"Cancelar segundo",idempotencyKey:"human-text-cancel-cross-create-second"}));
      const crossCancelKey="human-text-cancel-cross-conversation";
      const crossConversationCancel=await Promise.allSettled([
        withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-cross-first"},
          client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:firstCancelable.messageId,
            expectedConversationVersion:firstCancelable.conversationVersion,idempotencyKey:crossCancelKey})),
        withTenantTransaction(competingRuntimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-cross-second"},
          client=>cancelHumanTextMessage(client,{conversationId:secondSendConversation,messageId:secondCancelable.messageId,
            expectedConversationVersion:secondCancelable.conversationVersion,idempotencyKey:crossCancelKey})),
      ]);
      assert.equal(crossConversationCancel.filter(result=>result.status==="fulfilled").length,1);
      const crossCancelRejected=crossConversationCancel.find(result=>result.status==="rejected");
      assert.ok(crossCancelRejected&&crossCancelRejected.status==="rejected");
      assert.match(String(crossCancelRejected.reason?.message??crossCancelRejected.reason),/MESSAGE_CANCEL_IDEMPOTENCY_CONFLICT/);
      assert.notEqual(crossCancelRejected.reason?.code,"23505");
      const pendingOther=(await target.query(`SELECT message.id,event.id outbox_id FROM messages message JOIN human_text_message_commands command ON command.tenant_id=message.tenant_id AND command.message_id=message.id
        JOIN outbox_events event ON event.tenant_id=command.tenant_id AND event.id=command.outbox_id WHERE message.conversation_id=$1 AND message.delivery_status='QUEUED' ORDER BY message.created_at DESC LIMIT 1`,[firstMaterialized.conversationId])).rows[0];
      await target.query("UPDATE outbox_events SET attempts=1 WHERE id=$1",[pendingOther.outbox_id]);
      const claimedVersion=(await target.query("SELECT version FROM conversations WHERE id=$1",[firstMaterialized.conversationId])).rows[0].version;
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-attempted"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-attempted"})),/MESSAGE_CANCEL_ALREADY_CLAIMED/);
      await target.query(`UPDATE outbox_events SET status='PROCESSING',lease_token='7d000000-0000-4000-8000-000000000001',leased_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1`,[pendingOther.outbox_id]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-processing"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-processing"})),/MESSAGE_CANCEL_ALREADY_CLAIMED/);
      await target.query("UPDATE outbox_events SET status='PENDING',attempts=0,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL WHERE id=$1",[pendingOther.outbox_id]);
      await target.query("UPDATE messages SET external_message_id='provider-already-accepted' WHERE id=$1",[pendingOther.id]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-external"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-external"})),/MESSAGE_CANCEL_STATE_CONFLICT/);
      await target.query("UPDATE messages SET external_message_id=NULL,delivery_status='SENT' WHERE id=$1",[pendingOther.id]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-sent"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-sent"})),/MESSAGE_CANCEL_STATE_CONFLICT/);
      await target.query("UPDATE messages SET delivery_status='FAILED' WHERE id=$1",[pendingOther.id]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-failed"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-failed"})),/MESSAGE_CANCEL_STATE_CONFLICT/);
      await target.query("UPDATE messages SET delivery_status='QUEUED' WHERE id=$1",[pendingOther.id]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"40000000-0000-4000-8000-000000000001",actorId:actorAId,correlationId:"human-text-cancel-cross-tenant"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-cross-tenant"})),/CONVERSATION_NOT_FOUND/);
      const inboundMessageId=(await target.query("SELECT id FROM messages WHERE conversation_id=$1 AND direction='INBOUND' LIMIT 1",[firstMaterialized.conversationId])).rows[0].id;
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-inbound"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:inboundMessageId,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-inbound"})),/MESSAGE_CANCEL_STATE_CONFLICT/);
      await target.query(`CREATE FUNCTION reject_human_text_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='HUMAN_TEXT_MESSAGE_CANCELLED' THEN RAISE EXCEPTION 'SYNTHETIC_CANCEL_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_human_text_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_human_text_cancel_audit()`);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"human-text-cancel-rollback"},
        client=>cancelHumanTextMessage(client,{conversationId:firstMaterialized.conversationId,messageId:pendingOther.id,expectedConversationVersion:claimedVersion,idempotencyKey:"human-text-cancel-rollback"})),/SYNTHETIC_CANCEL_AUDIT_FAILURE/);
      await target.query("DROP TRIGGER reject_human_text_cancel_audit ON audit_events; DROP FUNCTION reject_human_text_cancel_audit()");
      const cancelRollback=await target.query(`SELECT message.delivery_status,event.status,event.cancelled_at,conversation.version,
        (SELECT count(*)::int FROM human_text_message_cancel_commands command WHERE command.message_id=message.id) commands
        FROM messages message JOIN conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
        JOIN human_text_message_commands original ON original.tenant_id=message.tenant_id AND original.message_id=message.id
        JOIN outbox_events event ON event.tenant_id=original.tenant_id AND event.id=original.outbox_id WHERE message.id=$1`,[pendingOther.id]);
      assert.deepEqual(cancelRollback.rows[0],{delivery_status:"QUEUED",status:"PENDING",cancelled_at:null,version:claimedVersion,commands:0});
      const cancelPrivileges=await target.query(`SELECT has_function_privilege('zap_pronto_api','cancel_human_text_message(uuid,uuid,integer,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','cancel_human_text_message(uuid,uuid,integer,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','cancel_human_text_message(uuid,uuid,integer,text)','EXECUTE') app,
        has_table_privilege('zap_pronto_api','human_text_message_cancel_commands','SELECT') table_select`);
      assert.deepEqual(cancelPrivileges.rows[0],{api:true,worker:false,app:false,table_select:false});

      const deliveryAccount=(await target.query("SELECT external_account_id FROM channel_connections WHERE id=(SELECT channel_connection_id FROM conversations WHERE id=$1)",[firstMaterialized.conversationId])).rows[0].external_account_id;
      const deliveryRecipient=(await target.query(`SELECT identity.external_user_id FROM conversations conversation JOIN contact_identities identity
        ON identity.tenant_id=conversation.tenant_id AND identity.id=conversation.contact_identity_id WHERE conversation.id=$1`,[firstMaterialized.conversationId])).rows[0].external_user_id;
      await target.query(`UPDATE messages SET external_message_id='wamid.synthetic.delivery',delivery_status='SENT',created_at='2026-08-10T11:59:00Z',provider_sent_at='2026-08-10T12:00:00Z',last_provider_status_at='2026-08-10T12:00:00Z' WHERE id=$1`,[pendingOther.id]);
      const deliveryEvent={provider:"META_WHATSAPP",channelAccountId:deliveryAccount,externalMessageId:"wamid.synthetic.delivery",recipientExternalId:deliveryRecipient,
        providerStatus:"delivered",normalizedStatus:"DELIVERED",occurredAt:"2026-08-10T12:01:00.000Z",errorCodes:[]};
      const delivered=await reconcileMetaDeliveryStatus(runtimePool,deliveryEvent,"meta-status-delivered");assert.equal(delivered.outcome,"APPLIED");assert.equal(delivered.resultStatus,"DELIVERED");
      const deliveredReplay=await reconcileMetaDeliveryStatus(runtimePool,deliveryEvent,"meta-status-replay");assert.equal(deliveredReplay.replayed,true);assert.equal(deliveredReplay.receiptId,delivered.receiptId);
      const stale=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,providerStatus:"sent",normalizedStatus:"SENT",occurredAt:"2026-08-10T12:00:30.000Z"},"meta-status-stale");assert.equal(stale.outcome,"IGNORED_STALE");
      const readResults=await Promise.all([
        reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,providerStatus:"read",normalizedStatus:"READ",occurredAt:"2026-08-10T12:02:00.000Z"},"meta-status-read"),
        reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,providerStatus:"delivered",normalizedStatus:"DELIVERED",occurredAt:"2026-08-10T12:01:30.000Z"},"meta-status-delivered-concurrent")]);
      assert.equal(readResults.some(result=>result.resultStatus==="READ"),true);
      const deliveryEvidence=(await target.query(`SELECT delivery_status,provider_sent_at,provider_delivered_at,provider_read_at,provider_failed_at,last_provider_status_at FROM messages WHERE id=$1`,[pendingOther.id])).rows[0];
      assert.equal(deliveryEvidence.delivery_status,"READ");assert.equal(deliveryEvidence.provider_sent_at.toISOString(),"2026-08-10T12:00:00.000Z");assert.equal(deliveryEvidence.provider_delivered_at.toISOString(),"2026-08-10T12:01:00.000Z");assert.equal(deliveryEvidence.provider_read_at.toISOString(),"2026-08-10T12:02:00.000Z");assert.equal(deliveryEvidence.provider_failed_at,null);
      const lateFailed=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,providerStatus:"failed",normalizedStatus:"FAILED",occurredAt:"2026-08-10T12:03:00.000Z",errorCodes:[131047]},"meta-status-failed-late");assert.equal(lateFailed.outcome,"IGNORED_STALE");
      const directReadId="7e000000-0000-4000-8000-000000000001";await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload,delivery_status,created_at)
        VALUES($1,'50000000-0000-4000-8000-000000000002',$2,'OUTBOUND','HUMAN','wamid.synthetic.direct-read','direct read','{"kind":"TEXT"}','QUEUED','2026-08-10T12:59:00Z')`,[directReadId,firstMaterialized.conversationId]);
      const directRead=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.synthetic.direct-read",providerStatus:"read",normalizedStatus:"READ",occurredAt:"2026-08-10T13:00:00.000Z"},"meta-status-direct-read");assert.equal(directRead.outcome,"APPLIED");
      assert.deepEqual((await target.query("SELECT delivery_status,provider_sent_at,provider_delivered_at,provider_read_at IS NOT NULL read_at FROM messages WHERE id=$1",[directReadId])).rows[0],{delivery_status:"READ",provider_sent_at:null,provider_delivered_at:null,read_at:true});
      await target.query("UPDATE messages SET external_message_id='wamid.synthetic.cancelled',created_at='2026-08-10T13:59:00Z' WHERE id=$1",[sent.messageId]);
      const cancelledStatus=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.synthetic.cancelled",providerStatus:"delivered",normalizedStatus:"DELIVERED",occurredAt:"2026-08-10T14:00:00.000Z"},"meta-status-cancelled");
      assert.equal(cancelledStatus.outcome,"IGNORED_CANCELLED");
      const unmatched=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.no-match",providerStatus:"sent",normalizedStatus:"SENT",occurredAt:"2026-08-10T15:00:00.000Z",recipientExternalId:null},"meta-status-unmatched");assert.equal(unmatched.outcome,"UNMATCHED");
      const unsupported=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.unknown",providerStatus:"unknown",normalizedStatus:null,occurredAt:"2026-08-10T15:01:00.000Z",recipientExternalId:null},"meta-status-unknown");assert.equal(unsupported.outcome,"UNSUPPORTED");
      const mismatchId="7e000000-0000-4000-8000-000000000002";await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload,delivery_status,created_at)
        VALUES($1,'50000000-0000-4000-8000-000000000002',$2,'OUTBOUND','HUMAN','wamid.synthetic.mismatch','mismatch','{"kind":"TEXT"}','QUEUED','2026-08-10T15:01:00Z')`,[mismatchId,firstMaterialized.conversationId]);
      const mismatch=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.synthetic.mismatch",recipientExternalId:"wrong-recipient",providerStatus:"sent",normalizedStatus:"SENT",occurredAt:"2026-08-10T15:02:00.000Z"},"meta-status-recipient-mismatch");assert.equal(mismatch.outcome,"RECIPIENT_MISMATCH");
      await target.query("UPDATE channel_connections SET status='DISCONNECTED' WHERE external_account_id=$1",[deliveryAccount]);
      const inactive=await reconcileMetaDeliveryStatus(runtimePool,{...deliveryEvent,externalMessageId:"wamid.inactive-unmatched",recipientExternalId:null,providerStatus:"sent",normalizedStatus:"SENT",occurredAt:"2026-08-10T15:03:00.000Z"},"meta-status-inactive");assert.equal(inactive.outcome,"UNMATCHED");
      await target.query("UPDATE channel_connections SET status='ACTIVE' WHERE external_account_id=$1",[deliveryAccount]);
      const deliveryPrivileges=await target.query(`SELECT has_function_privilege('zap_pronto_api','reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_api','reconcile_meta_delivery_status_0025(text,text,text,text,text,timestamptz,integer[],text,text,text)','EXECUTE') api_internal,
        has_table_privilege('zap_pronto_api','meta_delivery_status_receipts','SELECT') receipts_select,
        has_table_privilege('zap_pronto_api','meta_delivery_status_applications','SELECT') applications_select`);
      assert.deepEqual(deliveryPrivileges.rows[0],{api:true,worker:false,api_internal:false,receipts_select:false,applications_select:false});
      const deliveryPrivacy=(await target.query(`SELECT count(*)::int receipts,count(*) FILTER(WHERE provider_status='unknown')::int unknown,
        bool_and(array_to_string(error_codes,',')!~'(title|detail|message)') safe_errors FROM meta_delivery_status_receipts`)).rows[0];assert.ok(deliveryPrivacy.receipts>=10);assert.equal(deliveryPrivacy.unknown,1);assert.equal(deliveryPrivacy.safe_errors,true);
      const deliveryAudit=(await target.query(`SELECT bool_and(metadata ? 'receiptId' AND metadata ? 'outcome' AND NOT metadata::text~'(wamid|recipient|account|fingerprint|131047)') safe
        FROM audit_events WHERE action='META_DELIVERY_STATUS_RECONCILED'`)).rows[0];assert.equal(deliveryAudit.safe,true);

      const futureMessageId="7e000000-0000-4000-8000-000000000003";
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload,delivery_status)
        SELECT $1,tenant_id,conversation_id,'OUTBOUND','HUMAN','wamid.synthetic.future-guard','future guard',jsonb_build_object('kind','TEXT'),'QUEUED'
        FROM messages WHERE id=$2`,[futureMessageId,pendingOther.id]);
      const futureOccurredAt=new Date(Date.now()+11*60*1000).toISOString();const futureEvent={provider:"META_WHATSAPP",channelAccountId:deliveryAccount,
        externalMessageId:"wamid.synthetic.future-guard",recipientExternalId:deliveryRecipient,providerStatus:"delivered",normalizedStatus:"DELIVERED",
        occurredAt:futureOccurredAt,errorCodes:[]};
      const futureResults=await Promise.all(Array.from({length:20},(_,index)=>reconcileMetaDeliveryStatus(runtimePool,futureEvent,`future-status-${index}`)));
      assert.ok(futureResults.every(result=>result.outcome==="IGNORED_INVALID_TIMESTAMP"));assert.equal(futureResults.filter(result=>!result.replayed).length,1);
      const futureGuard=await target.query(`SELECT message.delivery_status AS status,message.provider_sent_at AS sent,message.provider_delivered_at AS delivered,
        message.provider_read_at AS read,message.provider_failed_at AS failed,message.last_provider_status_at AS last,
        (SELECT count(*)::int FROM meta_delivery_status_receipts receipt WHERE receipt.external_message_id=message.external_message_id) AS receipts,
        (SELECT count(*)::int FROM meta_delivery_status_applications application JOIN meta_delivery_status_receipts receipt
          ON receipt.tenant_id=application.tenant_id AND receipt.id=application.receipt_id WHERE receipt.external_message_id=message.external_message_id
            AND application.outcome='IGNORED_INVALID_TIMESTAMP') AS applications
        FROM messages message WHERE message.id=$1`,[futureMessageId]);
      assert.deepEqual(futureGuard.rows[0],{status:"QUEUED",sent:null,delivered:null,read:null,failed:null,last:null,receipts:1,applications:1});
      const validAfterFuture=await reconcileMetaDeliveryStatus(runtimePool,{...futureEvent,providerStatus:"sent",normalizedStatus:"SENT",occurredAt:new Date().toISOString()},"future-valid-after");
      assert.equal(validAfterFuture.outcome,"APPLIED");const validAfterFutureState=(await target.query(`SELECT delivery_status AS status,
        provider_sent_at IS NOT NULL AS sent,provider_delivered_at IS NULL AS no_delivered,last_provider_status_at=provider_sent_at AS last_matches
        FROM messages WHERE id=$1`,[futureMessageId])).rows[0];assert.deepEqual(validAfterFutureState,{status:"SENT",sent:true,no_delivered:true,last_matches:true});
      const futurePrivacy=(await target.query(`SELECT application.message_id,application.previous_status,application.result_status,
        audit.metadata::text~'(wamid|future guard|recipient|account|fingerprint)' AS leaked
        FROM meta_delivery_status_applications application JOIN meta_delivery_status_receipts receipt
          ON receipt.tenant_id=application.tenant_id AND receipt.id=application.receipt_id
        JOIN audit_events audit ON audit.entity_id=receipt.id::text AND audit.action='META_DELIVERY_STATUS_RECONCILED'
        WHERE receipt.external_message_id='wamid.synthetic.future-guard' AND application.outcome='IGNORED_INVALID_TIMESTAMP'`)).rows[0];
      assert.deepEqual(futurePrivacy,{message_id:null,previous_status:null,result_status:null,leaked:false});

      const preMessageId="7e000000-0000-4000-8000-000000000004";
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload,delivery_status,created_at)
        VALUES($1,'50000000-0000-4000-8000-000000000002',$2,'OUTBOUND','HUMAN','wamid.synthetic.pre-message','pre message','{"kind":"TEXT"}','QUEUED','2026-08-10T16:00:00Z')`,[preMessageId,firstMaterialized.conversationId]);
      const preMessageEvent={...deliveryEvent,externalMessageId:"wamid.synthetic.pre-message",providerStatus:"delivered",normalizedStatus:"DELIVERED",
        occurredAt:"2026-08-10T15:49:59.000Z"};
      const preMessageResults=await Promise.all(Array.from({length:20},(_,index)=>reconcileMetaDeliveryStatus(runtimePool,preMessageEvent,`pre-message-${index}`)));
      assert.ok(preMessageResults.every(result=>result.outcome==="IGNORED_INVALID_TIMESTAMP"&&result.messageId===preMessageId));
      assert.equal(preMessageResults.filter(result=>!result.replayed).length,1);
      const preMessageEvidence=(await target.query(`SELECT message.delivery_status,message.provider_delivered_at,message.last_provider_status_at,
        count(DISTINCT receipt.id)::int receipts,count(DISTINCT application.id)::int applications,
        min(application.previous_status)=max(application.result_status) unchanged
        FROM messages message JOIN meta_delivery_status_applications application ON application.message_id=message.id
        JOIN meta_delivery_status_receipts receipt ON receipt.tenant_id=application.tenant_id AND receipt.id=application.receipt_id
        WHERE message.id=$1 GROUP BY message.id`,[preMessageId])).rows[0];
      assert.deepEqual(preMessageEvidence,{delivery_status:"QUEUED",provider_delivered_at:null,last_provider_status_at:null,receipts:1,applications:1,unchanged:true});
      const preMessageValid=await reconcileMetaDeliveryStatus(runtimePool,{...preMessageEvent,providerStatus:"sent",normalizedStatus:"SENT",
        occurredAt:"2026-08-10T16:01:00.000Z"},"pre-message-valid");assert.equal(preMessageValid.outcome,"APPLIED");

      const audioReceipt=await acceptInboundEnvelope(runtimePool,{...inboundEnvelope,providerEventId:"wamid.audio-b",
        kind:"AUDIO",payload:{mediaId:"private-media-id",mimeType:"audio/ogg",trust:"UNTRUSTED"}},"inbound-audio-b");
      const audioLease="97000000-0000-4000-8000-00000000010b";
      const audioOutbox=await leaseInboundOutbox(audioReceipt.id,audioLease);
      const audioMaterialized=await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",
        actorBId,audioOutbox,audioLease);
      const audioEvidence=await target.query(`SELECT body,payload,
        (SELECT count(*)::int FROM message_attachments attachment WHERE attachment.message_id=message.id) AS attachments
        FROM messages message WHERE id=$1`,[audioMaterialized.messageId]);
      assert.deepEqual(audioEvidence.rows[0],{body:null,payload:{kind:"AUDIO",mediaId:"private-media-id",
        mimeType:"audio/ogg",trust:"UNTRUSTED"},attachments:0});

      const messageRollbackReceipt=await acceptInboundEnvelope(runtimePool,{...inboundEnvelope,
        providerEventId:"wamid.message-rollback-b",senderExternalId:"rollback-message-sender"},
      "inbound-message-rollback-b");
      const messageRollbackLease="97000000-0000-4000-8000-00000000010d";
      const messageRollbackOutbox=await leaseInboundOutbox(messageRollbackReceipt.id,messageRollbackLease);
      await target.query(`CREATE FUNCTION reject_inbound_message_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.source_inbound_event_id IS NOT NULL THEN RAISE EXCEPTION 'SYNTHETIC_MESSAGE_FAILURE'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_inbound_message_materialization BEFORE INSERT ON messages
        FOR EACH ROW EXECUTE FUNCTION reject_inbound_message_materialization()`);
      await assert.rejects(materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        messageRollbackOutbox,messageRollbackLease),/SYNTHETIC_MESSAGE_FAILURE/);
      await target.query(`DROP TRIGGER reject_inbound_message_materialization ON messages;
        DROP FUNCTION reject_inbound_message_materialization()`);
      const messageRollbackEvidence=await target.query(`SELECT
        (SELECT count(*)::int FROM messages WHERE source_inbound_event_id=$1) AS messages,
        (SELECT count(*)::int FROM contact_identities WHERE external_user_id='rollback-message-sender') AS identities,
        (SELECT status FROM outbox_events WHERE id=$2) AS outbox_status`,
      [messageRollbackReceipt.id,messageRollbackOutbox]);
      assert.deepEqual(messageRollbackEvidence.rows[0],{messages:0,identities:0,outbox_status:"PROCESSING"});
      await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        messageRollbackOutbox,messageRollbackLease);

      const ackRollbackReceipt=await acceptInboundEnvelope(runtimePool,{...inboundEnvelope,
        providerEventId:"wamid.ack-rollback-b",senderExternalId:"rollback-ack-sender"},"inbound-ack-rollback-b");
      const ackRollbackLease="97000000-0000-4000-8000-00000000010e";
      const ackRollbackOutbox=await leaseInboundOutbox(ackRollbackReceipt.id,ackRollbackLease);
      await target.query(`CREATE FUNCTION reject_inbound_materialization_ack() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='channel.inbound.received' AND NEW.status='PUBLISHED'
          THEN RAISE EXCEPTION 'SYNTHETIC_ACK_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_inbound_materialization_ack BEFORE UPDATE ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION reject_inbound_materialization_ack()`);
      await assert.rejects(materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        ackRollbackOutbox,ackRollbackLease),/SYNTHETIC_ACK_FAILURE/);
      await target.query(`DROP TRIGGER reject_inbound_materialization_ack ON outbox_events;
        DROP FUNCTION reject_inbound_materialization_ack()`);
      const ackRollbackEvidence=await target.query(`SELECT
        (SELECT count(*)::int FROM messages WHERE source_inbound_event_id=$1) AS messages,
        (SELECT count(*)::int FROM contact_identities WHERE external_user_id='rollback-ack-sender') AS identities,
        (SELECT status FROM outbox_events WHERE id=$2) AS outbox_status`,[ackRollbackReceipt.id,ackRollbackOutbox]);
      assert.deepEqual(ackRollbackEvidence.rows[0],{messages:0,identities:0,outbox_status:"PROCESSING"});
      await materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        ackRollbackOutbox,ackRollbackLease);
      const inboundPiiLeak=await target.query(`SELECT
        (SELECT count(*)::int FROM outbox_events WHERE event_type LIKE 'channel.inbound.%'
          AND payload::text ~ '(sender-b|rollback-|private-media-id|Mensagem sintética|wamid)') AS outbox_leaks,
        (SELECT count(*)::int FROM audit_events WHERE metadata::text ~
          '(sender-b|rollback-|private-media-id|Mensagem sintética|wamid)') AS audit_leaks`);
      assert.deepEqual(inboundPiiLeak.rows[0],{outbox_leaks:0,audit_leaks:0});
      await assert.rejects(acceptInboundEnvelope(runtimePool,
        { ...inboundEnvelope, payload: { text: "Divergente" } }, "inbound-fingerprint-collision-b"),
      /INBOUND_IDEMPOTENCY_COLLISION/);
      assert.equal(concurrentInbound[0].tenantId, "50000000-0000-4000-8000-000000000002");
      assert.equal(concurrentInbound[0].routingStatus, "ROUTED");
      const crossTenantReceipts = await withTenantTransaction(runtimePool, {
        tenantId: "40000000-0000-4000-8000-000000000001", actorId: actorAId,
        correlationId: "inbound-cross-tenant-read",
      }, async (client) => (await client.query("SELECT count(*)::int AS count FROM inbound_channel_events")).rows[0].count);
      assert.equal(crossTenantReceipts, 0);
      await assert.rejects(target.query(`INSERT INTO channel_connections
        (tenant_id,type,scope,external_account_id,status) VALUES
        ('40000000-0000-4000-8000-000000000001','WHATSAPP','SINGLE_UNIT','account-b','ACTIVE')`),
      (error) => error instanceof Error && "code" in error && error.code === "23505");
      const unknownOutboxId="8f000000-0000-4000-8000-000000000001";
      await target.query(`INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,
        idempotency_key,payload_version) VALUES($1,'40000000-0000-4000-8000-000000000001','test',
        '44000000-0000-4000-8000-000000000001','worker.unknown','{}','worker-unknown-inbound-test',1)`,
      [unknownOutboxId]);
      const runnerEnvelopes=["wamid.runner-one","wamid.runner-two"].map(providerEventId=>
        ({...inboundEnvelope,providerEventId,payload:{text:`runner-${providerEventId}`}}));
      const runnerReceipts=await Promise.all(runnerEnvelopes.map((envelope,index)=>
        acceptInboundEnvelope(runtimePool,envelope,`inbound-runner-${index}`)));
      const expiredRunnerToken="97000000-0000-4000-8000-00000000020a";
      const expiredRunnerOutbox=await leaseInboundOutbox(runnerReceipts[0].id,expiredRunnerToken,-1);
      const expiredFailClient=await workerPool.connect();
      try{await expiredFailClient.query("BEGIN");await expiredFailClient.query("SET LOCAL ROLE zap_pronto_worker");
        const expiredFail=await expiredFailClient.query(
          "SELECT fail_inbound_materialization_event($1,$2,$3,1) AS status",
          [expiredRunnerOutbox,expiredRunnerToken,"INBOUND_MATERIALIZATION_FAILED"]);
        assert.equal(expiredFail.rows[0].status,null);await expiredFailClient.query("COMMIT");
      }finally{expiredFailClient.release();}
      const [runnerClaimA,runnerClaimB]=await Promise.all([
        claimInboundMaterializationEvents(workerPool,inboundWorkerOptions),
        claimInboundMaterializationEvents(competingWorkerPool,inboundWorkerOptions),
      ]);
      const runnerClaims=[...runnerClaimA,...runnerClaimB];
      assert.equal(runnerClaims.length,2);
      assert.equal(new Set(runnerClaims.map(job=>job.outbox_id)).size,2);
      await Promise.all(runnerClaims.map((job,index)=>processInboundClaim(
        index===0?workerPool:competingWorkerPool,job,inboundWorkerOptions)));
      const runnerEvidence=await target.query(`SELECT
        (SELECT count(*)::int FROM messages WHERE source_inbound_event_id=ANY($1::uuid[])) AS messages,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='channel.inbound.materialized'
          AND payload->>'receiptId'=ANY($2::text[])) AS materialized_events,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='channel.inbound.materialized'
          AND payload::text ~ '(runner-|sender-b|wamid)') AS pii_leaks`,
      [runnerReceipts.map(row=>row.id),runnerReceipts.map(row=>row.id)]);
      assert.deepEqual(runnerEvidence.rows[0],{messages:2,materialized_events:2,pii_leaks:0});
      const unknownPreserved=await target.query("SELECT status,attempts FROM outbox_events WHERE id=$1",[unknownOutboxId]);
      assert.deepEqual(unknownPreserved.rows[0],{status:"PENDING",attempts:0});
      await target.query(`
        INSERT INTO units (tenant_id,code,name) VALUES
          ('50000000-0000-4000-8000-000000000002','POOL-B-SECOND','Pool B Second'),
          ('50000000-0000-4000-8000-000000000002','POOL-B-OTHER','Pool B Other');
        INSERT INTO channel_connection_units (tenant_id,channel_connection_id,unit_id)
        SELECT connection.tenant_id,connection.id,unit.id
        FROM channel_connections connection JOIN units unit ON unit.tenant_id=connection.tenant_id
        WHERE connection.tenant_id='50000000-0000-4000-8000-000000000002'
          AND connection.external_account_id='account-b' AND unit.code='POOL-B-SECOND';
        INSERT INTO users (id,tenant_id,email,display_name) VALUES
          ('70000000-0000-4000-8000-00000000000c','50000000-0000-4000-8000-000000000002',
           'actor-b-other@test.local','Actor B Other');
        INSERT INTO user_units (tenant_id,user_id,unit_id,role)
        SELECT tenant_id,'70000000-0000-4000-8000-00000000000c',id,'ATTENDANT' FROM units
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND code='POOL-B-OTHER';
      `);
      const unroutedInbound = await acceptInboundEnvelope(runtimePool,
        { ...inboundEnvelope, providerEventId: "wamid.ambiguous-b" }, "inbound-multiunit-b");
      assert.deepEqual({ unitId: unroutedInbound.unitId, status: unroutedInbound.routingStatus,
        reason: unroutedInbound.routingReason },
      { unitId: null, status: "UNROUTED", reason: "MULTIPLE_ACTIVE_UNITS" });
      const unroutedOutbox = await target.query(`SELECT payload FROM outbox_events
        WHERE event_type='channel.inbound.routing_required' AND aggregate_id=$1`, [unroutedInbound.id]);
      assert.deepEqual(unroutedOutbox.rows[0].payload, {
        receiptId: unroutedInbound.id, provider: "META_WHATSAPP", kind: "TEXT",
        channelConnectionId: unroutedInbound.channelConnectionId, unitId: null, routingStatus: "UNROUTED",
      });
      const unroutedLease="97000000-0000-4000-8000-00000000010c";
      const unroutedOutboxId=await leaseInboundOutbox(unroutedInbound.id,unroutedLease);
      await assert.rejects(materializeInbound(workerPool,"50000000-0000-4000-8000-000000000002",actorBId,
        unroutedOutboxId,unroutedLease),/INBOUND_MATERIALIZATION_LEASE_REJECTED/);
      const unroutedPreserved=await target.query(`SELECT status,event_type,lease_token FROM outbox_events WHERE id=$1`,
        [unroutedOutboxId]);
      assert.deepEqual(unroutedPreserved.rows[0],{status:"PROCESSING",event_type:"channel.inbound.routing_required",
        lease_token:unroutedLease});
      await target.query(`UPDATE outbox_events SET status='PENDING',lease_token=NULL,leased_at=NULL,lease_expires_at=NULL
        WHERE id=$1`,[unroutedOutboxId]);
      assert.deepEqual(await claimInboundMaterializationEvents(workerPool,inboundWorkerOptions),[]);
      const untouchedRouting=await target.query(`SELECT status,attempts FROM outbox_events WHERE id=$1`,[unroutedOutboxId]);
      assert.deepEqual(untouchedRouting.rows[0],{status:"PENDING",attempts:1});
      await target.query(`UPDATE user_units SET role='TENANT_ADMIN' WHERE tenant_id='50000000-0000-4000-8000-000000000002'
        AND user_id IN ($1,'70000000-0000-4000-8000-00000000000c')`,[actorBId]);
      const routingUnits=await target.query(`SELECT id,code FROM units WHERE tenant_id='50000000-0000-4000-8000-000000000002'
        AND code IN ('POOL-B','POOL-B-SECOND') ORDER BY code`);
      const listedRouting=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"routing-list-b"},client=>listRoutingRequired(client,{limit:10}));
      const listedItem=listedRouting.items.find(item=>item.receiptId===unroutedInbound.id);assert.ok(listedItem);
      assert.equal(JSON.stringify(listedItem).match(/sender|Mensagem|mediaId|filename/),null);
      assert.equal(listedItem.eligibleUnits.length,2);
      const routeAttempts=await Promise.allSettled(routingUnits.rows.map((unit,index)=>withTenantTransaction(
        index===0?runtimePool:competingRuntimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
          actorId:index===0?actorBId:"70000000-0000-4000-8000-00000000000c",correlationId:`routing-race-${index}`},
        client=>resolveRoutingRequired(client,{receiptId:unroutedInbound.id,unitId:unit.id,idempotencyKey:`routing-race-key-${index}`}))));
      assert.equal(routeAttempts.filter(result=>result.status==="fulfilled").length,1);
      assert.equal(routeAttempts.filter(result=>result.status==="rejected").length,1);
      const winner=routeAttempts.find(result=>result.status==="fulfilled").value;
      const replayRouting=await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"routing-replay-b"},client=>resolveRoutingRequired(client,{receiptId:unroutedInbound.id,
          unitId:winner.unitId,idempotencyKey:routingUnits.rows.findIndex(unit=>unit.id===winner.unitId)===0?"routing-race-key-0":"routing-race-key-1"}));
      assert.equal(replayRouting.replayed,true);
      const winnerKey=routingUnits.rows.findIndex(unit=>unit.id===winner.unitId)===0?"routing-race-key-0":"routing-race-key-1";
      const losingUnit=routingUnits.rows.find(unit=>unit.id!==winner.unitId).id;
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"routing-divergent-b"},client=>resolveRoutingRequired(client,{receiptId:unroutedInbound.id,
          unitId:losingUnit,idempotencyKey:winnerKey})),/INBOUND_ROUTING_IDEMPOTENCY_CONFLICT/);
      const resolvedEvidence=await target.query(`SELECT
        (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1 AND event_type='channel.inbound.received') AS received,
        (SELECT count(*)::int FROM audit_events WHERE entity_id=$1::text AND action='INBOUND_ROUTING_RESOLVED') AS audits,
        (SELECT status FROM outbox_events WHERE id=$2) AS original_status`,[unroutedInbound.id,unroutedOutboxId]);
      assert.deepEqual(resolvedEvidence.rows[0],{received:1,audits:1,original_status:"PUBLISHED"});
      const resolvedClaim=await claimInboundMaterializationEvents(workerPool,inboundWorkerOptions);assert.equal(resolvedClaim.length,1);
      await processInboundClaim(workerPool,resolvedClaim[0],inboundWorkerOptions);
      const resolvedMaterialization=await target.query(`SELECT count(*)::int AS messages FROM messages WHERE source_inbound_event_id=$1`,[unroutedInbound.id]);
      assert.equal(resolvedMaterialization.rows[0].messages,1);
      const invalidTargetReceipt=await acceptInboundEnvelope(runtimePool,{...inboundEnvelope,providerEventId:"wamid.routing-invalid-target"},
        "routing-invalid-target-receipt");
      const otherUnit=(await target.query(`SELECT id FROM units WHERE tenant_id='50000000-0000-4000-8000-000000000002'
        AND code='POOL-B-OTHER'`)).rows[0].id;
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"routing-unmapped-b"},client=>resolveRoutingRequired(client,{receiptId:invalidTargetReceipt.id,
          unitId:otherUnit,idempotencyKey:"routing-unmapped-key"})),/INBOUND_ROUTING_TARGET_INVALID/);
      await target.query(`UPDATE channel_connections SET status='DISCONNECTED' WHERE id=$1`,[invalidTargetReceipt.channelConnectionId]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"routing-inactive-b"},client=>resolveRoutingRequired(client,{receiptId:invalidTargetReceipt.id,
          unitId:routingUnits.rows[0].id,idempotencyKey:"routing-inactive-key"})),/INBOUND_ROUTING_TARGET_INVALID/);
      await target.query(`UPDATE channel_connections SET status='ACTIVE' WHERE id=$1`,[invalidTargetReceipt.channelConnectionId]);
      await target.query(`UPDATE user_units SET role='ATTENDANT' WHERE tenant_id='50000000-0000-4000-8000-000000000002'
        AND user_id IN ($1,'70000000-0000-4000-8000-00000000000c')`,[actorBId]);
      const ownUnitVisibility = await withTenantTransaction(runtimePool, {
        tenantId: "50000000-0000-4000-8000-000000000002", actorId: actorBId,
        correlationId: "inbound-own-unit-read",
      }, async (client) => (await client.query("SELECT provider_event_id FROM inbound_channel_events")).rows);
      assert.ok(ownUnitVisibility.some((row) => row.provider_event_id==="wamid.db-inbound-b"));
      assert.equal(ownUnitVisibility.filter((row) => row.provider_event_id==="wamid.ambiguous-b").length<=1,true);
      const otherUnitVisibility = await withTenantTransaction(runtimePool, {
        tenantId: "50000000-0000-4000-8000-000000000002",
        actorId: "70000000-0000-4000-8000-00000000000c", correlationId: "inbound-other-unit-read",
      }, async (client) => (await client.query("SELECT id FROM inbound_channel_events")).rowCount);
      assert.equal(otherUnitVisibility, 0);
      await target.query(`UPDATE units SET active=false
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND code IN ('POOL-B','POOL-B-SECOND')`);
      await assert.rejects(acceptInboundEnvelope(runtimePool,
        { ...inboundEnvelope, providerEventId: "wamid.no-active-unit-b" }, "inbound-no-unit-b"),
      /CHANNEL_ACCOUNT_NOT_ROUTABLE/);
      await target.query(`UPDATE units SET active=true WHERE tenant_id='50000000-0000-4000-8000-000000000002'
        AND code IN ('POOL-B','POOL-B-SECOND'); UPDATE channel_connections SET status='DISCONNECTED'
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND external_account_id='account-b'`);
      await assert.rejects(acceptInboundEnvelope(runtimePool,
        { ...inboundEnvelope, providerEventId: "wamid.inactive-b" }, "inbound-inactive-b"),
      /CHANNEL_ACCOUNT_NOT_ROUTABLE/);
      await target.query(`UPDATE channel_connections SET status='ACTIVE'
        WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND external_account_id='account-b'`);
      const outboxBeforeRollback=Number((await target.query(`SELECT count(*)::int AS count FROM outbox_events
        WHERE event_type='channel.inbound.received'`)).rows[0].count);
      await target.query(`CREATE FUNCTION reject_inbound_outbox_for_atomicity() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type IN ('channel.inbound.received','channel.inbound.routing_required')
          THEN RAISE EXCEPTION 'SYNTHETIC_OUTBOX_FAILURE'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER reject_inbound_outbox_for_atomicity BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION reject_inbound_outbox_for_atomicity()`);
      const rollbackEnvelope={...inboundEnvelope,providerEventId:"wamid.atomic-rollback-b"};
      await assert.rejects(acceptInboundEnvelope(runtimePool,rollbackEnvelope,"inbound-atomic-rollback-b"),
        /SYNTHETIC_OUTBOX_FAILURE/);
      await target.query(`DROP TRIGGER reject_inbound_outbox_for_atomicity ON outbox_events;
        DROP FUNCTION reject_inbound_outbox_for_atomicity()`);
      const inboundRollbackEvidence=await target.query(`SELECT
        (SELECT count(*)::int FROM inbound_channel_events WHERE provider_event_id='wamid.atomic-rollback-b') AS receipts,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='channel.inbound.received') AS outbox`);
      assert.deepEqual(inboundRollbackEvidence.rows[0],{receipts:0,outbox:outboxBeforeRollback});

      const resolveBefore=(await target.query(`SELECT handoff.version AS handoff_version,conversation.version AS conversation_version,
        service_case.version AS case_version FROM human_handoffs handoff JOIN conversations conversation
          ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
        JOIN service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
        WHERE handoff.id=$1`,[sendHandoffId])).rows[0];
      await target.query(`INSERT INTO handoff_resolve_commands(tenant_id,idempotency_key,handoff_id,expected_version,
        request_fingerprint,actor_id,conversation_id,service_case_id,result_handoff_version,result_conversation_version,
        correlation_id,disposition)
        SELECT handoff.tenant_id,'handoff-resolve-legacy',handoff.id,handoff.version,repeat('a',64),handoff.assigned_user_id,
          handoff.conversation_id,handoff.service_case_id,handoff.version,conversation.version,'legacy-fixture','LEGACY_UNSPECIFIED'
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.tenant_id=handoff.tenant_id
          AND conversation.id=handoff.conversation_id WHERE handoff.id=$1`,[sendHandoffId]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"handoff-resolve-legacy-replay"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-legacy"})),/HANDOFF_RESOLVE_IDEMPOTENCY_CONFLICT/);
      await target.query("DELETE FROM handoff_resolve_commands WHERE idempotency_key='handoff-resolve-legacy'");
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:readerId,correlationId:"handoff-resolve-other-owner"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-other"})),/HANDOFF_RESOLVE_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"40000000-0000-4000-8000-000000000001",actorId:actorAId,correlationId:"handoff-resolve-cross-tenant"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-cross"})),/HANDOFF_RESOLVE_NOT_FOUND/);
      await target.query(`CREATE FUNCTION reject_handoff_resolve_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='HANDOFF_RESOLVED' THEN RAISE EXCEPTION 'SYNTHETIC_HANDOFF_RESOLVE_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_handoff_resolve_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_handoff_resolve_audit()`);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"handoff-resolve-rollback"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-rollback"})),/SYNTHETIC_HANDOFF_RESOLVE_FAILURE/);
      await target.query("DROP TRIGGER reject_handoff_resolve_audit ON audit_events; DROP FUNCTION reject_handoff_resolve_audit()");
      assert.deepEqual((await target.query(`SELECT handoff.status,conversation.status conversation_status,service_case.status case_status,
        (SELECT count(*)::int FROM handoff_resolve_commands WHERE handoff_id=handoff.id) commands
        FROM human_handoffs handoff JOIN conversations conversation ON conversation.id=handoff.conversation_id
        JOIN service_cases service_case ON service_case.id=handoff.service_case_id WHERE handoff.id=$1`,[sendHandoffId])).rows[0],
        {status:"ACTIVE",conversation_status:"OPEN",case_status:"IN_REVIEW",commands:0});
      const resolveResults=await Promise.all(Array.from({length:20},(_,index)=>withTenantTransaction(index%2?competingRuntimePool:runtimePool,
        {tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:`handoff-resolve-${index}`},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-key"}))));
      assert.equal(resolveResults.filter(result=>!result.replayed).length,1);assert.ok(resolveResults.every(result=>result.handoffVersion===resolveBefore.handoff_version+1));
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"handoff-resolve-divergent"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version+1,disposition:"RESOLVED",idempotencyKey:"handoff-resolve-key"})),/HANDOFF_RESOLVE_IDEMPOTENCY_CONFLICT/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",actorId:actorBId,correlationId:"handoff-resolve-disposition-divergent"},
        client=>resolveHandoff(client,{handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"DUPLICATE",idempotencyKey:"handoff-resolve-key"})),/HANDOFF_RESOLVE_IDEMPOTENCY_CONFLICT/);
      const resolveEffectsBefore=(await target.query(`SELECT
        (SELECT count(*)::int FROM handoff_resolve_commands WHERE handoff_id=$1) commands,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_RESOLVED' AND aggregate_id IN(
          SELECT id FROM human_handoffs WHERE id=$1 UNION SELECT conversation_id FROM human_handoffs WHERE id=$1
          UNION SELECT service_case_id FROM human_handoffs WHERE id=$1)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_RESOLVED' AND entity_id=$1::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.resolved' AND aggregate_id=$1) outbox`,
      [sendHandoffId])).rows[0];
      await target.query(`UPDATE user_units SET status='REVOKED',revoked_at=now(),revoked_by_user_id=$2,
        revocation_reason='Replay authorization test' WHERE tenant_id=$1 AND user_id=$2`,
        ["50000000-0000-4000-8000-000000000002",actorBId]);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"handoff-resolve-replay-downgraded"},client=>resolveHandoff(client,
        {handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",
          idempotencyKey:"handoff-resolve-key"})),/HANDOFF_RESOLVE_NOT_FOUND/);
      assert.deepEqual((await target.query(`SELECT
        (SELECT count(*)::int FROM handoff_resolve_commands WHERE handoff_id=$1) commands,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='ATTENDANT_RESOLVED' AND aggregate_id IN(
          SELECT id FROM human_handoffs WHERE id=$1 UNION SELECT conversation_id FROM human_handoffs WHERE id=$1
          UNION SELECT service_case_id FROM human_handoffs WHERE id=$1)) transitions,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_RESOLVED' AND entity_id=$1::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.resolved' AND aggregate_id=$1) outbox`,
      [sendHandoffId])).rows[0],resolveEffectsBefore);
      await target.query(`UPDATE user_units SET status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,
        revocation_reason=NULL WHERE tenant_id=$1 AND user_id=$2`,
        ["50000000-0000-4000-8000-000000000002",actorBId]);
      assert.equal((await withTenantTransaction(runtimePool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:actorBId,correlationId:"handoff-resolve-replay-restored"},client=>resolveHandoff(client,
        {handoffId:sendHandoffId,expectedVersion:resolveBefore.handoff_version,disposition:"RESOLVED",
          idempotencyKey:"handoff-resolve-key"}))).replayed,true);
      const resolveEvidence=(await target.query(`SELECT handoff.status,handoff.version AS handoff_version,handoff.resolved_at IS NOT NULL AS handoff_resolved,
        service_case.status AS case_status,service_case.version AS case_version,service_case.resolved_at IS NOT NULL AS case_resolved,
        conversation.status AS conversation_status,conversation.automation_status,conversation.assigned_user_id,conversation.version AS conversation_version,
        conversation.closed_at IS NOT NULL AS closed,(SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_RESOLVED' AND entity_id=handoff.id::text) audits,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.resolved' AND aggregate_id=handoff.id) outbox,
        (SELECT disposition FROM handoff_resolve_commands WHERE handoff_id=handoff.id) disposition,
        (SELECT payload->>'disposition' FROM outbox_events WHERE event_type='handoff.resolved' AND aggregate_id=handoff.id) outbox_disposition,
        (SELECT bool_and(metadata::text!~'(body|wamid|recipient|fingerprint|idempotency)') FROM audit_events WHERE action='HANDOFF_RESOLVED' AND entity_id=handoff.id::text) audit_safe
        FROM human_handoffs handoff JOIN service_cases service_case ON service_case.id=handoff.service_case_id
        JOIN conversations conversation ON conversation.id=handoff.conversation_id WHERE handoff.id=$1`,[sendHandoffId])).rows[0];
      assert.deepEqual(resolveEvidence,{status:"RESOLVED",handoff_version:resolveBefore.handoff_version+1,handoff_resolved:true,
        case_status:"RESOLVED",case_version:resolveBefore.case_version+1,case_resolved:true,conversation_status:"CLOSED",automation_status:"SUSPENDED",
        assigned_user_id:null,conversation_version:resolveBefore.conversation_version+1,closed:true,audits:1,outbox:1,
        disposition:"RESOLVED",outbox_disposition:"RESOLVED",audit_safe:true});
      const historyTieIds=["8a000000-0000-4000-8000-000000000001","8a000000-0000-4000-8000-000000000002",
        "8a000000-0000-4000-8000-000000000003"];
      await target.query(`INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,
        status,assigned_user_id,requested_at,queued_at,claimed_at,resolved_at,idempotency_key,version)
        SELECT fixture.id,handoff.tenant_id,handoff.conversation_id,handoff.service_case_id,handoff.unit_id,
          fixture.reason,fixture.priority,'RESOLVED',NULL,fixture.resolved_at-interval '1 hour',
          fixture.resolved_at-interval '50 minutes',fixture.resolved_at-interval '40 minutes',fixture.resolved_at,
          'history-operational-'||fixture.id::text,fixture.version
        FROM human_handoffs handoff CROSS JOIN (VALUES
          ($2::uuid,'HISTORY_TIE_HIGH','HIGH','2030-01-02T12:00:00.123Z'::timestamptz,7),
          ($3::uuid,'HISTORY_TIE_LEGACY','NORMAL','2030-01-02T12:00:00.123Z'::timestamptz,6),
          ($4::uuid,'HISTORY_OLDER','LOW','2030-01-02T11:00:00.123Z'::timestamptz,5)
        ) fixture(id,reason,priority,resolved_at,version) WHERE handoff.id=$1`,
      [sendHandoffId,...historyTieIds]);
      await target.query(`INSERT INTO handoff_resolve_commands(tenant_id,idempotency_key,handoff_id,expected_version,
        request_fingerprint,actor_id,conversation_id,service_case_id,result_handoff_version,result_conversation_version,
        correlation_id,disposition,unit_id)
        SELECT handoff.tenant_id,'history-operational-command',handoff.id,handoff.version-1,repeat('b',64),$2,
          handoff.conversation_id,handoff.service_case_id,handoff.version,conversation.version,'history-operational-command',
          'DUPLICATE',handoff.unit_id FROM human_handoffs handoff JOIN conversations conversation
          ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id WHERE handoff.id=$1`,
      [historyTieIds[1],actorBId]);
      const historySnapshotBefore=(await target.query(`SELECT
        (SELECT count(*)::int FROM messages) messages,(SELECT count(*)::int FROM audit_events) audit,
        (SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM workflow_transitions) transitions`)).rows[0];
      const historyContext=(actorId,correlationId,callback)=>withTenantTransaction(runtimePool,{
        tenantId:"50000000-0000-4000-8000-000000000002",actorId,correlationId},callback);
      for(const role of["UNIT_MANAGER","SUPERVISOR"]){
        await target.query("UPDATE user_units SET role=$2,status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$3",
          [readerId,role,unitB]);
        const firstPage=await historyContext(readerId,`history-${role}-first`,client=>listResolvedHandoffs(client,{unitId:unitB,limit:1}));
        assert.deepEqual(firstPage.items.map(item=>item.id),[historyTieIds[1]]);
        assert.equal(firstPage.items[0].disposition,"DUPLICATE");
        assert.equal(firstPage.items[0].resolvedByUserId,actorBId);
        assert.equal(firstPage.items[0].resolvedByDisplayName,(await target.query("SELECT display_name FROM users WHERE id=$1",[actorBId])).rows[0].display_name);
        assert.ok(firstPage.nextCursor);
        const secondPage=await historyContext(readerId,`history-${role}-second`,client=>listResolvedHandoffs(client,{unitId:unitB,limit:1,cursor:firstPage.nextCursor}));
        assert.deepEqual(secondPage.items.map(item=>item.id),[historyTieIds[0]]);
        assert.equal(secondPage.items[0].disposition,"LEGACY_UNSPECIFIED");
        assert.ok(secondPage.nextCursor);
        const thirdPage=await historyContext(readerId,`history-${role}-third`,client=>listResolvedHandoffs(client,{unitId:unitB,limit:1,cursor:secondPage.nextCursor}));
        assert.deepEqual(thirdPage.items.map(item=>item.id),[historyTieIds[2]]);
        assert.equal(thirdPage.items[0].disposition,"LEGACY_UNSPECIFIED");
        const closedDetail=await historyContext(readerId,`history-${role}-detail`,client=>getConversation(client,firstMaterialized.conversationId));
        assert.equal(closedDetail.status,"CLOSED");
      }
      for(const role of["ATTENDANT","AUDITOR"]){
        await target.query("UPDATE user_units SET role=$2,status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$3",
          [readerId,role,unitB]);
        await assert.rejects(historyContext(readerId,`history-${role}-denied`,client=>listResolvedHandoffs(client,{unitId:unitB,limit:25})),/RESOLVED_HANDOFF_LIST_NOT_FOUND/);
        await assert.rejects(historyContext(readerId,`history-${role}-detail-denied`,client=>getConversation(client,firstMaterialized.conversationId)),/INBOX_CONVERSATION_NOT_FOUND/);
      }
      await target.query("UPDATE user_units SET role='SUPERVISOR',status='REVOKED',revoked_at=now(),revoked_by_user_id=$1,revocation_reason='History authorization test' WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",
        [readerId,unitB]);
      await assert.rejects(historyContext(readerId,"history-revoked-denied",client=>listResolvedHandoffs(client,{unitId:unitB,limit:25})),/RESOLVED_HANDOFF_LIST_NOT_FOUND/);
      await assert.rejects(historyContext(readerId,"history-revoked-detail-denied",client=>getConversation(client,firstMaterialized.conversationId)),/INBOX_CONVERSATION_NOT_FOUND/);
      await target.query("UPDATE user_units SET role='SUPERVISOR',status='ACTIVE',revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",
        [readerId,unitB]);
      const filteredHistory=(values,correlationId="history-filtered")=>historyContext(readerId,correlationId,async client=>(await client.query(`
        SELECT id,priority,disposition,resolved_at AS "resolvedAt" FROM list_inbox_resolved_handoffs_v3(
          $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8::uuid)`,values)).rows);
      assert.deepEqual((await filteredHistory([unitB,25,"NORMAL","DUPLICATE","2030-01-02T12:00:00.123Z",
        "2030-01-02T12:00:00.124Z",null,null])).map(row=>row.id),[historyTieIds[1]]);
      assert.deepEqual((await filteredHistory([unitB,25,"HIGH",null,"2030-01-02T12:00:00.123Z",
        "2030-01-02T12:00:00.124Z",null,null],"history-priority-filter")).map(row=>row.id),[historyTieIds[0]]);
      assert.deepEqual((await filteredHistory([unitB,25,null,"LEGACY_UNSPECIFIED","2030-01-02T12:00:00.123Z",
        "2030-01-02T12:00:00.124Z",null,null],"history-legacy-filter")).map(row=>row.id),[historyTieIds[0]]);
      assert.deepEqual(await filteredHistory([unitB,25,null,null,"2030-01-02T12:00:00.124Z",
        "2030-01-03T12:00:00.123Z",null,null],"history-half-open-before"),[]);
      const filteredFirst=await filteredHistory([unitB,1,null,null,"2030-01-02T11:00:00.123Z",
        "2030-01-02T12:00:00.124Z",null,null],"history-filter-first");
      assert.deepEqual(filteredFirst.map(row=>row.id),[historyTieIds[1]]);
      const filteredSecond=await filteredHistory([unitB,2,null,null,"2030-01-02T11:00:00.123Z",
        "2030-01-02T12:00:00.124Z",filteredFirst[0].resolvedAt,filteredFirst[0].id],"history-filter-second");
      assert.deepEqual(filteredSecond.map(row=>row.id),[historyTieIds[0],historyTieIds[2]]);
      for(const [label,values] of [
        ["priority",[unitB,25,"CRITICAL",null,null,null,null,null]],
        ["disposition",[unitB,25,null,"FREE_TEXT",null,null,null,null]],
        ["reversed-window",[unitB,25,null,null,"2030-01-03T00:00:00.000Z","2030-01-02T00:00:00.000Z",null,null]],
        ["oversized-window",[unitB,25,null,null,"2029-01-01T00:00:00.000Z","2030-01-03T00:00:00.001Z",null,null]],
        ["partial-anchor",[unitB,25,null,null,null,null,"2030-01-02T12:00:00.123Z",null]],
        ["filter-bound-anchor",[unitB,25,"LOW",null,null,null,"2030-01-02T12:00:00.123Z",historyTieIds[1]]],
      ]) await assert.rejects(filteredHistory(values,`history-invalid-${label}`),
        /INVALID_RESOLVED_HANDOFF_LIST_REQUEST|INVALID_PAGE_CURSOR/);
      const otherHistoryUnit=(await target.query("SELECT id FROM units WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND id<>$1 ORDER BY id LIMIT 1",[unitB])).rows[0].id;
      await assert.rejects(historyContext(readerId,"history-cross-unit",client=>listResolvedHandoffs(client,{unitId:otherHistoryUnit,limit:25})),/RESOLVED_HANDOFF_LIST_NOT_FOUND/);
      await assert.rejects(filteredHistory([otherHistoryUnit,25,null,null,null,null,null,null],"history-filter-cross-unit"),
        /RESOLVED_HANDOFF_LIST_NOT_FOUND/);
      await assert.rejects(withTenantTransaction(runtimePool,{tenantId:"40000000-0000-4000-8000-000000000001",actorId:actorAId,correlationId:"history-cross-tenant"},
        client=>listResolvedHandoffs(client,{unitId:unitB,limit:25})),/RESOLVED_HANDOFF_LIST_NOT_FOUND/);
      const historyCutoff=(await target.query("SELECT closed_at FROM conversations WHERE id=$1",
        [firstMaterialized.conversationId])).rows[0].closed_at.toISOString();
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,body,payload,created_at) VALUES
        ('8b000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',$1,'INBOUND','CUSTOMER','history-before','{"kind":"TEXT","trust":"UNTRUSTED"}',$2::timestamptz-interval '1 second'),
        ('8b000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002',$1,'INBOUND','CUSTOMER','history-after-one','{"kind":"TEXT","trust":"UNTRUSTED"}',$2::timestamptz+interval '1 second'),
        ('8b000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000002',$1,'INBOUND','CUSTOMER','history-after-two','{"kind":"TEXT","trust":"UNTRUSTED"}',$2::timestamptz+interval '2 seconds')`,
      [firstMaterialized.conversationId,historyCutoff]);
      const cutoffPage=await historyContext(readerId,"history-cutoff-before-limit",client=>listConversationMessages(client,
        {conversationId:firstMaterialized.conversationId,limit:25,before:historyCutoff}));
      assert.ok(cutoffPage.items.some(item=>item.body==="history-before"));
      assert.ok(!cutoffPage.items.some(item=>item.body?.startsWith("history-after")));
      const omittedCutoff=await historyContext(readerId,"history-cutoff-omitted",client=>listConversationMessages(client,
        {conversationId:firstMaterialized.conversationId,limit:25}));
      assert.ok(omittedCutoff.items.some(item=>item.body==="history-before"));
      assert.ok(!omittedCutoff.items.some(item=>item.body?.startsWith("history-after")));
      const laterCutoff=await historyContext(readerId,"history-cutoff-later",client=>listConversationMessages(client,
        {conversationId:firstMaterialized.conversationId,limit:25,before:new Date(Date.parse(historyCutoff)+60_000).toISOString()}));
      assert.ok(laterCutoff.items.some(item=>item.body==="history-before"));
      assert.ok(!laterCutoff.items.some(item=>item.body?.startsWith("history-after")));
      const earlierCutoff=await historyContext(readerId,"history-cutoff-earlier",client=>listConversationMessages(client,
        {conversationId:firstMaterialized.conversationId,limit:25,before:new Date(Date.parse(historyCutoff)-1_500).toISOString()}));
      assert.ok(!earlierCutoff.items.some(item=>item.body?.startsWith("history-")));
      await assert.rejects(historyContext(readerId,"history-cutoff-anchor-bypass",client=>client.query(`SELECT * FROM
        list_inbox_conversation_messages_v4($1,25,$2::timestamptz,$3::uuid,$4::timestamptz)`,[
          firstMaterialized.conversationId,new Date(Date.parse(historyCutoff)+1_000).toISOString(),
          "8b000000-0000-4000-8000-000000000002",new Date(Date.parse(historyCutoff)+60_000).toISOString()])),
      /INVALID_INBOX_CONVERSATION_REQUEST/);
      const historyCutoffMillis=Date.parse(historyCutoff);
      assert.ok(Number.isFinite(historyCutoffMillis));
      assert.ok(cutoffPage.items.every(item=>{
        const createdAtMillis=Date.parse(item.createdAt);
        return Number.isFinite(createdAtMillis)&&createdAtMillis<=historyCutoffMillis;
      }));
      const historySnapshotAfter=(await target.query(`SELECT
        (SELECT count(*)::int FROM messages) messages,(SELECT count(*)::int FROM audit_events) audit,
        (SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM workflow_transitions) transitions`)).rows[0];
      assert.deepEqual({...historySnapshotAfter,messages:historySnapshotAfter.messages-3},historySnapshotBefore);
      const reopenSource=(await target.query("SELECT id,version FROM human_handoffs WHERE id=$1",[sendHandoffId])).rows[0];
      const reopenFingerprint=createHash("sha256").update(JSON.stringify({
        expectedVersion:reopenSource.version,handoffId:reopenSource.id.toLowerCase(),reason:"FOLLOW_UP_REQUIRED",
      })).digest("hex");
      const reopenCall=(correlationId,key="history-reopen-key",fingerprint=reopenFingerprint)=>historyContext(readerId,correlationId,
        async client=>(await client.query(`SELECT source_handoff_id AS "sourceHandoffId",handoff_id AS "handoffId",
          handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",
          service_case_version AS "serviceCaseVersion",replayed FROM reopen_inbox_handoff($1,$2,$3,$4,$5)`,
        [reopenSource.id,reopenSource.version,"FOLLOW_UP_REQUIRED",key,fingerprint])).rows[0]);
      const pendingSnapshot=(await target.query(`SELECT (SELECT count(*)::int FROM handoff_reopen_commands) commands,
        (SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM audit_events) audit,
        (SELECT count(*)::int FROM workflow_transitions) workflows`)).rows[0];
      const pendingTarget=await historyContext(readerId,"history-reopen-pending-target",async client=>(await client.query(
        "SELECT reopen_handoff_id FROM list_inbox_resolved_handoffs_v3($1,101,NULL,NULL,NULL,NULL,NULL,NULL) WHERE id=$2",
        [unitB,reopenSource.id])).rows[0]);
      assert.equal(pendingTarget.reopen_handoff_id,null);
      await assert.rejects(reopenCall("history-reopen-pending","history-reopen-pending-key"),/HANDOFF_REOPEN_CONFLICT/);
      assert.deepEqual((await target.query(`SELECT (SELECT count(*)::int FROM handoff_reopen_commands) commands,
        (SELECT count(*)::int FROM outbox_events) outbox,(SELECT count(*)::int FROM audit_events) audit,
        (SELECT count(*)::int FROM workflow_transitions) workflows`)).rows[0],pendingSnapshot);
      await target.query("UPDATE messages SET delivery_status='CANCELLED' WHERE conversation_id=$1 AND direction='OUTBOUND' AND actor='HUMAN' AND delivery_status='QUEUED'",[firstMaterialized.conversationId]);
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",[readerId,unitB]);
      await assert.rejects(reopenCall("history-reopen-attendant"),/HANDOFF_REOPEN_NOT_FOUND/);
      await target.query("UPDATE user_units SET role='SUPERVISOR' WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",[readerId,unitB]);
      const reopenBefore=(await target.query(`SELECT (SELECT count(*)::int FROM handoff_reopen_commands) commands,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.reopened') outbox,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_REOPENED') audit,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='MANAGER_REOPENED') workflows,
        (SELECT to_jsonb(handoff) FROM human_handoffs handoff WHERE id=$1) source_snapshot`,[reopenSource.id])).rows[0];
      const reopened=await reopenCall("history-reopen-success");
      assert.equal(reopened.sourceHandoffId,reopenSource.id);assert.notEqual(reopened.handoffId,reopenSource.id);
      assert.equal(reopened.handoffVersion,1);assert.equal(reopened.replayed,false);
      const replayedReopen=await reopenCall("history-reopen-replay");
      assert.deepEqual({...replayedReopen,replayed:false},reopened);
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",[readerId,unitB]);
      await assert.rejects(reopenCall("history-reopen-replay-downgraded"),/HANDOFF_REOPEN_NOT_FOUND/);
      await target.query("UPDATE user_units SET role='SUPERVISOR' WHERE tenant_id='50000000-0000-4000-8000-000000000002' AND user_id=$1 AND unit_id=$2",[readerId,unitB]);
      assert.equal((await reopenCall("history-reopen-replay-restored")).replayed,true);
      const divergentReplayUnit=await historyContext(readerId,"history-reopen-divergent-unit",async client=>(await client.query(
        `SELECT resolve_inbox_handoff_reopen_unit($1,$2,$3,$4,$5) AS "unitId"`,
        [reopenSource.id,reopenSource.version,"NEW_INFORMATION","history-reopen-key","f".repeat(64)])).rows[0].unitId);
      assert.equal(divergentReplayUnit,unitB);
      await assert.rejects(reopenCall("history-reopen-divergent","history-reopen-key","f".repeat(64)),/HANDOFF_REOPEN_IDEMPOTENCY_CONFLICT/);
      const reopenEvidence=(await target.query(`SELECT source.status::text source_status,source.resolved_at IS NOT NULL source_resolved,
        created.status::text created_status,created.assigned_user_id,created.resolved_at,created.queued_at IS NOT NULL queued,
        extract(epoch FROM created.sla_due_at-created.requested_at) AS sla_duration_seconds,
        extract(epoch FROM source.sla_due_at-source.requested_at) AS source_sla_duration_seconds,
        c.status::text conversation_status,c.automation_status::text,
        c.assigned_user_id conversation_assignee,c.closed_at,sc.status::text case_status,sc.resolved_at case_resolved,
        (SELECT count(*)::int FROM handoff_reopen_commands) commands,
        (SELECT count(*)::int FROM outbox_events WHERE event_type='handoff.reopened') outbox,
        (SELECT count(*)::int FROM audit_events WHERE action='HANDOFF_REOPENED') audit,
        (SELECT count(*)::int FROM workflow_transitions WHERE reason='MANAGER_REOPENED') workflows,
        to_jsonb(source) source_snapshot
        FROM human_handoffs source JOIN human_handoffs created ON created.id=$2
        JOIN conversations c ON c.id=created.conversation_id JOIN service_cases sc ON sc.id=created.service_case_id
        WHERE source.id=$1`,[reopenSource.id,reopened.handoffId])).rows[0];
      assert.deepEqual({source_status:reopenEvidence.source_status,source_resolved:reopenEvidence.source_resolved,
        created_status:reopenEvidence.created_status,assigned_user_id:reopenEvidence.assigned_user_id,
        resolved_at:reopenEvidence.resolved_at,queued:reopenEvidence.queued,conversation_status:reopenEvidence.conversation_status,
        automation_status:reopenEvidence.automation_status,conversation_assignee:reopenEvidence.conversation_assignee,
        closed_at:reopenEvidence.closed_at,case_status:reopenEvidence.case_status,case_resolved:reopenEvidence.case_resolved},
      {source_status:"RESOLVED",source_resolved:true,created_status:"QUEUED",assigned_user_id:null,resolved_at:null,queued:true,
        conversation_status:"OPEN",automation_status:"HUMAN_QUEUED",conversation_assignee:null,closed_at:null,
        case_status:"WAITING_HUMAN",case_resolved:null});
      assert.deepEqual({commands:reopenEvidence.commands-reopenBefore.commands,outbox:reopenEvidence.outbox-reopenBefore.outbox,
        audit:reopenEvidence.audit-reopenBefore.audit,workflows:reopenEvidence.workflows-reopenBefore.workflows},
      {commands:1,outbox:1,audit:1,workflows:3});
      assert.deepEqual(reopenEvidence.source_snapshot,reopenBefore.source_snapshot);
      assert.equal(reopenEvidence.sla_duration_seconds,reopenEvidence.source_sla_duration_seconds);
      await target.query(`UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=100,
        pause_reason=NULL,paused_until=NULL WHERE tenant_id=$1 AND user_id=$2 AND unit_id=$3`,
        ["50000000-0000-4000-8000-000000000002",readerId,unitB]);
      const closeEpisode=async(handoffId,version,label)=>{
        const claimed=await historyContext(readerId,`${label}-claim`,client=>claimHandoff(client,{handoffId,expectedVersion:version,idempotencyKey:`${label}-claim-key`}));
        return await historyContext(readerId,`${label}-resolve`,client=>resolveHandoff(client,{handoffId,
          expectedVersion:claimed.version,disposition:"RESOLVED",idempotencyKey:`${label}-resolve-key`}));
      };
      const secondResolved=await closeEpisode(reopened.handoffId,reopened.handoffVersion,"reopen-cycle-two");
      const latestTargets=await historyContext(readerId,"history-reopen-latest-target",async client=>(await client.query(
        `SELECT id,reopen_handoff_id AS "reopenHandoffId" FROM list_inbox_resolved_handoffs_v3($1,101,NULL,NULL,NULL,NULL,NULL,NULL)
         WHERE id=ANY($2::uuid[]) ORDER BY id`,[unitB,[reopenSource.id,reopened.handoffId]])).rows);
      assert.equal(latestTargets.find(row=>row.id===reopenSource.id).reopenHandoffId,null);
      assert.equal(latestTargets.find(row=>row.id===reopened.handoffId).reopenHandoffId,reopened.handoffId);
      await assert.rejects(reopenCall("history-reopen-stale-source","history-reopen-stale-key"),/HANDOFF_REOPEN_CONFLICT/);
      const concurrentReopen=(source,reason,key,pool,correlationId)=>withTenantTransaction(pool,{tenantId:"50000000-0000-4000-8000-000000000002",
        actorId:readerId,correlationId},async client=>{const fingerprint=createHash("sha256").update(JSON.stringify({
          expectedVersion:source.version,handoffId:source.id.toLowerCase(),reason})).digest("hex");return(await client.query(
          `SELECT source_handoff_id AS "sourceHandoffId",handoff_id AS "handoffId",handoff_version AS "handoffVersion",replayed
           FROM reopen_inbox_handoff($1,$2,$3,$4,$5)`,[source.id,source.version,reason,key,fingerprint])).rows[0]});
      const sourceTwo={id:reopened.handoffId,version:secondResolved.handoffVersion};
      const crossSourceKey="reopen-cross-source-key";
      const crossSource=await Promise.allSettled([
        concurrentReopen(sourceTwo,"NEW_INFORMATION",crossSourceKey,runtimePool,"reopen-cross-source-a"),
        concurrentReopen(reopenSource,"NEW_INFORMATION",crossSourceKey,competingRuntimePool,"reopen-cross-source-b"),
      ]);
      assert.equal(crossSource.filter(result=>result.status==="fulfilled").length,1);
      assert.equal(crossSource.filter(result=>result.status==="rejected"&&/HANDOFF_REOPEN_(?:IDEMPOTENCY_)?CONFLICT/.test(String(result.reason))).length,1);
      const crossWinner=crossSource.find(result=>result.status==="fulfilled").value;
      assert.equal(crossWinner.sourceHandoffId,sourceTwo.id);
      const thirdResolved=await closeEpisode(crossWinner.handoffId,crossWinner.handoffVersion,"reopen-cycle-three");
      const sourceThree={id:crossWinner.handoffId,version:thirdResolved.handoffVersion};
      const sameSource=await Promise.allSettled([
        concurrentReopen(sourceThree,"OPERATIONAL_CORRECTION","reopen-same-source-key-a",runtimePool,"reopen-same-source-a"),
        concurrentReopen(sourceThree,"OPERATIONAL_CORRECTION","reopen-same-source-key-b",competingRuntimePool,"reopen-same-source-b"),
      ]);
      assert.equal(sameSource.filter(result=>result.status==="fulfilled").length,1);
      assert.equal(sameSource.filter(result=>result.status==="rejected"&&/HANDOFF_REOPEN_CONFLICT/.test(String(result.reason))).length,1);
      const resolvePrivileges=(await target.query(`SELECT has_function_privilege('zap_pronto_api','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') api,
        has_function_privilege('zap_pronto_worker','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') worker,
        has_function_privilege('zap_pronto_app','resolve_inbox_handoff(uuid,integer,text,text,text)','EXECUTE') app,
        has_function_privilege('zap_pronto_api','resolve_inbox_handoff_legacy_v0027(uuid,integer,text,text)','EXECUTE') legacy_api,
        has_table_privilege('zap_pronto_api','handoff_resolve_commands','SELECT') command_select`)).rows[0];
      assert.deepEqual(resolvePrivileges,{api:true,worker:false,app:false,legacy_api:false,command_select:false});

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
        UPDATE conversations SET status='CLOSED',closed_at=now()
        WHERE id='44000000-0000-4000-8000-000000000001';
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
        UPDATE conversations SET status='CLOSED',closed_at=now()
        WHERE id='64000000-0000-4000-8000-000000000009';
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
        UPDATE conversations SET status='CLOSED',closed_at=now()
        WHERE id='64000000-0000-4000-8000-000000000006';
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
      for (const [roleCode, canClaim] of [
        ["UNIT_MANAGER", true], ["SUPERVISOR", true], ["ATTENDANT", true], ["AUDITOR", false],
      ]) {
        await target.query("UPDATE user_units SET role=$1 WHERE user_id=$2", [roleCode, actorWithoutUnit]);
        assert.deepEqual(await permissionMatrix(actorWithoutUnit), {
          pool_a_claim: false, pool_a2_claim: canClaim, tenant_users_manage: false,
          unknown_permission: false, cross_tenant_unit: false,
        }, `RBAC_MATRIX_${roleCode}`);
      }
      await target.query("UPDATE user_units SET role='ATTENDANT' WHERE user_id=$1", [actorWithoutUnit]);
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

      const httpLifecycleTargetId = "6a000000-0000-4000-8000-000000000010";
      const httpBlockedUserId = "6a000000-0000-4000-8000-000000000011";
      await target.query("UPDATE user_units SET role='TENANT_ADMIN' WHERE user_id=$1", [actorBId]);
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name) VALUES
          ($1,'40000000-0000-4000-8000-000000000001','http-target@test.local','HTTP Target')`,
      [httpLifecycleTargetId]);
      await target.query(`INSERT INTO users (id,tenant_id,email,display_name,status,blocked_at) VALUES
          ($1,'40000000-0000-4000-8000-000000000001','http-blocked@test.local','HTTP Blocked','BLOCKED',now())`,
      [httpBlockedUserId]);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
          SELECT tenant_id,$1,id,'ATTENDANT' FROM units
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`,
      [httpLifecycleTargetId]);
      await target.query(`INSERT INTO user_units (tenant_id,user_id,unit_id,role)
          SELECT tenant_id,$1,id,'AUDITOR' FROM units
          WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A2'`,
      [httpBlockedUserId]);
      await target.query(`INSERT INTO user_oidc_identities (tenant_id,user_id,oidc_provider_id,subject) VALUES
          ('40000000-0000-4000-8000-000000000001',$1,'61000000-0000-4000-8000-000000000001','http-target-subject'),
          ('40000000-0000-4000-8000-000000000001',$2,'61000000-0000-4000-8000-000000000001','http-blocked-subject'),
          ('40000000-0000-4000-8000-000000000001',$3,'61000000-0000-4000-8000-000000000001','http-admin-subject')
      `, [httpLifecycleTargetId, httpBlockedUserId, tenantAdminId]);

      const { privateKey: httpPrivateKey, publicKey: httpPublicKey } = await generateKeyPair("RS256");
      const httpPublicJwk = await exportJWK(httpPublicKey);
      const jwksServer = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [{ ...httpPublicJwk, kid: "db-http-key", use: "sig", alg: "RS256" }] }));
      });
      await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
      try {
        const jwksAddress = jwksServer.address();
        assert.ok(jwksAddress && typeof jwksAddress === "object");
        const signedToken = (subject, organization, email) => new SignJWT({
          org_id: organization, email, email_verified: true,
        }).setProtectedHeader({ alg: "RS256", kid: "db-http-key" })
          .setIssuer("https://identity.test").setAudience("zap-pronto").setSubject(subject)
          .setExpirationTime("5m").sign(httpPrivateKey);
        const [adminToken, tenantBToken, targetToken, blockedToken] = await Promise.all([
          signedToken("http-admin-subject", "tenant-a", "tenant-admin-a@test.local"),
          signedToken("shared-subject", "tenant-b", "actor-b@test.local"),
          signedToken("http-target-subject", "tenant-a", "http-target@test.local"),
          signedToken("http-blocked-subject", "tenant-a", "http-blocked@test.local"),
        ]);
        const signedHttpApp = await buildApp({ pool: runtimePool, identityVerifier: createOidcIdentityVerifier({
          issuer: "https://identity.test", audience: "zap-pronto",
          jwksUrl: `http://127.0.0.1:${jwksAddress.port}/jwks`, organizationClaim: "org_id",
        }) });
        try {
          const auth = (token) => ({ authorization: `Bearer ${token}` });
          const adminList = await signedHttpApp.inject({ method: "GET", url: "/v1/users", headers: auth(adminToken) });
          assert.equal(adminList.statusCode, 200);
          assert.ok(adminList.json().items.every((item) => item.id !== actorBId), "HTTP_CROSS_TENANT_LIST_LEAK");
          const injectedUnitScope = await signedHttpApp.inject({ method: "GET", url: "/v1/users?unitId="
            + crossTenantUnitId, headers: auth(adminToken) });
          assert.equal(injectedUnitScope.statusCode, 200);
          assert.ok(injectedUnitScope.json().items.every((item) => item.id !== actorBId),
            "HTTP_CLIENT_SCOPE_INJECTION_LEAK");
          const tenantBAdminAttempt = await signedHttpApp.inject({ method: "POST",
            url: `/v1/users/${httpLifecycleTargetId}/status`, headers: { ...auth(tenantBToken),
              "idempotency-key": "http-cross-tenant-status" },
            payload: { action: "BLOCK", expectedVersion: 1, reason: "Cross tenant attempt" } });
          assert.equal(tenantBAdminAttempt.statusCode, 404);
          const staleStatus = await signedHttpApp.inject({ method: "POST",
            url: `/v1/users/${httpLifecycleTargetId}/status`, headers: { ...auth(adminToken),
              "idempotency-key": "http-stale-version" },
            payload: { action: "BLOCK", expectedVersion: 99, reason: "Stale version attempt" } });
          assert.equal(staleStatus.statusCode, 409);
          const revokedStatus = await signedHttpApp.inject({ method: "POST",
            url: `/v1/users/${httpLifecycleTargetId}/status`, headers: { ...auth(adminToken),
              "idempotency-key": "http-revoke-target" },
            payload: { action: "REVOKE", expectedVersion: 1, reason: "Security revocation" } });
          assert.equal(revokedStatus.statusCode, 200);
          const revokedMe = await signedHttpApp.inject({ method: "GET", url: "/v1/me", headers: auth(targetToken) });
          assert.equal(revokedMe.statusCode, 401);
          const blockedMe = await signedHttpApp.inject({ method: "GET", url: "/v1/me", headers: auth(blockedToken) });
          assert.equal(blockedMe.statusCode, 401);
          const revocationEvidence = await target.query(`SELECT account.status,identity.status AS identity_status
            FROM users account JOIN user_oidc_identities identity
              ON identity.tenant_id=account.tenant_id AND identity.user_id=account.id WHERE account.id=$1`,
          [httpLifecycleTargetId]);
          assert.deepEqual(revocationEvidence.rows[0], { status: "REVOKED", identity_status: "REVOKED" });

          const preProvisioningToken = "r".repeat(43);
          const preProvisioningDigest = createHash("sha256").update(preProvisioningToken).digest();
          const preProvisioningInvitationId = "6a000000-0000-4000-8000-000000000012";
          await target.query(`INSERT INTO user_invitations
            (id,tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
            VALUES ($1,'40000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',
              'http-target@test.local','No resurrection',$2,now()+interval '1 hour',$3)`,
          [preProvisioningInvitationId, preProvisioningDigest, tenantAdminId]);
          await target.query(`INSERT INTO user_invitation_units (tenant_id,invitation_id,unit_id,role)
            SELECT tenant_id,$1,id,'ATTENDANT' FROM units
            WHERE tenant_id='40000000-0000-4000-8000-000000000001' AND code='POOL-A'`,
          [preProvisioningInvitationId]);
          const revokedPreProvisioning = await signedHttpApp.inject({ method: "POST",
            url: "/v1/auth/invitations/accept", headers: { ...auth(targetToken),
              "idempotency-key": "http-revoked-preprovision" },
            payload: { invitationToken: preProvisioningToken } });
          assert.equal(revokedPreProvisioning.statusCode, 403);
          const noResurrection = await target.query("SELECT status FROM users WHERE id=$1", [httpLifecycleTargetId]);
          assert.equal(noResurrection.rows[0].status, "REVOKED");
        } finally {
          await signedHttpApp.close();
        }
      } finally {
        await new Promise((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
      }

      const outboundFixtureMessage="7f000000-0000-4000-8000-000000000001";
      const outboundFixtureEvent="7f000000-0000-4000-8000-000000000002";
      await target.query(`UPDATE channel_connections connection SET status='CONNECTED'
        FROM conversations conversation WHERE conversation.id=$1
          AND connection.tenant_id=conversation.tenant_id AND connection.id=conversation.channel_connection_id`,
      [firstMaterialized.conversationId]);
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,body,payload,delivery_status)
        SELECT $1,tenant_id,id,'OUTBOUND','HUMAN','Fundacao outbound','{"kind":"TEXT"}','QUEUED'
        FROM conversations WHERE id=$2`,[outboundFixtureMessage,firstMaterialized.conversationId]);
      await target.query(`INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,payload_version,max_attempts)
        VALUES($1,'50000000-0000-4000-8000-000000000002','message',$2,'channel.outbound.requested','{}',$3,1,2)`,
      [outboundFixtureEvent,outboundFixtureMessage,`outbound-foundation-${randomBytes(4).toString("hex")}`]);
      const claimOutbound=async(pool)=>{const client=await pool.connect();try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
        const result=await client.query("SELECT * FROM claim_outbound_delivery_events(100,60)");await client.query("COMMIT");return result.rows;
      }finally{client.release();}};
      const outboundClaims=(await claimOutbound(workerPool)).filter(row=>row.outbox_id===outboundFixtureEvent);
      assert.equal(outboundClaims.length,1);assert.equal(outboundClaims[0].tenant_id,"50000000-0000-4000-8000-000000000002");
      assert.equal(outboundClaims[0].body,"Fundacao outbound");
      const staleToken="7f000000-0000-4000-8000-000000000003";
      const workerCommand=async(sql,values)=>{const client=await workerPool.connect();try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
        const result=await client.query(sql,values);await client.query("COMMIT");return result.rows[0];}finally{client.release();}};
      assert.equal((await workerCommand("SELECT finalize_outbound_delivery_event($1,$2,$3) finalized",
        [outboundFixtureEvent,staleToken,"provider-stale"])).finalized,false);
      assert.equal((await workerCommand("SELECT fail_outbound_delivery_event($1,$2,$3,1)::text status",
        [outboundFixtureEvent,outboundClaims[0].lease_token,"OUTBOUND_TEMPORARY"])).status,"PENDING");
      assert.deepEqual((await target.query("SELECT delivery_status,external_message_id FROM messages WHERE id=$1",
        [outboundFixtureMessage])).rows[0],{delivery_status:"QUEUED",external_message_id:null});
      await target.query("UPDATE outbox_events SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[outboundFixtureEvent]);
      const secondClaim=(await claimOutbound(competingWorkerPool)).find(row=>row.outbox_id===outboundFixtureEvent);
      assert.ok(secondClaim);assert.notEqual(secondClaim.lease_token,outboundClaims[0].lease_token);
      assert.equal((await workerCommand("SELECT finalize_outbound_delivery_event($1,$2,$3) finalized",
        [outboundFixtureEvent,secondClaim.lease_token,"provider-real-001"])).finalized,true);
      assert.deepEqual((await target.query(`SELECT message.delivery_status,message.external_message_id,event.status,event.published_at IS NOT NULL published
        FROM messages message JOIN outbox_events event ON event.tenant_id=message.tenant_id AND event.aggregate_id=message.id
        WHERE message.id=$1`,[outboundFixtureMessage])).rows[0],
      {delivery_status:"SENT",external_message_id:"provider-real-001",status:"PUBLISHED",published:true});
      const deadMessage="7f000000-0000-4000-8000-000000000004",deadEvent="7f000000-0000-4000-8000-000000000005";
      await target.query(`INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,body,payload,delivery_status)
        SELECT $1,tenant_id,id,'OUTBOUND','HUMAN','Falha definitiva','{"kind":"TEXT"}','QUEUED'
        FROM conversations WHERE id=$2`,[deadMessage,firstMaterialized.conversationId]);
      await target.query(`INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,payload_version,max_attempts)
        VALUES($1,'50000000-0000-4000-8000-000000000002','message',$2,'channel.outbound.requested','{}',$3,1,1)`,
      [deadEvent,deadMessage,`outbound-dead-${randomBytes(4).toString("hex")}`]);
      const deadClaim=(await claimOutbound(workerPool)).find(row=>row.outbox_id===deadEvent);assert.ok(deadClaim);
      assert.equal((await workerCommand("SELECT fail_outbound_delivery_event($1,$2,$3,1)::text status",
        [deadEvent,deadClaim.lease_token,"OUTBOUND_PROVIDER_REJECTED"])).status,"DEAD");
      assert.deepEqual((await target.query(`SELECT message.delivery_status,event.status,event.dead_lettered_at IS NOT NULL dead,
        (SELECT count(*)::int FROM audit_events WHERE action='OUTBOUND_DELIVERY_DEAD_LETTERED' AND entity_id=message.id::text) audit
        FROM messages message JOIN outbox_events event ON event.tenant_id=message.tenant_id AND event.aggregate_id=message.id
        WHERE message.id=$1`,[deadMessage])).rows[0],{delivery_status:"FAILED",status:"DEAD",dead:true,audit:1});
      const outboundPrivileges=await target.query(`SELECT
        has_function_privilege('zap_pronto_worker','claim_outbound_delivery_events(integer,integer)','EXECUTE') worker_claim,
        has_function_privilege('zap_pronto_api','claim_outbound_delivery_events(integer,integer)','EXECUTE') api_claim,
        has_function_privilege('zap_pronto_worker','finalize_outbound_delivery_event(uuid,uuid,text)','EXECUTE') worker_finalize,
        has_function_privilege('zap_pronto_api','finalize_outbound_delivery_event(uuid,uuid,text)','EXECUTE') api_finalize`);
      assert.deepEqual(outboundPrivileges.rows[0],{worker_claim:true,api_claim:false,worker_finalize:true,api_finalize:false});

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
      closingPools = true;
      await runtimePool.end();
      await competingRuntimePool.end();
      await workerPool.end();
      await competingWorkerPool.end();
      await concurrentMaterializerPool.end();
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
