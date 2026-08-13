BEGIN;
SELECT set_config('app.local_seed_meta_status',:'seed_meta_status',false);
CREATE TABLE IF NOT EXISTS local_harness_sentinel(instance_nonce text PRIMARY KEY,project_name text NOT NULL,origin text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
SELECT 1 / ((current_database()='zap_pronto' AND current_user='zap_pronto_owner'
  AND :'harness_project'='zap-pronto-local-oidc' AND :'harness_origin'='https://zap-pronto.127.0.0.1.nip.io:18443'
  AND :'harness_nonce'~'^[A-Za-z0-9_-]{32,128}$')::integer) AS local_harness_sentinel_valid;
INSERT INTO local_harness_sentinel(instance_nonce,project_name,origin) VALUES(:'harness_nonce',:'harness_project',:'harness_origin')
ON CONFLICT(instance_nonce) DO UPDATE SET project_name=EXCLUDED.project_name,origin=EXCLUDED.origin;
INSERT INTO tenants (id,name,status) VALUES ('90000000-0000-4000-8000-000000000001','Clínica Local','ACTIVE')
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status='ACTIVE';
INSERT INTO units (id,tenant_id,code,name,active) VALUES
('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','LOCAL','Unidade Local',true),
('90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000001','LOCAL-ALT','Unidade Local Alternativa',true)
ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name,active=true;
INSERT INTO users (id,tenant_id,email,display_name,status) VALUES
('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000001','admin.local@example.test','Admin Local','ACTIVE'),
('90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000001','attendant.local@example.test','Atendente Local','ACTIVE'),
('90000000-0000-4000-8000-000000000012','90000000-0000-4000-8000-000000000001','attendant.two.local@example.test','Atendente Local 2','ACTIVE')
ON CONFLICT (tenant_id,email) DO UPDATE SET display_name=EXCLUDED.display_name,status='ACTIVE',
blocked_at=NULL,revoked_at=NULL,status_changed_at=clock_timestamp();
INSERT INTO user_units (tenant_id,user_id,unit_id,role) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002','TENANT_ADMIN'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000002','ATTENDANT'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000012','90000000-0000-4000-8000-000000000002','UNIT_MANAGER')
ON CONFLICT (tenant_id,user_id,unit_id) DO UPDATE SET role=EXCLUDED.role,status='ACTIVE',
version=user_units.version+1,state_changed_at=clock_timestamp(),revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL;
DELETE FROM unit_operational_timezone_commands
WHERE tenant_id='90000000-0000-4000-8000-000000000001'
  AND unit_id IN('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000003');
DELETE FROM unit_operational_timezone_versions
WHERE tenant_id='90000000-0000-4000-8000-000000000001'
  AND unit_id IN('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000003');
DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
  AND action='SHIFT_SCHEDULE_PUBLISHED';
DELETE FROM unit_shift_schedule_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001';
DELETE FROM unit_shift_schedule_versions WHERE tenant_id='90000000-0000-4000-8000-000000000001';
DELETE FROM attendant_availability_commands
WHERE tenant_id='90000000-0000-4000-8000-000000000001'
  AND unit_id='90000000-0000-4000-8000-000000000002'
  AND user_id IN('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000012');
INSERT INTO attendant_unit_availability(tenant_id,unit_id,user_id,status,max_active,pause_reason,paused_until,version,updated_at) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000010','AVAILABLE',100,NULL,NULL,1,clock_timestamp()),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000011','AVAILABLE',100,NULL,NULL,1,clock_timestamp()),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000012','AVAILABLE',100,NULL,NULL,1,clock_timestamp())
ON CONFLICT(tenant_id,user_id,unit_id) DO UPDATE SET status='AVAILABLE',max_active=100,pause_reason=NULL,paused_until=NULL,
version=1,updated_at=clock_timestamp();
INSERT INTO oidc_providers (id,tenant_id,code,issuer,audience,organization_claim,organization_value,status,config_reference)
VALUES ('90000000-0000-4000-8000-000000000020','90000000-0000-4000-8000-000000000001','local',:'oidc_issuer',
'zap-pronto-local','org_id','local-tenant','ACTIVE','local-only://keycloak')
ON CONFLICT (tenant_id,code) DO UPDATE SET issuer=EXCLUDED.issuer,audience=EXCLUDED.audience,
organization_claim=EXCLUDED.organization_claim,organization_value=EXCLUDED.organization_value,status='ACTIVE';
INSERT INTO user_oidc_identities (tenant_id,user_id,oidc_provider_id,subject,status) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000020','91000000-0000-4000-8000-000000000001','ACTIVE'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000020','91000000-0000-4000-8000-000000000002','ACTIVE'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000012','90000000-0000-4000-8000-000000000020','91000000-0000-4000-8000-000000000003','ACTIVE')
ON CONFLICT (tenant_id,oidc_provider_id,subject) DO UPDATE SET status='ACTIVE',revoked_at=NULL;

