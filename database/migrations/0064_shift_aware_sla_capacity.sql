BEGIN;

CREATE INDEX human_handoffs_active_assignee_capacity_idx
  ON human_handoffs(tenant_id,unit_id,assigned_user_id) WHERE status='ACTIVE' AND assigned_user_id IS NOT NULL;

ALTER FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  RENAME TO list_inbox_sla_alerts_v0055;
REVOKE ALL ON FUNCTION list_inbox_sla_alerts_v0055(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_sla_alerts(requested_unit_id uuid,requested_limit integer,requested_sla_status text,
  requested_priority text,requested_as_of timestamptz,anchor_alert_rank integer DEFAULT NULL,
  anchor_priority_rank integer DEFAULT NULL,anchor_sla_due_at timestamptz DEFAULT NULL,
  anchor_queued_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(handoff_id uuid,unit_id uuid,priority text,sla_status text,sla_due_at timestamptz,queued_at timestamptz,
  age_seconds integer,available_capacity integer,acknowledged_at timestamptz,acknowledgement_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  WITH projected AS MATERIALIZED(
    SELECT item.* FROM public.list_inbox_sla_alerts_v0055(requested_unit_id,requested_limit,requested_sla_status,
      requested_priority,requested_as_of,anchor_alert_rank,anchor_priority_rank,anchor_sla_due_at,anchor_queued_at,anchor_id) item
  ), active_counts AS MATERIALIZED(
    SELECT assigned.assigned_user_id user_id,count(*)::integer active_count
    FROM public.human_handoffs assigned
    WHERE assigned.tenant_id=public.current_app_tenant_id() AND assigned.unit_id=requested_unit_id
      AND assigned.assigned_user_id IS NOT NULL AND assigned.status='ACTIVE'
    GROUP BY assigned.assigned_user_id
  ), capacity AS MATERIALIZED(
    SELECT COALESCE(sum(greatest(availability.max_active-COALESCE(active.active_count,0),0)),0)::integer available_capacity
    FROM public.attendant_unit_availability availability
    JOIN public.user_units membership ON membership.tenant_id=availability.tenant_id
      AND membership.unit_id=availability.unit_id AND membership.user_id=availability.user_id
      AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
    JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      AND account.status='ACTIVE'
    CROSS JOIN LATERAL public.evaluate_unit_staff_shift_internal(availability.tenant_id,availability.unit_id,
      availability.user_id,requested_as_of) shift
    LEFT JOIN active_counts active ON active.user_id=availability.user_id
    WHERE availability.tenant_id=public.current_app_tenant_id() AND availability.unit_id=requested_unit_id
      AND availability.status='AVAILABLE' AND shift.state='IN_SHIFT'
  )
  SELECT projected.handoff_id,projected.unit_id,projected.priority,projected.sla_status,projected.sla_due_at,
    projected.queued_at,projected.age_seconds,capacity.available_capacity,projected.acknowledged_at,
    projected.acknowledgement_version
  FROM projected CROSS JOIN capacity
$$;

REVOKE ALL ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)
  TO zap_pronto_api;

COMMIT;
