BEGIN;

INSERT INTO app_permissions(code) VALUES('handoff.transfer') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'handoff.transfer' FROM app_roles role
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
ON CONFLICT DO NOTHING;

CREATE TABLE handoff_transfer_commands(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  handoff_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0),
  target_user_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  conversation_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  handoff_version integer NOT NULL,
  conversation_version integer NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,target_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id)
);
ALTER TABLE handoff_transfer_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_transfer_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_transfer_commands_tenant ON handoff_transfer_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON handoff_transfer_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_handoff_transfer_candidates(requested_handoff_id uuid)
RETURNS TABLE(id uuid,display_name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT candidate.id,pg_catalog.left(candidate.display_name,160)
  FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  JOIN public.user_units membership ON membership.tenant_id=handoff.tenant_id AND membership.unit_id=handoff.unit_id
    AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
  JOIN public.users candidate ON candidate.tenant_id=membership.tenant_id AND candidate.id=membership.user_id AND candidate.status='ACTIVE'
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
    AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id()
    AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id)
    AND candidate.id<>public.current_app_actor_id()
  ORDER BY candidate.display_name,candidate.id
$$;
REVOKE ALL ON FUNCTION list_inbox_handoff_transfer_candidates(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_handoff_transfer_candidates(uuid) TO zap_pronto_api;

CREATE FUNCTION resolve_inbox_handoff_transfer_catalog_unit(requested_handoff_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT handoff.unit_id FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
    AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id()
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_transfer_catalog_unit(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_transfer_catalog_unit(uuid) TO zap_pronto_api;

CREATE FUNCTION transfer_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_target_user_id uuid,requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,target_user_id uuid,
  handoff_version integer,conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE normalized_key text;computed_fingerprint text;command_record public.handoff_transfer_commands%ROWTYPE;
  handoff_record public.human_handoffs%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  case_record public.service_cases%ROWTYPE;target_record uuid;next_handoff integer;next_conversation integer;now_at timestamptz:=now();
BEGIN
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
  IF handoff_record.version<>requested_expected_version OR handoff_record.status<>'ACTIVE'
    OR case_record.status<>'IN_REVIEW' OR conversation_record.automation_status<>'HUMAN_ACTIVE'
    OR conversation_record.assigned_user_id IS DISTINCT FROM public.current_app_actor_id() THEN
    RAISE EXCEPTION 'HANDOFF_TRANSFER_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT target.id INTO target_record FROM public.users target JOIN public.user_units membership
      ON membership.tenant_id=target.tenant_id AND membership.user_id=target.id
      AND membership.unit_id=handoff_record.unit_id AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active
    WHERE target.tenant_id=handoff_record.tenant_id AND target.id=requested_target_user_id AND target.status='ACTIVE'
      AND target.id<>public.current_app_actor_id() FOR SHARE OF target,membership,unit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HANDOFF_TRANSFER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  UPDATE public.human_handoffs SET assigned_user_id=requested_target_user_id,state_changed_at=now_at,version=version+1
    WHERE tenant_id=handoff_record.tenant_id AND id=handoff_record.id RETURNING version INTO next_handoff;
  UPDATE public.conversations SET assigned_user_id=requested_target_user_id,state_changed_at=now_at,updated_at=now_at,version=version+1
    WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id RETURNING version INTO next_conversation;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (handoff_record.tenant_id,'HANDOFF',handoff_record.id,'ACTIVE','ACTIVE','ATTENDANT_TRANSFERRED',public.current_app_actor_id(),current_setting('app.correlation_id'),
      jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id)),
    (handoff_record.tenant_id,'CONVERSATION',conversation_record.id,'HUMAN_ACTIVE','HUMAN_ACTIVE','ATTENDANT_TRANSFERRED',public.current_app_actor_id(),current_setting('app.correlation_id'),
      jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_TRANSFERRED','handoff',handoff_record.id::text,
      jsonb_build_object('fromUserId',public.current_app_actor_id(),'toUserId',requested_target_user_id,'handoffVersion',next_handoff));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES(handoff_record.tenant_id,'handoff',handoff_record.id,'handoff.transferred',
      jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,'fromUserId',public.current_app_actor_id(),
        'toUserId',requested_target_user_id,'handoffVersion',next_handoff,'conversationVersion',next_conversation),
      'handoff.transferred:'||handoff_record.id::text||':'||next_handoff::text);
  INSERT INTO public.handoff_transfer_commands(tenant_id,idempotency_key,handoff_id,expected_version,target_user_id,actor_id,
    request_fingerprint,conversation_id,service_case_id,handoff_version,conversation_version,correlation_id)
  VALUES(handoff_record.tenant_id,normalized_key,handoff_record.id,requested_expected_version,requested_target_user_id,
    public.current_app_actor_id(),computed_fingerprint,conversation_record.id,case_record.id,next_handoff,next_conversation,current_setting('app.correlation_id'));
  RETURN QUERY SELECT handoff_record.id,conversation_record.id,case_record.id,requested_target_user_id,next_handoff,next_conversation,false;
END$$;
REVOKE ALL ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text) TO zap_pronto_api;

CREATE FUNCTION resolve_inbox_handoff_transfer_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_target_user_id uuid,requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT unit_id FROM (
    SELECT handoff.unit_id,1 AS precedence FROM public.human_handoffs handoff
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
      AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
      AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
      AND conversation.assigned_user_id=public.current_app_actor_id()
    UNION ALL
    SELECT handoff.unit_id,2 FROM public.handoff_transfer_commands command
    JOIN public.human_handoffs handoff ON handoff.tenant_id=command.tenant_id AND handoff.id=command.handoff_id
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.handoff_id=requested_handoff_id AND command.expected_version=requested_expected_version
      AND command.target_user_id=requested_target_user_id AND command.actor_id=public.current_app_actor_id()
      AND command.request_fingerprint=requested_fingerprint
  ) authorized ORDER BY precedence LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_transfer_unit(uuid,integer,uuid,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_transfer_unit(uuid,integer,uuid,text,text) TO zap_pronto_api;

CREATE FUNCTION get_inbox_conversation_transfer_target(requested_conversation_id uuid)
RETURNS TABLE(handoff_id uuid,expected_version integer) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT handoff.id,handoff.version FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND conversation.id=requested_conversation_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
    AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id()
    AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id)
$$;
REVOKE ALL ON FUNCTION get_inbox_conversation_transfer_target(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation_transfer_target(uuid) TO zap_pronto_api;

COMMIT;
