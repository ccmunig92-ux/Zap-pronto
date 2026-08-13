BEGIN;

ALTER TABLE handoff_sla_acknowledgements DROP CONSTRAINT handoff_sla_acknowledgements_pkey;
ALTER TABLE handoff_sla_acknowledgements
  ADD PRIMARY KEY(tenant_id,handoff_id,handoff_version);

CREATE OR REPLACE FUNCTION list_inbox_sla_alerts(requested_unit_id uuid,requested_limit integer,requested_sla_status text,
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
    COALESCE(capacity.available_capacity,0),ack.acknowledged_at,candidate.version
  FROM candidates candidate
  LEFT JOIN public.handoff_sla_acknowledgements ack ON ack.tenant_id=candidate.tenant_id
    AND ack.handoff_id=candidate.id AND ack.handoff_version=candidate.version
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

REVOKE ALL ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  TO zap_pronto_api;

COMMIT;
