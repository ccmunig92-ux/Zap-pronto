BEGIN;

INSERT INTO app_permissions(code) VALUES('sla_alert.read'),('sla_alert.acknowledge') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,permission.code FROM app_roles role CROSS JOIN app_permissions permission
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR')
  AND permission.code IN('sla_alert.read','sla_alert.acknowledge') ON CONFLICT DO NOTHING;

CREATE TABLE handoff_sla_acknowledgements(
  tenant_id uuid NOT NULL, handoff_id uuid NOT NULL, unit_id uuid NOT NULL,
  acknowledged_by_user_id uuid NOT NULL, acknowledged_at timestamptz NOT NULL,
  handoff_version integer NOT NULL CHECK(handoff_version>0), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(tenant_id,handoff_id),
  FOREIGN KEY(tenant_id,handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,acknowledged_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE handoff_sla_acknowledge_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  handoff_id uuid NOT NULL,unit_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  result_acknowledged_at timestamptz NOT NULL,result_version integer NOT NULL CHECK(result_version>0),
  correlation_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,handoff_id) REFERENCES human_handoffs(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE handoff_sla_acknowledgements ENABLE ROW LEVEL SECURITY;ALTER TABLE handoff_sla_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE handoff_sla_acknowledge_commands ENABLE ROW LEVEL SECURITY;ALTER TABLE handoff_sla_acknowledge_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_sla_ack_tenant ON handoff_sla_acknowledgements USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY handoff_sla_ack_commands_tenant ON handoff_sla_acknowledge_commands USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON handoff_sla_acknowledgements,handoff_sla_acknowledge_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_sla_alerts(requested_unit_id uuid,requested_limit integer,requested_sla_status text,
  requested_priority text,requested_as_of timestamptz,anchor_alert_rank integer DEFAULT NULL,
  anchor_priority_rank integer DEFAULT NULL,anchor_sla_due_at timestamptz DEFAULT NULL,
  anchor_queued_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(handoff_id uuid,unit_id uuid,priority text,sla_status text,sla_due_at timestamptz,queued_at timestamptz,
  age_seconds integer,available_capacity integer,acknowledged_at timestamptz,acknowledgement_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 101 OR requested_as_of IS NULL
    OR (requested_sla_status IS NOT NULL AND requested_sla_status NOT IN('MISSING_SLA','DUE_SOON','OVERDUE'))
    OR (requested_priority IS NOT NULL AND requested_priority NOT IN('LOW','NORMAL','HIGH','URGENT'))
    OR ((anchor_id IS NULL)<>(anchor_alert_rank IS NULL) OR (anchor_id IS NULL)<>(anchor_priority_rank IS NULL)
      OR (anchor_id IS NULL)<>(anchor_queued_at IS NULL))
    OR (anchor_alert_rank IS NOT NULL AND anchor_alert_rank NOT BETWEEN 1 AND 3)
    OR (anchor_priority_rank IS NOT NULL AND anchor_priority_rank NOT BETWEEN 1 AND 4) THEN
    RAISE EXCEPTION 'INVALID_SLA_ALERT_LIST_REQUEST' USING ERRCODE='P0001'; END IF;
  IF NOT public.current_actor_has_permission('sla_alert.read',requested_unit_id) THEN
    RAISE EXCEPTION 'SLA_ALERT_LIST_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  RETURN QUERY WITH candidates AS(
    SELECT handoff.*,CASE WHEN handoff.sla_due_at IS NULL THEN 'MISSING_SLA'
      WHEN handoff.sla_due_at<=requested_as_of THEN 'OVERDUE' ELSE 'DUE_SOON' END derived_status,
      CASE WHEN handoff.sla_due_at IS NOT NULL AND handoff.sla_due_at<=requested_as_of THEN 1
        WHEN handoff.sla_due_at IS NULL THEN 2 ELSE 3 END alert_rank,
      CASE handoff.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END priority_rank
    FROM public.human_handoffs handoff JOIN public.units unit ON unit.tenant_id=handoff.tenant_id
      AND unit.id=handoff.unit_id AND unit.active
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id
      AND conversation.id=handoff.conversation_id AND conversation.unit_id=handoff.unit_id
      AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_QUEUED'
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id
      AND service_case.id=handoff.service_case_id AND service_case.unit_id=handoff.unit_id
      AND service_case.conversation_id=handoff.conversation_id AND service_case.status='WAITING_HUMAN'
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
      AND handoff.status='QUEUED' AND handoff.queued_at IS NOT NULL
      AND (handoff.sla_due_at IS NULL OR handoff.sla_due_at<=requested_as_of+interval '15 minutes'))
  SELECT candidate.id,candidate.unit_id,candidate.priority::text,candidate.derived_status,
    candidate.sla_due_at,date_trunc('milliseconds',candidate.queued_at),
    greatest(0,floor(extract(epoch FROM requested_as_of-candidate.queued_at)))::integer,
    COALESCE(capacity.available_capacity,0),ack.acknowledged_at,ack.version
  FROM candidates candidate
  LEFT JOIN public.handoff_sla_acknowledgements ack ON ack.tenant_id=candidate.tenant_id AND ack.handoff_id=candidate.id
  LEFT JOIN LATERAL(SELECT COALESCE(sum(greatest(availability.max_active-active.active_count,0)),0)::integer available_capacity
    FROM public.attendant_unit_availability availability
    JOIN public.user_units membership ON membership.tenant_id=availability.tenant_id AND membership.unit_id=availability.unit_id
      AND membership.user_id=availability.user_id AND membership.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
    JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id AND account.status='ACTIVE'
    LEFT JOIN LATERAL(SELECT count(*)::integer active_count FROM public.human_handoffs assigned
      WHERE assigned.tenant_id=availability.tenant_id AND assigned.unit_id=availability.unit_id
        AND assigned.assigned_user_id=availability.user_id AND assigned.status='ACTIVE') active ON true
    WHERE availability.tenant_id=candidate.tenant_id AND availability.unit_id=candidate.unit_id
      AND availability.status='AVAILABLE') capacity ON true
  WHERE (requested_sla_status IS NULL OR candidate.derived_status=requested_sla_status)
    AND (requested_priority IS NULL OR candidate.priority::text=requested_priority)
    AND (anchor_id IS NULL OR (candidate.alert_rank,candidate.priority_rank,
      COALESCE(candidate.sla_due_at,'infinity'::timestamptz),date_trunc('milliseconds',candidate.queued_at),candidate.id)>
      (anchor_alert_rank,anchor_priority_rank,COALESCE(anchor_sla_due_at,'infinity'::timestamptz),anchor_queued_at,anchor_id))
  ORDER BY candidate.alert_rank,candidate.priority_rank,COALESCE(candidate.sla_due_at,'infinity'::timestamptz),
    date_trunc('milliseconds',candidate.queued_at),candidate.id LIMIT requested_limit;
END $$;

CREATE FUNCTION acknowledge_inbox_sla_alert(requested_handoff_id uuid,requested_expected_version integer,
  requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,unit_id uuid,acknowledged_at timestamptz,acknowledged_by_user_id uuid,
  version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_key);computed text;command_record public.handoff_sla_acknowledge_commands%ROWTYPE;
  handoff_record public.human_handoffs%ROWTYPE;created public.handoff_sla_acknowledgements%ROWTYPE;now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'INVALID_SLA_ALERT_ACKNOWLEDGEMENT_REQUEST' USING ERRCODE='P0001'; END IF;
  computed:=encode(digest(convert_to(format('{"expectedVersion":%s,"handoffId":"%s"}',requested_expected_version,
    lower(requested_handoff_id::text)),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed THEN RAISE EXCEPTION 'INVALID_SLA_ALERT_ACKNOWLEDGEMENT_REQUEST' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':sla-alert-ack:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.handoff_sla_acknowledge_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command_record.handoff_id<>requested_handoff_id OR command_record.expected_version<>requested_expected_version
      OR command_record.actor_id<>public.current_app_actor_id() OR command_record.request_fingerprint<>computed THEN
      RAISE EXCEPTION 'SLA_ALERT_ACKNOWLEDGEMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    IF NOT public.current_actor_has_permission('sla_alert.acknowledge',command_record.unit_id) THEN
      RAISE EXCEPTION 'SLA_ALERT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    RETURN QUERY SELECT command_record.handoff_id,command_record.unit_id,command_record.result_acknowledged_at,
      command_record.actor_id,command_record.result_version,true;RETURN;
  END IF;
  SELECT handoff.* INTO handoff_record FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_actor_has_permission('sla_alert.acknowledge',handoff_record.unit_id) THEN
    RAISE EXCEPTION 'SLA_ALERT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF handoff_record.version<>requested_expected_version OR handoff_record.status<>'QUEUED' OR handoff_record.queued_at IS NULL
    OR (handoff_record.sla_due_at IS NOT NULL AND handoff_record.sla_due_at>now_at+interval '15 minutes') THEN
    RAISE EXCEPTION 'SLA_ALERT_ACKNOWLEDGEMENT_CONFLICT' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.handoff_sla_acknowledgements(tenant_id,handoff_id,unit_id,acknowledged_by_user_id,
    acknowledged_at,handoff_version) VALUES(handoff_record.tenant_id,handoff_record.id,handoff_record.unit_id,
    public.current_app_actor_id(),now_at,handoff_record.version) RETURNING * INTO created;
  INSERT INTO public.handoff_sla_acknowledge_commands(tenant_id,idempotency_key,handoff_id,unit_id,expected_version,
    request_fingerprint,actor_id,result_acknowledged_at,result_version,correlation_id)
  VALUES(handoff_record.tenant_id,normalized_key,handoff_record.id,handoff_record.unit_id,requested_expected_version,
    computed,public.current_app_actor_id(),created.acknowledged_at,created.version,current_setting('app.correlation_id'));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(handoff_record.tenant_id,'USER',public.current_app_actor_id(),'SLA_ALERT_ACKNOWLEDGED','handoff',handoff_record.id::text,
    jsonb_build_object('handoffId',handoff_record.id,'unitId',handoff_record.unit_id,'handoffVersion',handoff_record.version));
  RETURN QUERY SELECT created.handoff_id,created.unit_id,created.acknowledged_at,created.acknowledged_by_user_id,
    created.version,false;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'SLA_ALERT_ACKNOWLEDGEMENT_CONFLICT' USING ERRCODE='P0001';
END $$;

REVOKE ALL ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
REVOKE ALL ON FUNCTION acknowledge_inbox_sla_alert(uuid,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid) TO zap_pronto_api;
GRANT EXECUTE ON FUNCTION acknowledge_inbox_sla_alert(uuid,integer,text,text) TO zap_pronto_api;

COMMIT;