INSERT INTO channel_connections(id,tenant_id,type,scope,external_account_id,status)
VALUES('90000000-0000-4000-8000-000000000030','90000000-0000-4000-8000-000000000001','WHATSAPP','SINGLE_UNIT','local-e2e-account','ACTIVE')
ON CONFLICT (tenant_id,type,external_account_id) DO UPDATE SET status='ACTIVE';
INSERT INTO channel_connection_units(tenant_id,channel_connection_id,unit_id)
VALUES('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000030','90000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

INSERT INTO channel_connections(id,tenant_id,type,scope,external_account_id,status)
VALUES('90000000-0000-4000-8000-000000000031','90000000-0000-4000-8000-000000000001','WHATSAPP','CORPORATE','local-e2e-routing-account','ACTIVE')
ON CONFLICT (tenant_id,type,external_account_id) DO UPDATE SET scope='CORPORATE',status='ACTIVE';
INSERT INTO channel_connection_units(tenant_id,channel_connection_id,unit_id) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000031','90000000-0000-4000-8000-000000000002'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000031','90000000-0000-4000-8000-000000000003')
ON CONFLICT DO NOTHING;

DO $$ <<seed>>
DECLARE receipt_id uuid;outbox_id uuid;lease_id uuid:='90000000-0000-4000-8000-000000000040';conversation_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id','90000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.actor_id','90000000-0000-4000-8000-000000000011',true);
  PERFORM set_config('app.correlation_id','local-e2e-inbound-seed',true);
  SELECT id INTO receipt_id FROM persist_inbound_channel_event('META_WHATSAPP','wamid.local.e2e.001','local-e2e-account',
    'synthetic-customer','local-business','2026-08-10T12:00:00Z','TEXT',jsonb_build_object('text','Mensagem inbound sintética da Inbox'),
    'META_WHATSAPP:wamid.local.e2e.001:local-e2e-account',repeat('a',64),
    '90000000-0000-4000-8000-000000000030','90000000-0000-4000-8000-000000000002','ROUTED',NULL);
  SELECT message.conversation_id INTO conversation_id FROM messages message WHERE message.source_inbound_event_id=receipt_id;
  IF conversation_id IS NULL THEN
    SELECT id INTO outbox_id FROM outbox_events WHERE aggregate_id=receipt_id AND event_type='channel.inbound.received';
    UPDATE outbox_events SET status='PROCESSING',attempts=attempts+1,lease_token=lease_id,leased_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=outbox_id;
    SELECT materialized.conversation_id INTO conversation_id FROM materialize_inbound_channel_event(outbox_id,lease_id) materialized;
  END IF;
  IF (SELECT automation_status FROM conversations WHERE id=conversation_id)='ACTIVE' THEN
    UPDATE conversations SET automation_status='HUMAN_REQUESTED' WHERE id=conversation_id;
  END IF;
  IF (SELECT automation_status FROM conversations WHERE id=conversation_id)='HUMAN_REQUESTED' THEN
    UPDATE conversations SET automation_status='HUMAN_QUEUED' WHERE id=conversation_id;
  END IF;
  INSERT INTO service_cases(id,tenant_id,conversation_id,unit_id,kind,status)
  VALUES('90000000-0000-4000-8000-000000000050','90000000-0000-4000-8000-000000000001',conversation_id,
    '90000000-0000-4000-8000-000000000002','LOCAL_E2E','WAITING_HUMAN') ON CONFLICT(id) DO NOTHING;
  INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,idempotency_key,requested_at,queued_at)
  VALUES('90000000-0000-4000-8000-000000000060','90000000-0000-4000-8000-000000000001',conversation_id,
    '90000000-0000-4000-8000-000000000050','90000000-0000-4000-8000-000000000002','LOCAL_E2E','NORMAL','QUEUED',
    'local-e2e-handoff',clock_timestamp(),clock_timestamp()) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  DELETE FROM human_text_message_cancel_commands command WHERE command.tenant_id='90000000-0000-4000-8000-000000000001' AND command.conversation_id=seed.conversation_id;
  DELETE FROM human_text_message_commands command WHERE command.tenant_id='90000000-0000-4000-8000-000000000001' AND command.conversation_id=seed.conversation_id;
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND action='HUMAN_TEXT_MESSAGE_QUEUED'
    AND entity_id IN(SELECT message.id::text FROM messages message WHERE message.tenant_id='90000000-0000-4000-8000-000000000001' AND message.conversation_id=seed.conversation_id AND message.direction='OUTBOUND');
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND action='HUMAN_TEXT_MESSAGE_CANCELLED'
    AND entity_id IN(SELECT message.id::text FROM messages message WHERE message.tenant_id='90000000-0000-4000-8000-000000000001' AND message.conversation_id=seed.conversation_id AND message.direction='OUTBOUND');
  DELETE FROM outbox_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND event_type='channel.outbound.requested'
    AND aggregate_id IN(SELECT message.id FROM messages message WHERE message.tenant_id='90000000-0000-4000-8000-000000000001' AND message.conversation_id=seed.conversation_id AND message.direction='OUTBOUND');
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND action='META_DELIVERY_STATUS_RECONCILED'
    AND entity_id IN(SELECT id::text FROM meta_delivery_status_receipts WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND external_message_id='wamid.local.synthetic.status.001');
  DELETE FROM meta_delivery_status_applications application WHERE application.tenant_id='90000000-0000-4000-8000-000000000001'
    AND application.receipt_id IN(SELECT receipt.id FROM meta_delivery_status_receipts receipt WHERE receipt.tenant_id='90000000-0000-4000-8000-000000000001'
      AND external_message_id='wamid.local.synthetic.status.001');
  DELETE FROM meta_delivery_status_receipts WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND external_message_id='wamid.local.synthetic.status.001';
  DELETE FROM messages message WHERE message.tenant_id='90000000-0000-4000-8000-000000000001' AND message.conversation_id=seed.conversation_id AND message.direction='OUTBOUND';
  DELETE FROM workflow_transitions WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND reason='MANAGER_REOPENED'
    AND aggregate_id IN(SELECT result_handoff_id FROM handoff_reopen_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND source_handoff_id='90000000-0000-4000-8000-000000000060' UNION ALL SELECT '90000000-0000-4000-8000-000000000050'::uuid UNION ALL SELECT conversation_id);
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND action='HANDOFF_REOPENED'
    AND entity_id IN(SELECT result_handoff_id::text FROM handoff_reopen_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND source_handoff_id='90000000-0000-4000-8000-000000000060');
  DELETE FROM outbox_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND event_type='handoff.reopened'
    AND aggregate_id IN(SELECT result_handoff_id FROM handoff_reopen_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND source_handoff_id='90000000-0000-4000-8000-000000000060');
  DELETE FROM handoff_reopen_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND source_handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM human_handoffs handoff WHERE handoff.tenant_id='90000000-0000-4000-8000-000000000001' AND handoff.id<>'90000000-0000-4000-8000-000000000060'
    AND handoff.conversation_id=seed.conversation_id AND handoff.service_case_id='90000000-0000-4000-8000-000000000050' AND handoff.idempotency_key LIKE 'reopen:%';
  DELETE FROM handoff_claim_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_resolve_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_requeue_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_transfer_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_takeover_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_sla_acknowledge_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND action='SLA_ALERT_ACKNOWLEDGED' AND entity_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM handoff_sla_acknowledgements WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND handoff_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM outbox_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND aggregate_type='handoff' AND aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type IN('handoff.claimed','handoff.resolved','handoff.requeued','handoff.transferred','handoff.taken_over');
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND action IN('HANDOFF_RESOLVED','HANDOFF_REQUEUED','HANDOFF_TRANSFERRED','HANDOFF_TAKEN_OVER')
    AND entity_id='90000000-0000-4000-8000-000000000060';
  DELETE FROM workflow_transitions WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND reason IN('ATTENDANT_CLAIM','ATTENDANT_RESOLVED','ATTENDANT_REQUEUED','ATTENDANT_TRANSFERRED','SUPERVISOR_TAKEOVER') AND aggregate_type IN ('HANDOFF','SERVICE_CASE','CONVERSATION')
    AND aggregate_id IN ('90000000-0000-4000-8000-000000000060','90000000-0000-4000-8000-000000000050',conversation_id);
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE human_handoffs SET status='QUEUED',assigned_user_id=NULL,claimed_at=NULL,resolved_at=NULL,sla_due_at=NULL,
    queued_at=clock_timestamp()-interval '30 minutes',version=1,state_changed_at=clock_timestamp() WHERE id='90000000-0000-4000-8000-000000000060';
  UPDATE service_cases SET status='WAITING_HUMAN',resolved_at=NULL,version=1,state_changed_at=clock_timestamp()
    WHERE id='90000000-0000-4000-8000-000000000050';
  UPDATE conversations SET status='OPEN',closed_at=NULL,automation_status='HUMAN_QUEUED',assigned_user_id=NULL,version=1,
    state_changed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=conversation_id;
  PERFORM set_config('session_replication_role','origin',true);
  DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND action='SLA_POLICY_PUBLISHED' AND entity_id IN(SELECT id::text FROM unit_sla_policy_versions
      WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND unit_id='90000000-0000-4000-8000-000000000002');
  DELETE FROM unit_sla_policy_publish_commands WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND unit_id='90000000-0000-4000-8000-000000000002';
  DELETE FROM unit_sla_policy_targets WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND policy_version_id IN(SELECT id FROM unit_sla_policy_versions WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND unit_id='90000000-0000-4000-8000-000000000002');
  DELETE FROM unit_sla_policy_versions WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND unit_id='90000000-0000-4000-8000-000000000002';
  IF current_setting('app.local_seed_meta_status')='true' THEN
    INSERT INTO messages(id,tenant_id,conversation_id,direction,actor,external_message_id,body,payload,delivery_status,
      provider_sent_at,last_provider_status_at,created_at)
    VALUES('90000000-0000-4000-8000-000000000070','90000000-0000-4000-8000-000000000001',conversation_id,
      'OUTBOUND','HUMAN','wamid.local.synthetic.status.001','Mensagem outbound sintética seedada como SENT',
      jsonb_build_object('kind','TEXT','trust',NULL),'SENT','2026-08-10T12:05:00Z','2026-08-10T12:05:00Z','2026-08-10T12:05:00Z')
    ON CONFLICT(id) DO UPDATE SET external_message_id=EXCLUDED.external_message_id,body=EXCLUDED.body,payload=EXCLUDED.payload,
      delivery_status='SENT',provider_sent_at=EXCLUDED.provider_sent_at,provider_delivered_at=NULL,provider_read_at=NULL,
      provider_failed_at=NULL,last_provider_status_at=EXCLUDED.last_provider_status_at;
  END IF;
