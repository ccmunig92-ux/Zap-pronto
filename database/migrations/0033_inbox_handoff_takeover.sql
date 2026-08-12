BEGIN;

INSERT INTO app_permissions(code) VALUES('handoff.takeover') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'handoff.takeover' FROM app_roles role
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR')
ON CONFLICT DO NOTHING;

CREATE TABLE handoff_takeover_commands(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  handoff_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0),
  actor_id uuid NOT NULL,
  previous_assigned_user_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  conversation_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  result_handoff_version integer NOT NULL CHECK(result_handoff_version>0),
  result_conversation_version integer NOT NULL CHECK(result_conversation_version>0),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,previous_assigned_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id)
);
ALTER TABLE handoff_takeover_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_takeover_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_takeover_commands_tenant ON handoff_takeover_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON handoff_takeover_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_supervised_handoffs(requested_unit_id uuid,requested_limit integer,
  anchor_claimed_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL,requested_now timestamptz DEFAULT now())
RETURNS TABLE(id uuid,conversation_id uuid,service_case_id uuid,unit_id uuid,contact_name text,reason text,
  priority text,status text,assigned_user_id uuid,requested_at timestamptz,queued_at timestamptz,sla_due_at timestamptz,
  sla_status text,automation_status text,version integer,claimed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (anchor_claimed_at IS NULL)<>(anchor_id IS NULL) OR requested_now IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUPERVISED_HANDOFF_LIST_REQUEST' USING ERRCODE='P0001';
  END IF;
  IF NOT public.current_actor_has_permission('handoff.takeover',requested_unit_id) THEN
    RAISE EXCEPTION 'SUPERVISED_HANDOFF_LIST_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.human_handoffs handoff
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=anchor_id AND handoff.unit_id=requested_unit_id
      AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL
      AND handoff.claimed_at IS NOT NULL
      AND handoff.assigned_user_id<>public.current_app_actor_id()
      AND date_trunc('milliseconds',handoff.claimed_at)=anchor_claimed_at
      AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
      AND conversation.assigned_user_id=handoff.assigned_user_id AND conversation.unit_id=handoff.unit_id
      AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
      AND service_case.conversation_id=handoff.conversation_id
  ) THEN RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT handoff.id,handoff.conversation_id,handoff.service_case_id,handoff.unit_id,
    pg_catalog.left(contact.display_name,200),handoff.reason,handoff.priority,handoff.status,
    handoff.assigned_user_id,handoff.requested_at,handoff.queued_at,handoff.sla_due_at,
    CASE WHEN handoff.sla_due_at IS NULL THEN NULL WHEN handoff.sla_due_at<=requested_now THEN 'OVERDUE'
      WHEN handoff.sla_due_at<=requested_now+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END,
    conversation.automation_status::text,handoff.version,handoff.claimed_at
  FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL
    AND handoff.claimed_at IS NOT NULL
    AND handoff.assigned_user_id<>public.current_app_actor_id()
    AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=handoff.assigned_user_id AND conversation.unit_id=handoff.unit_id
    AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
    AND service_case.conversation_id=handoff.conversation_id
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',handoff.claimed_at),handoff.id)<(anchor_claimed_at,anchor_id))
  ORDER BY date_trunc('milliseconds',handoff.claimed_at) DESC,handoff.id DESC LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_inbox_supervised_handoffs(uuid,integer,timestamptz,uuid,timestamptz)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_supervised_handoffs(uuid,integer,timestamptz,uuid,timestamptz) TO zap_pronto_api;

