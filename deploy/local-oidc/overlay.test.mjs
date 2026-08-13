import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const directory = new URL("./", import.meta.url);

test("realm local usa SPA publica com PKCE e redirects exatos", async () => {
  const realm = JSON.parse(await readFile(new URL("zap-pronto-local-realm.json", directory), "utf8"));
  const client = realm.clients.find((candidate) => candidate.clientId === "zap-pronto-local");

  assert.ok(client);
  assert.equal(realm.accessTokenLifespan, 30);
  assert.ok(realm.ssoSessionIdleTimeout > realm.accessTokenLifespan);
  assert.equal(client.publicClient, true);
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.implicitFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.serviceAccountsEnabled, false);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.deepEqual(client.redirectUris, ["${LOCAL_OIDC_ORIGIN}/"]);
  assert.deepEqual(client.webOrigins, ["${LOCAL_OIDC_ORIGIN}"]);
  assert.equal(JSON.stringify(client).includes("*"), false);
  assert.equal(realm.users.length, 3);
  for (const user of realm.users) {
    assert.match(user.email, /@example\.test$/);
    assert.match(user.credentials[0].value, /^\$\{LOCAL_OIDC_(ADMIN|ATTENDANT|ATTENDANT_TWO)_PASSWORD\}$/);
  }
});

