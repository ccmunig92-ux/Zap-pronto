BEGIN;

INSERT INTO app_permissions(code) VALUES('handoff.requeue') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'handoff.requeue' FROM app_roles role
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
ON CONFLICT DO NOTHING;

ALTER TABLE handoff_claim_commands
  ADD COLUMN conversation_id uuid,
  ADD COLUMN service_case_id uuid,
  ADD COLUMN result_assigned_user_id uuid,
  ADD COLUMN result_automation_status text;
UPDATE handoff_claim_commands command SET
  conversation_id=handoff.conversation_id,
  service_case_id=handoff.service_case_id,
  result_assigned_user_id=command.actor_id,
  result_automation_status='HUMAN_ACTIVE'
FROM human_handoffs handoff
WHERE handoff.tenant_id=command.tenant_id AND handoff.id=command.handoff_id;
ALTER TABLE handoff_claim_commands
  ALTER COLUMN conversation_id SET NOT NULL,
  ALTER COLUMN service_case_id SET NOT NULL,
  ALTER COLUMN result_assigned_user_id SET NOT NULL,
  ALTER COLUMN result_automation_status SET NOT NULL,
  ADD FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  ADD FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id),
  ADD FOREIGN KEY(tenant_id,result_assigned_user_id) REFERENCES users(tenant_id,id),
  ADD CHECK(result_automation_status='HUMAN_ACTIVE');