CREATE FUNCTION get_inbox_conversation_takeover_target(requested_conversation_id uuid)
RETURNS TABLE(handoff_id uuid,expected_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT handoff.id,handoff.version FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.conversation_id=requested_conversation_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL
    AND handoff.assigned_user_id<>public.current_app_actor_id()
    AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=handoff.assigned_user_id AND conversation.unit_id=handoff.unit_id
    AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
    AND service_case.conversation_id=handoff.conversation_id
    AND public.current_actor_has_permission('handoff.takeover',handoff.unit_id)
    AND NOT EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=handoff.tenant_id
      AND message.conversation_id=handoff.conversation_id AND message.direction='OUTBOUND'
      AND message.actor='HUMAN' AND message.delivery_status='QUEUED')
  ORDER BY handoff.claimed_at DESC,handoff.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION get_inbox_conversation_takeover_target(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation_takeover_target(uuid) TO zap_pronto_api;

CREATE FUNCTION resolve_inbox_handoff_takeover_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT authorized.unit_id FROM (
    SELECT handoff.unit_id,1 AS precedence FROM public.human_handoffs handoff
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
      AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL
      AND handoff.assigned_user_id<>public.current_app_actor_id()
      AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
      AND conversation.assigned_user_id=handoff.assigned_user_id AND conversation.unit_id=handoff.unit_id
      AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
      AND service_case.conversation_id=handoff.conversation_id
    UNION ALL
    SELECT command.unit_id,2 FROM public.handoff_takeover_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.handoff_id=requested_handoff_id AND command.expected_version=requested_expected_version
      AND command.actor_id=public.current_app_actor_id() AND command.request_fingerprint=requested_fingerprint
      AND public.current_actor_has_permission('handoff.takeover',command.unit_id)
  ) authorized ORDER BY authorized.precedence LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_takeover_unit(uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_takeover_unit(uuid,integer,text,text) TO zap_pronto_api;

CREATE FUNCTION takeover_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,previous_assigned_user_id uuid,
  handoff_version integer,conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;computed_fingerprint text;command_record public.handoff_takeover_commands%ROWTYPE;
  handoff_record public.human_handoffs%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  case_record public.service_cases%ROWTYPE;next_handoff integer;next_conversation integer;now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=btrim(requested_key);
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR normalized_key IS NULL OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_TAKEOVER_REQUEST' USING ERRCODE='P0001';
  END IF;
  computed_fingerprint:=encode(public.digest(convert_to(format('{"expectedVersion":%s,"handoffId":"%s"}',
    requested_expected_version,lower(requested_handoff_id::text)),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed_fingerprint THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_TAKEOVER_REQUEST' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':handoff-takeover:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.handoff_takeover_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command_record.handoff_id IS DISTINCT FROM requested_handoff_id
      OR command_record.expected_version IS DISTINCT FROM requested_expected_version
      OR command_record.actor_id IS DISTINCT FROM public.current_app_actor_id()
      OR command_record.request_fingerprint IS DISTINCT FROM computed_fingerprint THEN
      RAISE EXCEPTION 'HANDOFF_TAKEOVER_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    IF NOT public.current_actor_has_permission('handoff.takeover',command_record.unit_id) THEN
      RAISE EXCEPTION 'HANDOFF_TAKEOVER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    handoff_id:=command_record.handoff_id;conversation_id:=command_record.conversation_id;
    service_case_id:=command_record.service_case_id;previous_assigned_user_id:=command_record.previous_assigned_user_id;
    handoff_version:=command_record.result_handoff_version;conversation_version:=command_record.result_conversation_version;
    replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT handoff.* INTO handoff_record FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR handoff_record.assigned_user_id IS NULL
    OR handoff_record.assigned_user_id IS NOT DISTINCT FROM public.current_app_actor_id()
    OR NOT public.current_actor_has_permission('handoff.takeover',handoff_record.unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_TAKEOVER_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT service_case.* INTO case_record FROM public.service_cases service_case
  WHERE service_case.tenant_id=handoff_record.tenant_id AND service_case.id=handoff_record.service_case_id FOR UPDATE;
  SELECT conversation.* INTO conversation_record FROM public.conversations conversation
  WHERE conversation.tenant_id=handoff_record.tenant_id AND conversation.id=handoff_record.conversation_id FOR UPDATE;
  IF handoff_record.version<>requested_expected_version OR handoff_record.status<>'ACTIVE'
    OR conversation_record.status<>'OPEN' OR conversation_record.automation_status<>'HUMAN_ACTIVE'
    OR conversation_record.assigned_user_id IS DISTINCT FROM handoff_record.assigned_user_id
    OR conversation_record.unit_id IS DISTINCT FROM handoff_record.unit_id
    OR case_record.status<>'IN_REVIEW' OR case_record.unit_id IS DISTINCT FROM handoff_record.unit_id
    OR case_record.conversation_id IS DISTINCT FROM handoff_record.conversation_id
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=handoff_record.tenant_id
      AND unit.id=handoff_record.unit_id AND unit.active) THEN
    RAISE EXCEPTION 'HANDOFF_TAKEOVER_CONFLICT' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=handoff_record.tenant_id
    AND message.conversation_id=handoff_record.conversation_id AND message.direction='OUTBOUND'
    AND message.actor='HUMAN' AND message.delivery_status='QUEUED') THEN
    RAISE EXCEPTION 'HANDOFF_TAKEOVER_PENDING_OUTBOUND' USING ERRCODE='P0001'; END IF;
  UPDATE public.human_handoffs SET assigned_user_id=public.current_app_actor_id(),state_changed_at=now_at,version=version+1
  WHERE tenant_id=handoff_record.tenant_id AND id=handoff_record.id RETURNING version INTO next_handoff;
  UPDATE public.conversations SET assigned_user_id=public.current_app_actor_id(),state_changed_at=now_at,
    updated_at=now_at,version=version+1 WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id
  RETURNING version INTO next_conversation;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (handoff_record.tenant_id,'HANDOFF',handoff_record.id,'ACTIVE','ACTIVE','SUPERVISOR_TAKEOVER',public.current_app_actor_id(),current_setting('app.correlation_id'),
      jsonb_build_object('fromUserId',handoff_record.assigned_user_id,'toUserId',public.current_app_actor_id())),
    (handoff_record.tenant_id,'CONVERSATION',conversation_record.id,'HUMAN_ACTIVE','HUMAN_ACTIVE','SUPERVISOR_TAKEOVER',public.current_app_actor_id(),current_setting('app.correlation_id'),
      jsonb_build_object('fromUserId',handoff_record.assigned_user_id,'toUserId',public.current_app_actor_id()));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_TAKEN_OVER','handoff',handoff_record.id::text,
    jsonb_build_object('fromUserId',handoff_record.assigned_user_id,'toUserId',public.current_app_actor_id(),
      'handoffVersion',next_handoff,'conversationVersion',next_conversation));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(handoff_record.tenant_id,'handoff',handoff_record.id,'handoff.taken_over',
    jsonb_build_object('handoffId',handoff_record.id,'conversationId',conversation_record.id,
      'fromUserId',handoff_record.assigned_user_id,'toUserId',public.current_app_actor_id(),
      'handoffVersion',next_handoff,'conversationVersion',next_conversation),
    'handoff.taken_over:'||handoff_record.id::text||':'||next_handoff::text);
  INSERT INTO public.handoff_takeover_commands(tenant_id,idempotency_key,handoff_id,expected_version,actor_id,
    previous_assigned_user_id,unit_id,request_fingerprint,conversation_id,service_case_id,result_handoff_version,
    result_conversation_version,correlation_id)
  VALUES(handoff_record.tenant_id,normalized_key,handoff_record.id,requested_expected_version,public.current_app_actor_id(),
    handoff_record.assigned_user_id,handoff_record.unit_id,computed_fingerprint,conversation_record.id,case_record.id,
    next_handoff,next_conversation,current_setting('app.correlation_id'));
  handoff_id:=handoff_record.id;conversation_id:=conversation_record.id;service_case_id:=case_record.id;
  previous_assigned_user_id:=handoff_record.assigned_user_id;handoff_version:=next_handoff;
  conversation_version:=next_conversation;replayed:=false;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION takeover_inbox_handoff(uuid,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION takeover_inbox_handoff(uuid,integer,text,text) TO zap_pronto_api;

COMMIT;
