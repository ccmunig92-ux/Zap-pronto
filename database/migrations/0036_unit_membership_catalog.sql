BEGIN;

CREATE FUNCTION admin_list_unit_memberships(requested_unit_id uuid,anchor_display_name text,
  anchor_user_id uuid,requested_limit integer)
RETURNS TABLE(user_id uuid,display_name text,role text,status text,version integer,allowed_actions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  WITH request AS (
    SELECT public.current_app_tenant_id() AS tenant_id,public.current_app_actor_id() AS actor_id,
      public.current_actor_has_permission('unit.members.manage',requested_unit_id) AS can_manage_unit,
      public.current_actor_has_permission('tenant.users.manage',NULL) AS can_manage_tenant
  ), admin_count AS (
    SELECT count(*)::integer AS value FROM public.user_units membership CROSS JOIN request
    JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      AND account.status='ACTIVE'
    JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active
    WHERE membership.tenant_id=request.tenant_id AND membership.role='TENANT_ADMIN' AND membership.status='ACTIVE'
  )
  SELECT membership.user_id,pg_catalog.left(account.display_name,160),membership.role,membership.status,
    membership.version,
    CASE
      WHEN membership.user_id=request.actor_id OR account.status<>'ACTIVE' THEN ARRAY[]::text[]
      WHEN membership.role='TENANT_ADMIN' AND (NOT request.can_manage_tenant OR
        (membership.status='ACTIVE' AND admin_count.value=1)) THEN ARRAY[]::text[]
      WHEN membership.status='ACTIVE' AND (EXISTS(SELECT 1 FROM public.human_handoffs handoff
        WHERE handoff.tenant_id=membership.tenant_id AND handoff.unit_id=membership.unit_id
          AND handoff.assigned_user_id=membership.user_id AND handoff.status='ACTIVE')
        OR EXISTS(SELECT 1 FROM public.conversations conversation
        WHERE conversation.tenant_id=membership.tenant_id AND conversation.unit_id=membership.unit_id
          AND conversation.assigned_user_id=membership.user_id AND conversation.automation_status='HUMAN_ACTIVE'))
        THEN ARRAY[]::text[]
      WHEN membership.status='ACTIVE' THEN ARRAY['REVOKE']::text[]
      ELSE ARRAY['REACTIVATE']::text[]
    END
  FROM request CROSS JOIN admin_count
  JOIN public.units unit ON unit.tenant_id=request.tenant_id AND unit.id=requested_unit_id AND unit.active
  JOIN public.user_units membership ON membership.tenant_id=unit.tenant_id AND membership.unit_id=unit.id
  JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
  WHERE request.can_manage_unit
    AND (membership.role<>'TENANT_ADMIN' OR request.can_manage_tenant)
    AND ((anchor_display_name IS NULL AND anchor_user_id IS NULL)
      OR (anchor_display_name IS NOT NULL AND anchor_user_id IS NOT NULL
        AND (pg_catalog.left(account.display_name,160),membership.user_id)>(anchor_display_name,anchor_user_id)))
    AND requested_limit BETWEEN 1 AND 101
  ORDER BY pg_catalog.left(account.display_name,160),membership.user_id LIMIT requested_limit
$$;

REVOKE ALL ON FUNCTION admin_list_unit_memberships(uuid,text,uuid,integer)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION admin_list_unit_memberships(uuid,text,uuid,integer) TO zap_pronto_api;

COMMIT;
