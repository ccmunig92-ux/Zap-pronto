BEGIN;

ALTER TABLE handoff_resolve_commands
  ADD COLUMN disposition text;
UPDATE handoff_resolve_commands SET disposition='LEGACY_UNSPECIFIED' WHERE disposition IS NULL;
ALTER TABLE handoff_resolve_commands
  ALTER COLUMN disposition SET NOT NULL,
  ADD CONSTRAINT handoff_resolve_commands_disposition_check CHECK(disposition IN
    ('LEGACY_UNSPECIFIED','RESOLVED','DUPLICATE','CUSTOMER_WITHDREW','EXTERNAL_REFERRAL'));

ALTER FUNCTION resolve_inbox_handoff(uuid,integer,text,text)
  RENAME TO resolve_inbox_handoff_legacy_v0027;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_legacy_v0027(uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION resolve_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_disposition text,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,handoff_version integer,
  conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE command_record public.handoff_resolve_commands%ROWTYPE;handoff_record public.human_handoffs%ROWTYPE;
  case_record public.service_cases%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  next_handoff_version integer;next_conversation_version integer;now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR requested_disposition IS NULL OR requested_disposition<>btrim(requested_disposition)
    OR requested_disposition NOT IN('RESOLVED','DUPLICATE','CUSTOMER_WITHDREW','EXTERNAL_REFERRAL')
    OR requested_idempotency_key IS NULL OR requested_idempotency_key<>btrim(requested_idempotency_key)
    OR length(requested_idempotency_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_RESOLVE_REQUEST' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    public.current_app_tenant_id()::text||':'||requested_idempotency_key,0));
  SELECT command.* INTO command_record FROM public.handoff_resolve_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=requested_idempotency_key;
  IF FOUND THEN
    IF command_record.disposition='LEGACY_UNSPECIFIED'
      OR command_record.disposition IS DISTINCT FROM requested_disposition
      OR command_record.request_fingerprint IS DISTINCT FROM requested_fingerprint
      OR command_record.handoff_id IS DISTINCT FROM requested_handoff_id
      OR command_record.expected_version IS DISTINCT FROM requested_expected_version
      OR command_record.actor_id IS DISTINCT FROM public.current_app_actor_id() THEN
      RAISE EXCEPTION 'HANDOFF_RESOLVE_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    handoff_id:=command_record.handoff_id;conversation_id:=command_record.conversation_id;
    service_case_id:=command_record.service_case_id;handoff_version:=command_record.result_handoff_version;
    conversation_version:=command_record.result_conversation_version;replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT handoff.* INTO handoff_record FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_actor_has_permission('handoff.resolve',handoff_record.unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_RESOLVE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=handoff_record.tenant_id
    AND unit.id=handoff_record.unit_id AND unit.active) THEN RAISE EXCEPTION 'HANDOFF_RESOLVE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT service_case.* INTO case_record FROM public.service_cases service_case
  WHERE service_case.tenant_id=handoff_record.tenant_id AND service_case.id=handoff_record.service_case_id FOR UPDATE;
  SELECT conversation.* INTO conversation_record FROM public.conversations conversation
  WHERE conversation.tenant_id=handoff_record.tenant_id AND conversation.id=handoff_record.conversation_id FOR UPDATE;
  IF handoff_record.version<>requested_expected_version OR handoff_record.status<>'ACTIVE'
    OR handoff_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR case_record.status<>'IN_REVIEW' OR case_record.conversation_id<>handoff_record.conversation_id OR case_record.unit_id<>handoff_record.unit_id
    OR conversation_record.status<>'OPEN' OR conversation_record.automation_status<>'HUMAN_ACTIVE'
    OR conversation_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR conversation_record.unit_id<>handoff_record.unit_id THEN
    RAISE EXCEPTION 'HANDOFF_RESOLVE_CONFLICT' USING ERRCODE='P0001'; END IF;
  UPDATE public.human_handoffs SET status='RESOLVED',resolved_at=now_at,state_changed_at=now_at,version=version+1
  WHERE tenant_id=handoff_record.tenant_id AND id=handoff_record.id RETURNING version INTO next_handoff_version;
  UPDATE public.service_cases SET status='RESOLVED',resolved_at=now_at,state_changed_at=now_at,version=version+1
  WHERE tenant_id=case_record.tenant_id AND id=case_record.id;
  UPDATE public.conversations SET status='CLOSED',closed_at=now_at,automation_status='SUSPENDED',assigned_user_id=NULL,
    state_changed_at=now_at,updated_at=now_at,version=version+1
  WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id RETURNING version INTO next_conversation_version;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata)
  VALUES(handoff_record.tenant_id,'HANDOFF',handoff_record.id,'ACTIVE','RESOLVED','ATTENDANT_RESOLVED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('disposition',requested_disposition)),
    (handoff_record.tenant_id,'SERVICE_CASE',case_record.id,'IN_REVIEW','RESOLVED','ATTENDANT_RESOLVED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('disposition',requested_disposition)),
    (handoff_record.tenant_id,'CONVERSATION',conversation_record.id,'HUMAN_ACTIVE','SUSPENDED','ATTENDANT_RESOLVED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('disposition',requested_disposition));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_RESOLVED','handoff',handoff_record.id::text,
    jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id,'disposition',requested_disposition));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(handoff_record.tenant_id,'handoff',handoff_record.id,'handoff.resolved',
    jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id,'disposition',requested_disposition),
    'handoff.resolved:'||handoff_record.id::text);
  INSERT INTO public.handoff_resolve_commands(tenant_id,idempotency_key,handoff_id,expected_version,request_fingerprint,
    actor_id,conversation_id,service_case_id,result_handoff_version,result_conversation_version,correlation_id,disposition)
  VALUES(handoff_record.tenant_id,requested_idempotency_key,handoff_record.id,requested_expected_version,requested_fingerprint,
    public.current_app_actor_id(),conversation_record.id,case_record.id,next_handoff_version,next_conversation_version,current_setting('app.correlation_id'),requested_disposition);
  handoff_id:=handoff_record.id;conversation_id:=conversation_record.id;service_case_id:=case_record.id;
  handoff_version:=next_handoff_version;conversation_version:=next_conversation_version;replayed:=false;RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION resolve_inbox_handoff(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff(uuid,integer,text,text,text) TO zap_pronto_api;

COMMIT;
