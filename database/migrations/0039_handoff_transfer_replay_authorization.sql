BEGIN;

ALTER TABLE handoff_transfer_commands ADD COLUMN unit_id uuid;
UPDATE handoff_transfer_commands command SET unit_id=handoff.unit_id
FROM human_handoffs handoff
WHERE handoff.tenant_id=command.tenant_id AND handoff.id=command.handoff_id;
ALTER TABLE handoff_transfer_commands ALTER COLUMN unit_id SET NOT NULL;
ALTER TABLE handoff_transfer_commands ADD CONSTRAINT handoff_transfer_commands_unit_fk
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id);

CREATE OR REPLACE FUNCTION transfer_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_target_user_id uuid,requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,target_user_id uuid,
  handoff_version integer,conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;computed_fingerprint text;command_record public.handoff_transfer_commands%ROWTYPE;
  handoff_record public.human_handoffs%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  case_record public.service_cases%ROWTYPE;target_record uuid;next_handoff integer;next_conversation integer;now_at timestamptz:=now();
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=btrim(requested_key);
  IF requested_handoff_id IS NULL OR requested_target_user_id IS NULL
    OR requested_expected_version IS NULL OR requested_expected_version<1 OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_TRANSFER_REQUEST' USING ERRCODE='P0001';
  END IF;
  computed_fingerprint:=encode(digest(convert_to(format('{"expectedVersion":%s,"handoffId":"%s","targetUserId":"%s"}',
    requested_expected_version,lower(requested_handoff_id::text),lower(requested_target_user_id::text)),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed_fingerprint THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_TRANSFER_REQUEST' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':handoff-transfer:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.handoff_transfer_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command_record.handoff_id<>requested_handoff_id OR command_record.expected_version<>requested_expected_version
      OR command_record.target_user_id<>requested_target_user_id OR command_record.actor_id<>public.current_app_actor_id()
      OR command_record.request_fingerprint<>computed_fingerprint THEN
      RAISE EXCEPTION 'HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    IF NOT public.current_actor_has_permission('handoff.transfer',command_record.unit_id) THEN
      RAISE EXCEPTION 'HANDOFF_TRANSFER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    RETURN QUERY SELECT command_record.handoff_id,command_record.conversation_id,command_record.service_case_id,
      command_record.target_user_id,command_record.handoff_version,command_record.conversation_version,true;
    RETURN;
  END IF;
  SELECT handoff.* INTO handoff_record FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR handoff_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR NOT public.current_actor_has_permission('handoff.transfer',handoff_record.unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_TRANSFER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT service_case.* INTO case_record FROM public.service_cases service_case
    WHERE service_case.tenant_id=handoff_record.tenant_id AND service_case.id=handoff_record.service_case_id FOR UPDATE;
  SELECT conversation.* INTO conversation_record FROM public.conversations conversation
    WHERE conversation.tenant_id=handoff_record.tenant_id AND conversation.id=handoff_record.conversation_id FOR UPDATE;
  IF case_record.id IS NULL OR conversation_record.id IS NULL
    OR handoff_record.version<>requested_expected_version OR handoff_record.status<>'ACTIVE'
    OR case_record.status<>'IN_REVIEW' OR case_record.unit_id IS DISTINCT FROM handoff_record.unit_id
    OR case_record.conversation_id IS DISTINCT FROM handoff_record.conversation_id
    OR conversation_record.status<>'OPEN' OR conversation_record.automation_status<>'HUMAN_ACTIVE'
    OR conversation_record.unit_id IS DISTINCT FROM handoff_record.unit_id
    OR conversation_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id() THEN
    RAISE EXCEPTION 'HANDOFF_TRANSFER_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT target.id INTO target_record FROM public.users target JOIN public.user_units membership
      ON membership.tenant_id=target.tenant_id AND membership.user_id=target.id
      AND membership.unit_id=handoff_record.unit_id AND membership.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active
    WHERE target.tenant_id=handoff_record.tenant_id AND target.id=requested_target_user_id AND target.status='ACTIVE'
      AND target.id<>public.current_app_actor_id() FOR SHARE OF target,membership,unit;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_TRANSFER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  UPDATE public.human_handoffs SET assigned_user_id=requested_target_user_id,state_changed_at=now_at,version=version+1
    WHERE tenant_id=handoff_record.tenant_id AND id=handoff_record.id RETURNING version INTO next_handoff;
  UPDATE public.conversations SET assigned_user_id=requested_target_user_id,state_changed_at=now_at,updated_at=now_at,version=version+1
    WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id RETURNING version INTO next_conversation;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (handoff_record.tenant_id,'HANDOFF',handoff_record.id,'ACTIVE','ACTIVE','ATTENDANT_TRANSFERRED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id)),
    (handoff_record.tenant_id,'CONVERSATION',conversation_record.id,'HUMAN_ACTIVE','HUMAN_ACTIVE','ATTENDANT_TRANSFERRED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_TRANSFERRED','handoff',handoff_record.id::text,jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id,'handoffVersion',next_handoff));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES(handoff_record.tenant_id,'handoff',handoff_record.id,'handoff.transferred',jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id,'handoffVersion',next_handoff,'conversationVersion',next_conversation),'handoff.transferred:'||handoff_record.id::text||':'||next_handoff::text);
  INSERT INTO public.handoff_transfer_commands(tenant_id,idempotency_key,handoff_id,expected_version,target_user_id,actor_id,
    request_fingerprint,conversation_id,service_case_id,handoff_version,conversation_version,correlation_id,unit_id)
  VALUES(handoff_record.tenant_id,normalized_key,handoff_record.id,requested_expected_version,requested_target_user_id,
    public.current_app_actor_id(),computed_fingerprint,conversation_record.id,case_record.id,next_handoff,next_conversation,current_setting('app.correlation_id'),handoff_record.unit_id);
  RETURN QUERY SELECT handoff_record.id,conversation_record.id,case_record.id,requested_target_user_id,next_handoff,next_conversation,false;
END$$;

REVOKE ALL ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text) TO zap_pronto_api;

COMMIT;
