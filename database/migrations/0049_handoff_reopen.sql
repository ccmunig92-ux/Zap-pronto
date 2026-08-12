BEGIN;

INSERT INTO app_permissions(code) VALUES('handoff.reopen') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'handoff.reopen' FROM app_roles role
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR') ON CONFLICT DO NOTHING;

CREATE TABLE handoff_reopen_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL,source_handoff_id uuid NOT NULL,
  result_handoff_id uuid NOT NULL,unit_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),
  reason text NOT NULL CHECK(reason IN('FOLLOW_UP_REQUIRED','PREMATURE_CLOSURE','NEW_INFORMATION','OPERATIONAL_CORRECTION')),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  conversation_id uuid NOT NULL,service_case_id uuid NOT NULL,
  result_handoff_version integer NOT NULL CHECK(result_handoff_version>0),
  result_conversation_version integer NOT NULL CHECK(result_conversation_version>0),
  result_service_case_version integer NOT NULL CHECK(result_service_case_version>0),
  correlation_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,source_handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,result_handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id)
);
ALTER TABLE handoff_reopen_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_reopen_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_reopen_commands_tenant ON handoff_reopen_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON handoff_reopen_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION enforce_operational_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean:=false;
BEGIN
  IF TG_TABLE_NAME='conversations' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      allowed:=(OLD.status='OPEN' AND NEW.status='CLOSED') OR (OLD.status='CLOSED' AND NEW.status IN('OPEN','ARCHIVED'));
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.automation_status IS DISTINCT FROM OLD.automation_status THEN
      allowed:=(OLD.automation_status='ACTIVE' AND NEW.automation_status='HUMAN_REQUESTED')
        OR (OLD.automation_status='HUMAN_REQUESTED' AND NEW.automation_status='HUMAN_QUEUED')
        OR (OLD.automation_status='HUMAN_QUEUED' AND NEW.automation_status='HUMAN_ACTIVE')
        OR (OLD.automation_status='HUMAN_ACTIVE' AND NEW.automation_status='HUMAN_QUEUED')
        OR (OLD.automation_status='SUSPENDED' AND NEW.automation_status='HUMAN_QUEUED')
        OR (OLD.automation_status IN('HUMAN_REQUESTED','HUMAN_QUEUED','HUMAN_ACTIVE') AND NEW.automation_status='SUSPENDED');
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;
    END IF;RETURN NEW;
  ELSIF TG_TABLE_NAME='service_cases' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed:=(OLD.status='COLLECTING' AND NEW.status IN('READY_FOR_HANDOFF','WAITING_HUMAN','FAILED','CANCELLED'))
      OR (OLD.status='READY_FOR_HANDOFF' AND NEW.status IN('WAITING_HUMAN','FAILED','CANCELLED'))
      OR (OLD.status='WAITING_HUMAN' AND NEW.status IN('IN_REVIEW','RESOLVED','FAILED','CANCELLED'))
      OR (OLD.status='IN_REVIEW' AND NEW.status IN('WAITING_HUMAN','RESOLVED','FAILED','CANCELLED'))
      OR (OLD.status='RESOLVED' AND NEW.status='WAITING_HUMAN');
  ELSIF TG_TABLE_NAME='human_handoffs' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed:=(OLD.status='REQUESTED' AND NEW.status IN('QUEUED','FAILED','CANCELLED'))
      OR (OLD.status='QUEUED' AND NEW.status IN('ACTIVE','FAILED','CANCELLED'))
      OR (OLD.status='ACTIVE' AND NEW.status IN('QUEUED','RESOLVED','FAILED','CANCELLED'));
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;

