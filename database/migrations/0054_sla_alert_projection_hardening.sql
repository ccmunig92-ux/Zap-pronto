BEGIN;

ALTER FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  RENAME TO list_inbox_sla_alerts_v0053;
REVOKE ALL ON FUNCTION list_inbox_sla_alerts_v0053(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_sla_alerts(requested_unit_id uuid,requested_limit integer,requested_sla_status text,
  requested_priority text,requested_as_of timestamptz,anchor_alert_rank integer DEFAULT NULL,
  anchor_priority_rank integer DEFAULT NULL,anchor_sla_due_at timestamptz DEFAULT NULL,
  anchor_queued_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(handoff_id uuid,unit_id uuid,priority text,sla_status text,sla_due_at timestamptz,queued_at timestamptz,
  age_seconds integer,available_capacity integer,acknowledged_at timestamptz,acknowledgement_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT projected.handoff_id,projected.unit_id,projected.priority,projected.sla_status,projected.sla_due_at,
    projected.queued_at,projected.age_seconds,projected.available_capacity,projected.acknowledged_at,handoff.version
  FROM public.list_inbox_sla_alerts_v0053(requested_unit_id,requested_limit,requested_sla_status,requested_priority,
    requested_as_of,anchor_alert_rank,anchor_priority_rank,anchor_sla_due_at,anchor_queued_at,anchor_id) projected
  JOIN public.human_handoffs handoff ON handoff.tenant_id=public.current_app_tenant_id()
    AND handoff.id=projected.handoff_id AND handoff.unit_id=projected.unit_id
$$;
REVOKE ALL ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  TO zap_pronto_api;

CREATE FUNCTION resolve_inbox_sla_alert_ack_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE resolved_unit_id uuid;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_handoff_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<1
    OR requested_key IS NULL OR requested_key<>btrim(requested_key) OR length(requested_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SLA_ALERT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT authorized.unit_id INTO resolved_unit_id FROM (
    SELECT command.unit_id,1 precedence FROM public.handoff_sla_acknowledge_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=requested_key
      AND command.handoff_id=requested_handoff_id AND command.expected_version=requested_expected_version
      AND command.request_fingerprint=requested_fingerprint AND command.actor_id=public.current_app_actor_id()
    UNION ALL
    SELECT handoff.unit_id,2 FROM public.human_handoffs handoff
    JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id
      AND conversation.id=handoff.conversation_id AND conversation.unit_id=handoff.unit_id
      AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_QUEUED'
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id
      AND service_case.id=handoff.service_case_id AND service_case.unit_id=handoff.unit_id
      AND service_case.conversation_id=handoff.conversation_id AND service_case.status='WAITING_HUMAN'
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
      AND handoff.version=requested_expected_version AND handoff.status='QUEUED' AND handoff.queued_at IS NOT NULL
      AND (handoff.sla_due_at IS NULL OR handoff.sla_due_at<=clock_timestamp()+interval '15 minutes')
  ) authorized WHERE public.current_actor_has_permission('sla_alert.acknowledge',authorized.unit_id)
  ORDER BY authorized.precedence LIMIT 1;
  IF resolved_unit_id IS NULL THEN RAISE EXCEPTION 'SLA_ALERT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  RETURN resolved_unit_id;
END $$;
REVOKE ALL ON FUNCTION resolve_inbox_sla_alert_ack_unit(uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_sla_alert_ack_unit(uuid,integer,text,text) TO zap_pronto_api;

COMMIT;