CREATE TABLE handoff_requeue_commands(
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  handoff_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  result_handoff_version integer NOT NULL CHECK(result_handoff_version>0),
  result_conversation_version integer NOT NULL CHECK(result_conversation_version>0),
  result_service_case_version integer NOT NULL CHECK(result_service_case_version>0),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE handoff_requeue_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_requeue_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_requeue_commands_tenant ON handoff_requeue_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON handoff_requeue_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION enforce_operational_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean:=false;
BEGIN
  IF TG_TABLE_NAME='conversations' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      allowed:=(OLD.status='OPEN' AND NEW.status='CLOSED') OR (OLD.status='CLOSED' AND NEW.status='ARCHIVED');
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.automation_status IS DISTINCT FROM OLD.automation_status THEN
      allowed:=(OLD.automation_status='ACTIVE' AND NEW.automation_status='HUMAN_REQUESTED')
        OR (OLD.automation_status='HUMAN_REQUESTED' AND NEW.automation_status='HUMAN_QUEUED')
        OR (OLD.automation_status='HUMAN_QUEUED' AND NEW.automation_status='HUMAN_ACTIVE')
        OR (OLD.automation_status='HUMAN_ACTIVE' AND NEW.automation_status='HUMAN_QUEUED')
        OR (OLD.automation_status IN('HUMAN_REQUESTED','HUMAN_QUEUED','HUMAN_ACTIVE') AND NEW.automation_status='SUSPENDED');
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='service_cases' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed:=(OLD.status='COLLECTING' AND NEW.status IN('READY_FOR_HANDOFF','WAITING_HUMAN','FAILED','CANCELLED'))
      OR (OLD.status='READY_FOR_HANDOFF' AND NEW.status IN('WAITING_HUMAN','FAILED','CANCELLED'))
      OR (OLD.status='WAITING_HUMAN' AND NEW.status IN('IN_REVIEW','RESOLVED','FAILED','CANCELLED'))
      OR (OLD.status='IN_REVIEW' AND NEW.status IN('WAITING_HUMAN','RESOLVED','FAILED','CANCELLED'));
  ELSIF TG_TABLE_NAME='human_handoffs' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed:=(OLD.status='REQUESTED' AND NEW.status IN('QUEUED','FAILED','CANCELLED'))
      OR (OLD.status='QUEUED' AND NEW.status IN('ACTIVE','FAILED','CANCELLED'))
      OR (OLD.status='ACTIVE' AND NEW.status IN('QUEUED','RESOLVED','FAILED','CANCELLED'));
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION requeue_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_idempotency_key text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,handoff_version integer,
  conversation_version integer,service_case_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;fingerprint text;command_record public.handoff_requeue_commands%ROWTYPE;
  handoff_record public.human_handoffs%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  case_record public.service_cases%ROWTYPE;next_handoff integer;next_conversation integer;next_case integer;
  now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=btrim(requested_idempotency_key);
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR normalized_key IS NULL OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_REQUEUE_REQUEST' USING ERRCODE='P0001'; END IF;
  fingerprint:=encode(public.digest(jsonb_build_object('handoffId',lower(requested_handoff_id::text),
    'expectedVersion',requested_expected_version)::text,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':handoff-requeue:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.handoff_requeue_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command_record.handoff_id IS DISTINCT FROM requested_handoff_id
      OR command_record.expected_version IS DISTINCT FROM requested_expected_version
      OR command_record.request_fingerprint IS DISTINCT FROM fingerprint
      OR command_record.actor_id IS DISTINCT FROM public.current_app_actor_id() THEN
      RAISE EXCEPTION 'HANDOFF_REQUEUE_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    handoff_id:=command_record.handoff_id;conversation_id:=command_record.conversation_id;
    service_case_id:=command_record.service_case_id;handoff_version:=command_record.result_handoff_version;
    conversation_version:=command_record.result_conversation_version;service_case_version:=command_record.result_service_case_version;
    replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT handoff.* INTO handoff_record FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR handoff_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR NOT public.current_actor_has_permission('handoff.requeue',handoff_record.unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_REQUEUE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT service_case.* INTO case_record FROM public.service_cases service_case
  WHERE service_case.tenant_id=handoff_record.tenant_id AND service_case.id=handoff_record.service_case_id FOR UPDATE;
  SELECT conversation.* INTO conversation_record FROM public.conversations conversation
  WHERE conversation.tenant_id=handoff_record.tenant_id AND conversation.id=handoff_record.conversation_id FOR UPDATE;
  IF handoff_record.version<>requested_expected_version OR handoff_record.status<>'ACTIVE'
    OR conversation_record.status<>'OPEN' OR conversation_record.automation_status<>'HUMAN_ACTIVE'
    OR conversation_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR conversation_record.unit_id<>handoff_record.unit_id OR case_record.status<>'IN_REVIEW'
    OR case_record.unit_id<>handoff_record.unit_id OR case_record.conversation_id<>handoff_record.conversation_id
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=handoff_record.tenant_id AND unit.id=handoff_record.unit_id AND unit.active) THEN
    RAISE EXCEPTION 'HANDOFF_REQUEUE_CONFLICT' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=handoff_record.tenant_id
    AND message.conversation_id=handoff_record.conversation_id AND message.direction='OUTBOUND'
    AND message.actor='HUMAN' AND message.delivery_status='QUEUED') THEN
    RAISE EXCEPTION 'HANDOFF_REQUEUE_PENDING_OUTBOUND' USING ERRCODE='P0001'; END IF;
  UPDATE public.human_handoffs SET status='QUEUED',assigned_user_id=NULL,claimed_at=NULL,queued_at=now_at,
    state_changed_at=now_at,version=version+1 WHERE tenant_id=handoff_record.tenant_id AND id=handoff_record.id RETURNING version INTO next_handoff;
  UPDATE public.service_cases SET status='WAITING_HUMAN',state_changed_at=now_at,version=version+1
    WHERE tenant_id=case_record.tenant_id AND id=case_record.id RETURNING version INTO next_case;
  UPDATE public.conversations SET automation_status='HUMAN_QUEUED',assigned_user_id=NULL,state_changed_at=now_at,
    updated_at=now_at,version=version+1 WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id RETURNING version INTO next_conversation;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (handoff_record.tenant_id,'HANDOFF',handoff_record.id,'ACTIVE','QUEUED','ATTENDANT_REQUEUED',public.current_app_actor_id(),current_setting('app.correlation_id'),'{}'),
    (handoff_record.tenant_id,'SERVICE_CASE',case_record.id,'IN_REVIEW','WAITING_HUMAN','ATTENDANT_REQUEUED',public.current_app_actor_id(),current_setting('app.correlation_id'),'{}'),
    (handoff_record.tenant_id,'CONVERSATION',conversation_record.id,'HUMAN_ACTIVE','HUMAN_QUEUED','ATTENDANT_REQUEUED',public.current_app_actor_id(),current_setting('app.correlation_id'),'{}');
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_REQUEUED','handoff',handoff_record.id::text,
    jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(handoff_record.tenant_id,'handoff',handoff_record.id,'handoff.requeued',
    jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id),
    'handoff.requeued:'||handoff_record.id::text||':'||next_handoff::text);
  INSERT INTO public.handoff_requeue_commands(tenant_id,idempotency_key,handoff_id,expected_version,request_fingerprint,
    actor_id,conversation_id,service_case_id,result_handoff_version,result_conversation_version,result_service_case_version,correlation_id)
  VALUES(handoff_record.tenant_id,normalized_key,handoff_record.id,requested_expected_version,fingerprint,public.current_app_actor_id(),
    conversation_record.id,case_record.id,next_handoff,next_conversation,next_case,current_setting('app.correlation_id'));
  handoff_id:=handoff_record.id;conversation_id:=conversation_record.id;service_case_id:=case_record.id;
  handoff_version:=next_handoff;conversation_version:=next_conversation;service_case_version:=next_case;replayed:=false;RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION requeue_inbox_handoff(uuid,integer,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION requeue_inbox_handoff(uuid,integer,text) TO zap_pronto_api;

CREATE FUNCTION get_inbox_conversation_requeue_target(requested_conversation_id uuid)
RETURNS TABLE(handoff_id uuid,expected_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT handoff.id,handoff.version FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.conversation_id=requested_conversation_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
    AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id() AND service_case.status='IN_REVIEW'
    AND public.current_actor_has_permission('handoff.requeue',handoff.unit_id)
    AND NOT EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=handoff.tenant_id
      AND message.conversation_id=handoff.conversation_id AND message.direction='OUTBOUND'
      AND message.actor='HUMAN' AND message.delivery_status='QUEUED')
  ORDER BY handoff.claimed_at DESC,handoff.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION get_inbox_conversation_requeue_target(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation_requeue_target(uuid) TO zap_pronto_api;

COMMIT;