CREATE FUNCTION reopen_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_reason text,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(source_handoff_id uuid,handoff_id uuid,conversation_id uuid,service_case_id uuid,
  handoff_version integer,conversation_version integer,service_case_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;command_record public.handoff_reopen_commands%ROWTYPE;
  source_record public.human_handoffs%ROWTYPE;conversation_record public.conversations%ROWTYPE;
  case_record public.service_cases%ROWTYPE;new_handoff_id uuid:=gen_random_uuid();next_conversation integer;next_case integer;
  now_at timestamptz:=clock_timestamp();next_sla timestamptz;
BEGIN
  PERFORM public.assert_app_context_authorized();normalized_key:=btrim(requested_idempotency_key);
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR requested_reason IS NULL OR requested_reason<>btrim(requested_reason)
    OR requested_reason NOT IN('FOLLOW_UP_REQUIRED','PREMATURE_CLOSURE','NEW_INFORMATION','OPERATIONAL_CORRECTION')
    OR normalized_key IS NULL OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_REOPEN_REQUEST' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':handoff-reopen:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.handoff_reopen_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF NOT public.current_actor_has_permission('handoff.reopen',command_record.unit_id)
      OR NOT public.current_actor_has_permission('handoff.history.read',command_record.unit_id) THEN
      RAISE EXCEPTION 'HANDOFF_REOPEN_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    IF command_record.source_handoff_id IS DISTINCT FROM requested_handoff_id
      OR command_record.expected_version IS DISTINCT FROM requested_expected_version
      OR command_record.reason IS DISTINCT FROM requested_reason
      OR command_record.request_fingerprint IS DISTINCT FROM requested_fingerprint
      OR command_record.actor_id IS DISTINCT FROM public.current_app_actor_id() THEN
      RAISE EXCEPTION 'HANDOFF_REOPEN_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    source_handoff_id:=command_record.source_handoff_id;handoff_id:=command_record.result_handoff_id;
    conversation_id:=command_record.conversation_id;service_case_id:=command_record.service_case_id;
    handoff_version:=command_record.result_handoff_version;conversation_version:=command_record.result_conversation_version;
    service_case_version:=command_record.result_service_case_version;replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT handoff.* INTO source_record FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_actor_has_permission('handoff.reopen',source_record.unit_id)
    OR NOT public.current_actor_has_permission('handoff.history.read',source_record.unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_REOPEN_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT service_case.* INTO case_record FROM public.service_cases service_case
  WHERE service_case.tenant_id=source_record.tenant_id AND service_case.id=source_record.service_case_id FOR UPDATE;
  SELECT conversation.* INTO conversation_record FROM public.conversations conversation
  WHERE conversation.tenant_id=source_record.tenant_id AND conversation.id=source_record.conversation_id FOR UPDATE;
  IF source_record.version<>requested_expected_version OR source_record.status<>'RESOLVED' OR source_record.resolved_at IS NULL
    OR case_record.status<>'RESOLVED' OR case_record.resolved_at IS NULL OR case_record.unit_id<>source_record.unit_id
    OR case_record.conversation_id<>source_record.conversation_id OR conversation_record.status<>'CLOSED'
    OR conversation_record.closed_at IS NULL OR conversation_record.automation_status<>'SUSPENDED'
    OR conversation_record.assigned_user_id IS NOT NULL OR conversation_record.unit_id<>source_record.unit_id
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=source_record.tenant_id AND unit.id=source_record.unit_id AND unit.active) THEN
    RAISE EXCEPTION 'HANDOFF_REOPEN_CONFLICT' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public.human_handoffs handoff WHERE handoff.tenant_id=source_record.tenant_id
      AND handoff.conversation_id=source_record.conversation_id AND handoff.status IN('REQUESTED','QUEUED','ACTIVE'))
    OR EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=source_record.tenant_id
      AND message.conversation_id=source_record.conversation_id AND message.direction='OUTBOUND'
      AND message.actor='HUMAN' AND message.delivery_status='QUEUED') THEN
    RAISE EXCEPTION 'HANDOFF_REOPEN_CONFLICT' USING ERRCODE='P0001'; END IF;
  next_sla:=CASE WHEN source_record.sla_due_at IS NULL THEN NULL
    ELSE now_at+greatest(source_record.sla_due_at-source_record.requested_at,interval '0 seconds') END;
  INSERT INTO public.human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,
    assigned_user_id,idempotency_key,requested_at,queued_at,state_changed_at,sla_due_at)
  VALUES(new_handoff_id,source_record.tenant_id,source_record.conversation_id,source_record.service_case_id,
    source_record.unit_id,source_record.reason,source_record.priority,'QUEUED',NULL,'reopen:'||new_handoff_id::text,
    now_at,now_at,now_at,next_sla);
  UPDATE public.service_cases SET status='WAITING_HUMAN',resolved_at=NULL,state_changed_at=now_at,version=version+1
    WHERE tenant_id=case_record.tenant_id AND id=case_record.id RETURNING version INTO next_case;
  UPDATE public.conversations SET status='OPEN',closed_at=NULL,automation_status='HUMAN_QUEUED',assigned_user_id=NULL,
    state_changed_at=now_at,updated_at=now_at,version=version+1
    WHERE tenant_id=conversation_record.tenant_id AND id=conversation_record.id RETURNING version INTO next_conversation;
  INSERT INTO public.workflow_transitions(tenant_id,aggregate_type,aggregate_id,from_status,to_status,reason,actor_id,correlation_id,metadata) VALUES
    (source_record.tenant_id,'HANDOFF',new_handoff_id,NULL,'QUEUED','MANAGER_REOPENED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('reason',requested_reason,'sourceHandoffId',source_record.id)),
    (source_record.tenant_id,'SERVICE_CASE',case_record.id,'RESOLVED','WAITING_HUMAN','MANAGER_REOPENED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('reason',requested_reason,'sourceHandoffId',source_record.id,'handoffId',new_handoff_id)),
    (source_record.tenant_id,'CONVERSATION',conversation_record.id,'SUSPENDED','HUMAN_QUEUED','MANAGER_REOPENED',public.current_app_actor_id(),current_setting('app.correlation_id'),jsonb_build_object('reason',requested_reason,'sourceHandoffId',source_record.id,'handoffId',new_handoff_id));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(source_record.tenant_id,'USER',public.current_app_actor_id(),'HANDOFF_REOPENED','handoff',new_handoff_id::text,
    jsonb_build_object('sourceHandoffId',source_record.id,'handoffId',new_handoff_id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id,'reason',requested_reason));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(source_record.tenant_id,'handoff',new_handoff_id,'handoff.reopened',
    jsonb_build_object('sourceHandoffId',source_record.id,'handoffId',new_handoff_id,'conversationId',conversation_record.id,'serviceCaseId',case_record.id,'reason',requested_reason),
    'handoff.reopened:'||new_handoff_id::text);
  INSERT INTO public.handoff_reopen_commands(tenant_id,idempotency_key,source_handoff_id,result_handoff_id,unit_id,
    expected_version,reason,request_fingerprint,actor_id,conversation_id,service_case_id,result_handoff_version,
    result_conversation_version,result_service_case_version,correlation_id)
  VALUES(source_record.tenant_id,normalized_key,source_record.id,new_handoff_id,source_record.unit_id,requested_expected_version,
    requested_reason,requested_fingerprint,public.current_app_actor_id(),conversation_record.id,case_record.id,1,
    next_conversation,next_case,current_setting('app.correlation_id'));
  source_handoff_id:=source_record.id;handoff_id:=new_handoff_id;conversation_id:=conversation_record.id;
  service_case_id:=case_record.id;handoff_version:=1;conversation_version:=next_conversation;
  service_case_version:=next_case;replayed:=false;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) TO zap_pronto_api;

CREATE FUNCTION resolve_inbox_handoff_reopen_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_reason text,requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT unit_id FROM (
    SELECT handoff.unit_id,1 precedence FROM public.human_handoffs handoff
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
      AND handoff.status='RESOLVED' AND handoff.version=requested_expected_version
      AND service_case.status='RESOLVED' AND conversation.status='CLOSED' AND conversation.automation_status='SUSPENDED'
      AND service_case.unit_id=handoff.unit_id AND service_case.conversation_id=handoff.conversation_id
      AND conversation.unit_id=handoff.unit_id
    UNION ALL
    SELECT command.unit_id,2 FROM public.handoff_reopen_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.source_handoff_id=requested_handoff_id AND command.expected_version=requested_expected_version
      AND command.reason=btrim(requested_reason) AND command.request_fingerprint=requested_fingerprint
      AND command.actor_id=public.current_app_actor_id()
  ) authorized ORDER BY precedence LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_reopen_unit(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_reopen_unit(uuid,integer,text,text,text) TO zap_pronto_api;

CREATE FUNCTION list_inbox_resolved_handoffs_v3(requested_unit_id uuid,requested_limit integer,
  requested_priority text DEFAULT NULL,requested_disposition text DEFAULT NULL,
  requested_from timestamptz DEFAULT NULL,requested_before timestamptz DEFAULT NULL,
  anchor_resolved_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,conversation_id uuid,unit_id uuid,contact_name text,reason text,priority text,
  resolved_at timestamptz,disposition text,resolved_by_user_id uuid,resolved_by_display_name text,version integer,
  reopen_handoff_id uuid,reopen_expected_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (requested_priority IS NOT NULL AND requested_priority NOT IN('LOW','NORMAL','HIGH','URGENT'))
    OR (requested_disposition IS NOT NULL AND requested_disposition NOT IN
      ('LEGACY_UNSPECIFIED','RESOLVED','DUPLICATE','CUSTOMER_WITHDREW','EXTERNAL_REFERRAL'))
    OR (requested_from IS NOT NULL AND requested_before IS NOT NULL AND
      (requested_from>=requested_before OR requested_before-requested_from>interval '366 days'))
    OR (anchor_resolved_at IS NULL)<>(anchor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_RESOLVED_HANDOFF_LIST_REQUEST' USING ERRCODE='P0001'; END IF;
  IF NOT public.current_actor_has_permission('handoff.history.read',requested_unit_id) THEN
    RAISE EXCEPTION 'RESOLVED_HANDOFF_LIST_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.human_handoffs handoff
    LEFT JOIN LATERAL(SELECT resolved.disposition FROM public.handoff_resolve_commands resolved
      WHERE resolved.tenant_id=handoff.tenant_id AND resolved.handoff_id=handoff.id
        AND resolved.result_handoff_version=handoff.version
      ORDER BY resolved.created_at DESC,resolved.idempotency_key DESC LIMIT 1) command ON true
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
      AND handoff.id=anchor_id AND handoff.status='RESOLVED' AND handoff.resolved_at IS NOT NULL
      AND date_trunc('milliseconds',handoff.resolved_at)=anchor_resolved_at
      AND (requested_priority IS NULL OR handoff.priority::text=requested_priority)
      AND (requested_disposition IS NULL OR COALESCE(command.disposition,'LEGACY_UNSPECIFIED')=requested_disposition)
      AND (requested_from IS NULL OR handoff.resolved_at>=requested_from)
      AND (requested_before IS NULL OR handoff.resolved_at<requested_before)) THEN
    RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT handoff.id,handoff.conversation_id,handoff.unit_id,pg_catalog.left(contact.display_name,160),
    handoff.reason,handoff.priority::text,date_trunc('milliseconds',handoff.resolved_at),
    COALESCE(command.disposition,'LEGACY_UNSPECIFIED'),command.actor_id,pg_catalog.left(actor.display_name,160),handoff.version,
    CASE WHEN eligible.can_reopen THEN handoff.id END,CASE WHEN eligible.can_reopen THEN handoff.version END
  FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id
    AND conversation.id=handoff.conversation_id AND conversation.unit_id=handoff.unit_id
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id
    AND service_case.id=handoff.service_case_id AND service_case.unit_id=handoff.unit_id
    AND service_case.conversation_id=handoff.conversation_id
  JOIN public.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id
  LEFT JOIN LATERAL(SELECT resolved.disposition,resolved.actor_id FROM public.handoff_resolve_commands resolved
    WHERE resolved.tenant_id=handoff.tenant_id AND resolved.handoff_id=handoff.id
      AND resolved.result_handoff_version=handoff.version
    ORDER BY resolved.created_at DESC,resolved.idempotency_key DESC LIMIT 1) command ON true
  LEFT JOIN public.users actor ON actor.tenant_id=handoff.tenant_id AND actor.id=command.actor_id
  CROSS JOIN LATERAL(SELECT unit.active AND public.current_actor_has_permission('handoff.reopen',handoff.unit_id)
    AND service_case.status='RESOLVED' AND service_case.resolved_at IS NOT NULL
    AND conversation.status='CLOSED' AND conversation.closed_at IS NOT NULL
    AND conversation.automation_status='SUSPENDED' AND conversation.assigned_user_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.human_handoffs open_handoff
      WHERE open_handoff.tenant_id=handoff.tenant_id AND open_handoff.conversation_id=handoff.conversation_id
        AND open_handoff.status IN('REQUESTED','QUEUED','ACTIVE'))
    AND NOT EXISTS(SELECT 1 FROM public.messages message WHERE message.tenant_id=handoff.tenant_id
      AND message.conversation_id=handoff.conversation_id AND message.direction='OUTBOUND'
      AND message.actor='HUMAN' AND message.delivery_status='QUEUED') AS can_reopen) eligible
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
    AND handoff.status='RESOLVED' AND handoff.resolved_at IS NOT NULL
    AND (requested_priority IS NULL OR handoff.priority::text=requested_priority)
    AND (requested_disposition IS NULL OR COALESCE(command.disposition,'LEGACY_UNSPECIFIED')=requested_disposition)
    AND (requested_from IS NULL OR handoff.resolved_at>=requested_from)
    AND (requested_before IS NULL OR handoff.resolved_at<requested_before)
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',handoff.resolved_at),handoff.id)<(anchor_resolved_at,anchor_id))
  ORDER BY date_trunc('milliseconds',handoff.resolved_at) DESC,handoff.id DESC LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs_v2(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  TO zap_pronto_api;

COMMIT;