END $$;

DO $$ <<routing_seed>>
DECLARE receipt_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id','90000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.actor_id','90000000-0000-4000-8000-000000000010',true);
  PERFORM set_config('app.correlation_id','local-e2e-routing-required-seed',true);

  SELECT id INTO receipt_id FROM inbound_channel_events
  WHERE tenant_id='90000000-0000-4000-8000-000000000001'
    AND idempotency_key='META_WHATSAPP:wamid.local.e2e.routing.001:local-e2e-routing-account';
  IF receipt_id IS NOT NULL THEN
    DELETE FROM inbound_routing_commands command WHERE command.tenant_id='90000000-0000-4000-8000-000000000001'
      AND command.receipt_id=routing_seed.receipt_id;
    DELETE FROM audit_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND action='INBOUND_ROUTING_RESOLVED' AND entity_id=routing_seed.receipt_id::text;
    DELETE FROM outbox_events WHERE tenant_id='90000000-0000-4000-8000-000000000001'
      AND aggregate_type='inbound_channel_event' AND aggregate_id=routing_seed.receipt_id
      AND event_type IN('channel.inbound.routing_required','channel.inbound.received');
    DELETE FROM inbound_channel_events WHERE tenant_id='90000000-0000-4000-8000-000000000001' AND id=routing_seed.receipt_id;
  END IF;

  PERFORM id FROM persist_inbound_channel_event('META_WHATSAPP','wamid.local.e2e.routing.001','local-e2e-routing-account',
    'synthetic-routing-customer','local-routing-business','2026-08-10T12:10:00Z','TEXT','{}'::jsonb,
    'META_WHATSAPP:wamid.local.e2e.routing.001:local-e2e-routing-account',repeat('b',64),
    '90000000-0000-4000-8000-000000000031',NULL,'UNROUTED','MULTIPLE_ACTIVE_UNITS');
END $$;
COMMIT;
