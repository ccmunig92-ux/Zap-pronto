BEGIN;

CREATE TABLE handoff_request_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  actor_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint)=32),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id)
);
ALTER TABLE handoff_request_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_request_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON handoff_request_commands
  USING (tenant_id=current_app_tenant_id()) WITH CHECK (tenant_id=current_app_tenant_id());

CREATE FUNCTION request_handoff_command(
  target_case_id uuid,target_expected_version integer,target_reason text,target_priority text,
  target_key text,target_sla_due_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE
  tenant_value uuid := public.current_app_tenant_id(); actor_value uuid := public.current_app_actor_id();
  fingerprint bytea; existing public.handoff_request_commands%ROWTYPE; sc record; conv record; h record; result_value jsonb;
BEGIN
  IF target_case_id IS NULL OR target_expected_version IS NULL OR target_expected_version<1
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 1 AND 200
    OR target_priority IS NULL OR target_priority NOT IN ('LOW','NORMAL','HIGH','URGENT')
    OR target_key IS NULL OR length(target_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_REQUEST' USING ERRCODE='22023';
  END IF;
  fingerprint:=public.digest(convert_to(jsonb_build_array(target_case_id,target_expected_version,btrim(target_reason),
    target_priority,target_sla_due_at,actor_value)::text,'UTF8'),'sha256');
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text||':handoff-request:'||target_key,0));
  SELECT * INTO existing FROM public.handoff_request_commands
    WHERE tenant_id=tenant_value AND idempotency_key=target_key;
  IF FOUND THEN
    IF existing.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN existing.result;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text||':handoff-case:'||target_case_id,0));
  SELECT * INTO sc FROM public.service_cases s WHERE s.tenant_id=tenant_value AND s.id=target_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_CASE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT public.current_actor_has_permission('handoff.claim',sc.unit_id) THEN RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501'; END IF;
  IF sc.version<>target_expected_version THEN RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE='40001'; END IF;
  IF sc.status NOT IN ('COLLECTING','READY_FOR_HANDOFF') THEN RAISE EXCEPTION 'INVALID_SERVICE_CASE_TRANSITION' USING ERRCODE='22023'; END IF;
  SELECT * INTO conv FROM public.conversations c WHERE c.tenant_id=tenant_value AND c.id=sc.conversation_id
    AND c.unit_id=sc.unit_id FOR UPDATE;
  IF NOT FOUND OR conv.automation_status<>'ACTIVE' THEN RAISE EXCEPTION 'CONVERSATION_NOT_AUTOMATABLE' USING ERRCODE='22023'; END IF;
  INSERT INTO public.human_handoffs(tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,queued_at,sla_due_at,idempotency_key)
    VALUES(tenant_value,sc.conversation_id,target_case_id,sc.unit_id,btrim(target_reason),target_priority,'QUEUED',now(),target_sla_due_at,target_key)
    RETURNING id,version INTO h;
  UPDATE public.service_cases SET status='WAITING_HUMAN',version=version+1,state_changed_at=now() WHERE tenant_id=tenant_value AND id=target_case_id;
  UPDATE public.conversations SET automation_status='HUMAN_REQUESTED',assigned_user_id=NULL,version=version+1,state_changed_at=now(),updated_at=now()
    WHERE tenant_id=tenant_value AND id=sc.conversation_id;
  UPDATE public.conversations SET automation_status='HUMAN_QUEUED',version=version+1,state_changed_at=now(),updated_at=now()
    WHERE tenant_id=tenant_value AND id=sc.conversation_id;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (tenant_value,'SERVICE_CASE',target_case_id,sc.status::text,'WAITING_HUMAN',btrim(target_reason),actor_value,current_setting('app.correlation_id'),'{}'),
    (tenant_value,'HANDOFF',h.id,NULL,'QUEUED',btrim(target_reason),actor_value,current_setting('app.correlation_id'),'{}'),
    (tenant_value,'CONVERSATION',sc.conversation_id,'ACTIVE','HUMAN_REQUESTED',btrim(target_reason),actor_value,current_setting('app.correlation_id'),'{}'),
    (tenant_value,'CONVERSATION',sc.conversation_id,'HUMAN_REQUESTED','HUMAN_QUEUED',btrim(target_reason),actor_value,current_setting('app.correlation_id'),'{}');
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES(tenant_value,'handoff',h.id,'handoff.queued',jsonb_build_object('handoffId',h.id,'conversationId',sc.conversation_id,'serviceCaseId',target_case_id),'handoff.queued:'||h.id);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_value,'USER',actor_value::text,'HANDOFF_REQUESTED','handoff',h.id::text,
      jsonb_build_object('correlationId',current_setting('app.correlation_id'),'version',h.version));
  result_value:=jsonb_build_object('id',h.id,'conversationId',sc.conversation_id,'serviceCaseId',target_case_id,'status','QUEUED','version',h.version);
  INSERT INTO public.handoff_request_commands VALUES(tenant_value,target_key,actor_value,target_case_id,fingerprint,result_value,now());
  RETURN result_value;