test("edge preserva variaveis nginx e nunca registra query OAuth", async () => {
  const [compose, edge] = await Promise.all([
    readFile(new URL("compose.yaml", directory), "utf8"),
    readFile(new URL("edge.conf.template", directory), "utf8"),
  ]);

  assert.match(compose, /NGINX_ENVSUBST_FILTER: "\^\(LOCAL_OIDC_HOST\)\$"/);
  assert.match(compose, /127\.0\.0\.1:\$\{LOCAL_HTTPS_PORT:-18443\}:18443/);
  assert.match(compose,/worker:[\s\S]*profiles: \["local-worker-disabled"\]/);
  assert.match(compose, /GET \/health\/ready HTTP\/1\.1/);
  assert.match(compose, /LOCAL_OIDC_ATTENDANT_TWO_PASSWORD: \$\{LOCAL_OIDC_ATTENDANT_TWO_PASSWORD:\?required\}/);
  assert.match(compose, /\/dev\/tcp\/127\.0\.0\.1\/9000/);
  assert.match(edge, /log_format zap_local_safe/);
  assert.match(edge, /\$request_method \$uri \$server_protocol/);
  assert.doesNotMatch(edge, /\$request(?:\s|')|\$request_uri|\$args|\$http_referer/);
  assert.match(edge, /proxy_set_header Host \$host/);
  assert.match(edge, /resolver 127\.0\.0\.11 valid=5s ipv6=off;/);
  assert.match(edge, /set \$zap_local_web_upstream http:\/\/web:8080;/);
  assert.match(edge, /proxy_pass \$zap_local_web_upstream;/);
  assert.match(edge, /set \$zap_local_keycloak_upstream http:\/\/keycloak:8080;/);
  assert.match(edge, /proxy_pass \$zap_local_keycloak_upstream;/);
  assert.doesNotMatch(edge, /proxy_pass http:\/\/(?:web|keycloak):8080/);
});

test("seed local restaura contas sinteticas para ACTIVE de forma idempotente", async () => {
  const seed = await readFile(new URL("seed.sql", directory), "utf8");
  assert.match(seed, /status='ACTIVE',[\s\S]*blocked_at=NULL,revoked_at=NULL/);
  assert.match(seed,/persist_inbound_channel_event\([\s\S]*materialize_inbound_channel_event/);
  assert.match(seed,/'QUEUED'[\s\S]*local-e2e-handoff/);
  assert.match(seed,/DELETE FROM handoff_claim_commands[\s\S]*DELETE FROM handoff_transfer_commands[\s\S]*DELETE FROM handoff_takeover_commands[\s\S]*event_type IN\('handoff\.claimed','handoff\.resolved','handoff\.requeued','handoff\.transferred','handoff\.taken_over'\)/);
  assert.match(seed,/DELETE FROM workflow_transitions[\s\S]*reason='MANAGER_REOPENED'[\s\S]*DELETE FROM handoff_reopen_commands[\s\S]*source_handoff_id='90000000-0000-4000-8000-000000000060'[\s\S]*idempotency_key LIKE 'reopen:%'/);
  assert.match(seed,/HANDOFF_TAKEN_OVER[\s\S]*SUPERVISOR_TAKEOVER/);
  assert.match(seed,/DELETE FROM human_text_message_commands/);
  assert.match(seed,/DELETE FROM human_text_message_cancel_commands/);
  assert.match(seed,/event_type='channel\.outbound\.requested'/);
  assert.match(seed,/message\.direction='OUTBOUND'/);
  assert.match(seed,/wamid\.local\.synthetic\.status\.001/);
  assert.match(seed,/meta_delivery_status_applications[\s\S]*meta_delivery_status_receipts/);
  assert.match(seed,/set_config\('session_replication_role','replica',true\)[\s\S]*set_config\('session_replication_role','origin',true\)/);
  assert.match(seed,/UPDATE human_handoffs SET status='QUEUED'[\s\S]*UPDATE conversations SET status='OPEN',closed_at=NULL,automation_status='HUMAN_QUEUED'/);
  assert.match(seed, /'90000000-0000-4000-8000-000000000012'[\s\S]*'90000000-0000-4000-8000-000000000002','UNIT_MANAGER'/);
  assert.match(seed, /'CORPORATE','local-e2e-routing-account','ACTIVE'/);
  assert.match(seed, /local-e2e-routing-account'[\s\S]*NULL,'UNROUTED','MULTIPLE_ACTIVE_UNITS'/);
  assert.match(seed, /DELETE FROM inbound_routing_commands[\s\S]*DELETE FROM inbound_channel_events/);
  assert.match(seed,/DELETE FROM attendant_availability_commands[\s\S]*INSERT INTO attendant_unit_availability[\s\S]*'AVAILABLE',100,NULL,NULL,1/);
  assert.match(seed,/DELETE FROM unit_operational_timezone_commands[\s\S]*DELETE FROM unit_operational_timezone_versions/);
  assert.match(seed,/DELETE FROM unit_shift_schedule_commands[\s\S]*DELETE FROM unit_shift_schedule_versions/);
  assert.match(seed,/DELETE FROM handoff_sla_acknowledge_commands[\s\S]*SLA_ALERT_ACKNOWLEDGED[\s\S]*DELETE FROM handoff_sla_acknowledgements/);
  assert.match(seed,/sla_due_at=NULL[\s\S]*queued_at=clock_timestamp\(\)-interval '30 minutes'/);
});

test("controlador isola volumes pelo project name local fixo", async () => {
  const controller = await readFile(new URL("local-oidc.ps1", directory), "utf8");
  assert.match(controller, /\$projectName = 'zap-pronto-local-oidc'/);
  assert.match(controller, /'compose','--project-name',\$projectName/);
  assert.match(controller,/DATABASE_WORKER_URL_FILE[\s\S]*database-worker-url/);
  assert.match(controller,/LOCAL_HARNESS_MARKER_REQUIRED/);
  assert.match(controller,/LOCAL_HARNESS_MARKER_MISMATCH/);
  assert.match(controller,/LOCAL_HARNESS_UNEXPECTED_CONTAINER/);
  assert.match(controller,/LOCAL_HARNESS_UNEXPECTED_VOLUME/);
  assert.match(controller,/function Assert-LocalPrerequisites/);
  assert.match(controller,/LOCAL_OIDC_NODE_24_REQUIRED/);
  assert.match(controller,/LOCAL_OIDC_DOCKER_DAEMON_REQUIRED/);
  assert.match(controller,/LOCAL_OIDC_DOCKER_COMPOSE_REQUIRED/);
  assert.match(controller,/LOCAL_OIDC_E2E_DEPENDENCIES_REQUIRED/);
  assert.match(controller,/LOCAL_OIDC_CHROMIUM_REQUIRED/);
  assert.match(controller,/function Setup \{\s*Assert-LocalPrerequisites/);
  assert.match(controller,/function Up \{\s*Assert-LocalPrerequisites/);
  assert.match(controller,/function E2E \{\s*Assert-LocalPrerequisites -ForE2E/);
  assert.match(controller,/x509 -checkend 604800/);
  assert.match(controller,/x509 -pubkey/);
  assert.match(controller,/pkey -pubout/);
  assert.match(controller,/LOCAL_OIDC_CERTIFICATE_REPLACEMENT_INVALID/);
  assert.match(controller,/previousTrusted\.Thumbprint/);
  assert.match(controller,/Read-InboxImmutableSnapshot[\s\S]*LOCAL_OIDC_CLAIM_REQUEUE_STATE_INVALID/);
  assert.match(controller,/event_type='handoff\.claimed'/);
  assert.match(controller,/--grep','atendente altera a própria disponibilidade'[\s\S]*attendant_unit_availability[\s\S]*attendant_availability_commands[\s\S]*LOCAL_OIDC_ATTENDANT_AVAILABILITY_STATE_INVALID/);
  assert.match(controller,/--grep','gestor consulta disponibilidade da equipe sob demanda'[\s\S]*Compose @\('run','--rm','local-seed'\)/);
  assert.match(controller,/resposta humana TEXT/);
  assert.match(controller,/LOCAL_OIDC_HUMAN_TEXT_STATE_INVALID/);
  assert.match(controller,/cancelamento local mantém TEXT/);
  assert.match(controller,/LOCAL_OIDC_HUMAN_TEXT_CANCEL_STATE_INVALID/);
  assert.match(controller,/transfere atendimento entre dois atendentes/);
  assert.match(controller,/LOCAL_OIDC_HANDOFF_TRANSFER_STATE_INVALID/);
  assert.match(controller,/--grep','gestor consulta atendimento encerrado'/);
  assert.match(controller,/--grep','gestor reconhece alerta de SLA uma única vez por versão'/);
  assert.match(controller,/--grep','gestor configura a primeira política de SLA uma única vez'/);
  assert.match(controller,/unit_sla_policy_versions[\s\S]*unit_sla_policy_targets[\s\S]*unit_sla_policy_publish_commands[\s\S]*SLA_POLICY_PUBLISHED[\s\S]*LOCAL_OIDC_SLA_POLICY_STATE_INVALID/);
  assert.match(controller,/--grep','gestor configura o fuso operacional uma única vez sem efeitos externos'[\s\S]*unit_operational_timezone_versions[\s\S]*unit_operational_timezone_commands[\s\S]*UNIT_OPERATIONAL_TIMEZONE_CONFIGURED[\s\S]*LOCAL_OIDC_OPERATIONAL_TIMEZONE_STATE_INVALID/);
  assert.match(controller,/LOCAL_OIDC_OPERATIONAL_TIMEZONE_STATE_INVALID[\s\S]*--grep','gestor publica uma escala semanal observacional uma única vez'[\s\S]*LOCAL_OIDC_SHIFT_SCHEDULE_STATE_INVALID[\s\S]*Compose @\('run','--rm','local-seed'\)[\s\S]*--grep','gestor reconhece alerta de SLA/);
  assert.match(controller,/--grep','gestor publica uma escala semanal observacional uma única vez'[\s\S]*unit_shift_schedule_versions[\s\S]*unit_shift_schedule_commands[\s\S]*SHIFT_SCHEDULE_PUBLISHED[\s\S]*LOCAL_OIDC_SHIFT_SCHEDULE_STATE_INVALID/);
  assert.match(controller,/scheduleOperationalBefore[\s\S]*gestor publica uma escala semanal observacional uma única vez[\s\S]*scheduleOperationalAfter[\s\S]*LOCAL_OIDC_SHIFT_SCHEDULE_MUTATED_OPERATIONAL_STATE/);
  assert.match(controller,/--grep-invert'[\s\S]*gestor configura a primeira política de SLA uma única vez/);
  assert.match(controller,/--grep-invert'[\s\S]*gestor configura o fuso operacional uma única vez sem efeitos externos/);
  assert.match(controller,/--grep-invert'[\s\S]*gestor publica uma escala semanal observacional uma única vez/);
  assert.match(controller,/handoff_sla_acknowledgements[\s\S]*handoff_version IN\(1,3\)[\s\S]*handoff_sla_acknowledge_commands[\s\S]*expected_version IN\(1,3\)[\s\S]*SLA_ALERT_ACKNOWLEDGED/);
  assert.match(controller,/status='QUEUED' AND version=3 AND assigned_user_id IS NULL AND claimed_at IS NULL/);
  assert.match(controller,/LOCAL_OIDC_SLA_ALERT_ACKNOWLEDGEMENT_STATE_INVALID/);
  assert.match(controller,/LOCAL_OIDC_HANDOFF_HISTORY_MUTATED_STATE/);
  assert.match(controller,/--grep','gestor reabre atendimento encerrado uma única vez'/);
  assert.match(controller,/handoff_reopen_commands[\s\S]*HANDOFF_REOPENED[\s\S]*handoff\.reopened[\s\S]*MANAGER_REOPENED[\s\S]*LOCAL_OIDC_HANDOFF_REOPEN_STATE_INVALID/);
  assert.match(controller,/--grep-invert'[\s\S]*gestor reabre atendimento encerrado uma única vez/);
  assert.match(controller,/--grep','gestor assume atendimento supervisionado'/);
  assert.match(controller,/handoff_takeover_commands[\s\S]*HANDOFF_TAKEN_OVER[\s\S]*handoff\.taken_over[\s\S]*SUPERVISOR_TAKEOVER[\s\S]*LOCAL_OIDC_HANDOFF_TAKEOVER_STATE_INVALID/);
  assert.match(controller,/E2E_MANAGER_USERNAME='attendant\.two\.local'/);
  assert.match(controller,/E2E_OIDC_TARGET='local'/);
  assert.match(controller,/E2E_MANAGER_PASSWORD=\$v\.LOCAL_OIDC_ATTENDANT_TWO_PASSWORD/);
  assert.match(controller,/Compose @\('run','--rm','local-seed'\)[\s\S]*--grep','gestor administra vínculos da unidade'/);
  assert.match(controller,/LOCAL_OIDC_SYNTHETIC_MANAGER_MEMBERSHIP_INVALID/);
  assert.match(controller,/--grep','admin encaminha entrada sem unidade'/);
  assert.match(controller,/routing_status='ROUTED'[\s\S]*event_type='channel\.inbound\.received'[\s\S]*LOCAL_OIDC_INBOUND_ROUTING_STATE_INVALID/);
  assert.match(controller,/finally\{Compose @\('run','--rm','local-seed'\)/);
  assert.match(controller,/reconciliação sintética local/);
  assert.match(controller,/LOCAL_OIDC_META_STATUS_STATE_INVALID/);
  assert.match(controller,/event_type='channel\.outbound\.requested'/);
  assert.match(controller,/Assert-HarnessMarker;Assert-ProjectResources;Compose @\('down','--volumes'\)/);
  assert.doesNotMatch(controller, /system\s+prune|volume\s+prune/);
});

test("Playwright recusa origem externa ou nonce ausente antes do browser",async()=>{const spec=await readFile(new URL("../../apps/web/e2e/shell-oidc.spec.ts",directory),"utf8");
  assert.match(spec,/E2E_LOCAL_DESTRUCTIVE_ALLOWED/);assert.match(spec,/https:\/\/zap-pronto\.127\.0\.0\.1\.nip\.io:18443/);
  assert.match(spec,/E2E_LOCAL_INSTANCE_NONCE/);assert.match(spec,/E2E_LOCAL_HARNESS_AUTHORIZATION_REQUIRED/);
  assert.match(spec,/gestor consulta disponibilidade da equipe sob demanda[\s\S]*gets[\s\S]*Atendente Local[\s\S]*Capacidade: 0\/100 · Restante: 100[\s\S]*selectOption\("PAUSED"\)[\s\S]*mutations\)\.toEqual\(\[\]\)[\s\S]*externalHosts\)\.toEqual\(\[\]\)/);});
