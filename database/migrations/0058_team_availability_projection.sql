BEGIN;

INSERT INTO app_permissions(code) VALUES('availability.supervise') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code) VALUES
  ('TENANT_ADMIN','availability.supervise'),('UNIT_MANAGER','availability.supervise'),('SUPERVISOR','availability.supervise')
ON CONFLICT DO NOTHING;

CREATE FUNCTION list_unit_team_availability(requested_unit_id uuid,requested_limit integer,requested_status text DEFAULT NULL,
  anchor_display_name text DEFAULT NULL,anchor_user_id uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid,display_name text,role text,status text,max_active integer,active_count integer,
  remaining_capacity integer,pause_reason text,paused_until timestamptz,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (requested_status IS NOT NULL AND requested_status NOT IN('AVAILABLE','PAUSED','OFFLINE'))
    OR ((anchor_display_name IS NULL)<>(anchor_user_id IS NULL))
    OR (anchor_display_name IS NOT NULL AND length(anchor_display_name) NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'INVALID_TEAM_AVAILABILITY_REQUEST' USING ERRCODE='22023';END IF;
  IF NOT public.current_actor_has_permission('availability.supervise',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.tenants tenant JOIN public.units unit ON unit.tenant_id=tenant.id
      WHERE tenant.id=public.current_app_tenant_id() AND tenant.status='ACTIVE'
        AND unit.id=requested_unit_id AND unit.active) THEN
    RAISE EXCEPTION 'TEAM_AVAILABILITY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF anchor_user_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.user_units membership
    JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id
      AND availability.unit_id=membership.unit_id AND availability.user_id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id
      AND membership.user_id=anchor_user_id AND membership.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
      AND account.status='ACTIVE' AND account.display_name=anchor_display_name
      AND (requested_status IS NULL OR availability.status=requested_status)) THEN
    RAISE EXCEPTION 'TEAM_AVAILABILITY_CURSOR_INVALID' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT account.id,pg_catalog.left(account.display_name,160),membership.role::text,availability.status,
    availability.max_active,count(handoff.id)::integer,
    greatest(availability.max_active-count(handoff.id)::integer,0),availability.pause_reason,
    availability.paused_until,availability.updated_at
  FROM public.user_units membership
  JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
  JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id
    AND availability.unit_id=membership.unit_id AND availability.user_id=membership.user_id
  LEFT JOIN public.human_handoffs handoff ON handoff.tenant_id=membership.tenant_id AND handoff.unit_id=membership.unit_id
    AND handoff.assigned_user_id=membership.user_id AND handoff.status='ACTIVE'
  WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
    AND account.status='ACTIVE' AND (requested_status IS NULL OR availability.status=requested_status)
    AND (anchor_user_id IS NULL OR (lower(account.display_name),account.display_name,account.id)>
      (lower(anchor_display_name),anchor_display_name,anchor_user_id))
  GROUP BY account.id,account.display_name,membership.role,availability.status,availability.max_active,
    availability.pause_reason,availability.paused_until,availability.updated_at
  ORDER BY lower(account.display_name),account.display_name,account.id LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_unit_team_availability(uuid,integer,text,text,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_unit_team_availability(uuid,integer,text,text,uuid) TO zap_pronto_api;

COMMIT;