END $$;

CREATE FUNCTION claim_handoff_command(target_handoff_id uuid,target_expected_version integer,target_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE replay jsonb; tenant_value uuid:=public.current_app_tenant_id(); actor_value uuid:=public.current_app_actor_id();
  h record; sc record; conv record; result_value jsonb;
BEGIN
  replay:=public.get_handoff_claim_replay(target_key,target_handoff_id,target_expected_version);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO h FROM public.human_handoffs x WHERE x.tenant_id=tenant_value AND x.id=target_handoff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sc FROM public.service_cases x WHERE x.tenant_id=tenant_value AND x.id=h.service_case_id FOR UPDATE;
  SELECT * INTO conv FROM public.conversations x WHERE x.tenant_id=tenant_value AND x.id=h.conversation_id FOR UPDATE;
  IF h.version<>target_expected_version OR h.status<>'QUEUED' THEN RAISE EXCEPTION 'HANDOFF_CLAIM_CONFLICT' USING ERRCODE='40001'; END IF;
  IF sc.status<>'WAITING_HUMAN' OR conv.automation_status<>'HUMAN_QUEUED' THEN RAISE EXCEPTION 'HANDOFF_AGGREGATE_INCONSISTENT' USING ERRCODE='23514'; END IF;
  UPDATE public.human_handoffs SET status='ACTIVE',assigned_user_id=actor_value,claimed_at=now(),state_changed_at=now(),version=version+1 WHERE tenant_id=tenant_value AND id=h.id;
  UPDATE public.service_cases SET status='IN_REVIEW',version=version+1,state_changed_at=now() WHERE tenant_id=tenant_value AND id=sc.id;
  UPDATE public.conversations SET automation_status='HUMAN_ACTIVE',assigned_user_id=actor_value,version=version+1,state_changed_at=now(),updated_at=now() WHERE tenant_id=tenant_value AND id=conv.id;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (tenant_value,'HANDOFF',h.id,'QUEUED','ACTIVE','ATTENDANT_CLAIM',actor_value,current_setting('app.correlation_id'),'{}'),
    (tenant_value,'SERVICE_CASE',sc.id,'WAITING_HUMAN','IN_REVIEW','ATTENDANT_CLAIM',actor_value,current_setting('app.correlation_id'),'{}'),
    (tenant_value,'CONVERSATION',conv.id,'HUMAN_QUEUED','HUMAN_ACTIVE','ATTENDANT_CLAIM',actor_value,current_setting('app.correlation_id'),'{}');
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES(tenant_value,'handoff',h.id,'handoff.claimed',jsonb_build_object('handoffId',h.id,'actorId',actor_value),'handoff.claimed:'||h.id);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_value,'USER',actor_value::text,'HANDOFF_CLAIMED','handoff',h.id::text,jsonb_build_object('correlationId',current_setting('app.correlation_id'),'version',h.version+1));
  result_value:=jsonb_build_object('id',h.id,'conversationId',h.conversation_id,'serviceCaseId',h.service_case_id,'status','ACTIVE','version',h.version+1);
  PERFORM public.store_handoff_claim_result(target_key,target_handoff_id,target_expected_version,result_value);
  RETURN result_value;
END $$;

CREATE FUNCTION ensure_medical_order_handoff_command(target_case_id uuid,target_expected_version integer,target_reason text,target_priority text,target_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE tenant_value uuid:=public.current_app_tenant_id(); existing record; sc record;
BEGIN
  SELECT h.id,h.service_case_id INTO existing FROM public.human_handoffs h JOIN public.service_cases s
    ON s.tenant_id=h.tenant_id AND s.conversation_id=h.conversation_id
    WHERE h.tenant_id=tenant_value AND s.id=target_case_id AND h.status IN ('REQUESTED','QUEUED','ACTIVE')
    ORDER BY h.requested_at,h.id LIMIT 1 FOR UPDATE OF h;
  IF NOT FOUND THEN PERFORM public.request_handoff_command(target_case_id,target_expected_version,target_reason,target_priority,target_key,NULL); RETURN; END IF;
  IF existing.service_case_id<>target_case_id THEN RAISE EXCEPTION 'HANDOFF_OPEN_FOR_ANOTHER_CASE' USING ERRCODE='23514'; END IF;
  SELECT * INTO sc FROM public.service_cases s WHERE s.tenant_id=tenant_value AND s.id=target_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_CASE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT public.current_actor_has_permission('handoff.claim',sc.unit_id) THEN RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501'; END IF;
  IF sc.status IN ('WAITING_HUMAN','IN_REVIEW') THEN RETURN; END IF;
  IF sc.version<>target_expected_version OR sc.status NOT IN ('COLLECTING','READY_FOR_HANDOFF') THEN RAISE EXCEPTION 'CONCURRENT_MODIFICATION' USING ERRCODE='40001'; END IF;
  UPDATE public.service_cases SET status='WAITING_HUMAN',version=version+1,state_changed_at=now() WHERE tenant_id=tenant_value AND id=target_case_id;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata)
    VALUES(tenant_value,'SERVICE_CASE',target_case_id,sc.status::text,'WAITING_HUMAN',target_reason,current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('reusedHandoffId',existing.id));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_value,'USER',current_app_actor_id()::text,'HANDOFF_REUSED','handoff',existing.id::text,
      jsonb_build_object('serviceCaseId',target_case_id,'correlationId',current_setting('app.correlation_id')));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES(tenant_value,'handoff',existing.id,'handoff.reused_for_case',jsonb_build_object('handoffId',existing.id,'serviceCaseId',target_case_id),
      'handoff.reused:'||existing.id::text||':'||target_case_id::text);
END $$;

REVOKE INSERT,UPDATE ON human_handoffs,conversations,service_cases FROM zap_pronto_api;
REVOKE SELECT ON human_handoffs FROM zap_pronto_api;
REVOKE EXECUTE ON FUNCTION get_handoff_claim_replay(text,uuid,integer),store_handoff_claim_result(text,uuid,integer,jsonb)
  FROM zap_pronto_api;
ALTER FUNCTION reject_hermes_during_human_takeover() SECURITY INVOKER;
ALTER FUNCTION reject_hermes_during_human_takeover() RESET ALL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zap_pronto_handoff_executor') THEN
    CREATE ROLE zap_pronto_handoff_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE zap_pronto_handoff_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO zap_pronto_handoff_executor;
GRANT SELECT,INSERT,UPDATE ON human_handoffs,conversations,service_cases TO zap_pronto_handoff_executor;
GRANT SELECT,INSERT ON handoff_request_commands,handoff_claim_commands TO zap_pronto_handoff_executor;
GRANT INSERT ON workflow_transitions,outbox_events,audit_events TO zap_pronto_handoff_executor;
GRANT USAGE,SELECT ON workflow_transitions_id_seq,audit_events_id_seq TO zap_pronto_handoff_executor;
GRANT EXECUTE ON FUNCTION current_app_tenant_id(),current_app_actor_id(),
  current_actor_has_permission(text,uuid),get_handoff_claim_replay(text,uuid,integer),
  store_handoff_claim_result(text,uuid,integer,jsonb) TO zap_pronto_handoff_executor;
ALTER FUNCTION request_handoff_command(uuid,integer,text,text,text,timestamptz) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION claim_handoff_command(uuid,integer,text) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION ensure_medical_order_handoff_command(uuid,integer,text,text,text) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION list_queued_handoffs(uuid,integer,text,timestamptz,uuid) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION get_handoff_claim_replay(text,uuid,integer) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION store_handoff_claim_result(text,uuid,integer,jsonb) OWNER TO zap_pronto_handoff_executor;
ALTER FUNCTION request_handoff_command(uuid,integer,text,text,text,timestamptz) SET row_security=on;
ALTER FUNCTION claim_handoff_command(uuid,integer,text) SET row_security=on;
ALTER FUNCTION ensure_medical_order_handoff_command(uuid,integer,text,text,text) SET row_security=on;
ALTER FUNCTION list_queued_handoffs(uuid,integer,text,timestamptz,uuid) SET row_security=on;
ALTER FUNCTION get_handoff_claim_replay(text,uuid,integer) SET row_security=on;
ALTER FUNCTION store_handoff_claim_result(text,uuid,integer,jsonb) SET row_security=on;
REVOKE ALL ON handoff_request_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
REVOKE ALL ON FUNCTION request_handoff_command(uuid,integer,text,text,text,timestamptz),claim_handoff_command(uuid,integer,text),
  ensure_medical_order_handoff_command(uuid,integer,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION request_handoff_command(uuid,integer,text,text,text,timestamptz),claim_handoff_command(uuid,integer,text),
  ensure_medical_order_handoff_command(uuid,integer,text,text,text) TO zap_pronto_api;

COMMIT;
