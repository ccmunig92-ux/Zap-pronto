BEGIN;

CREATE FUNCTION current_actor_has_permission(
  target_permission text,
  target_unit_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT CASE
    WHEN target_permission IS NULL OR btrim(target_permission) = '' THEN false
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.users account
      JOIN public.tenants tenant ON tenant.id = account.tenant_id
      WHERE account.tenant_id = public.current_app_tenant_id()
        AND account.id = public.current_app_actor_id()
        AND account.status = 'ACTIVE'
        AND tenant.status = 'ACTIVE'
    ) THEN false
    WHEN target_unit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.units unit
      WHERE unit.tenant_id = public.current_app_tenant_id()
        AND unit.id = target_unit_id
        AND unit.active = true
    ) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.user_units membership
      JOIN public.units membership_unit
        ON membership_unit.tenant_id = membership.tenant_id
       AND membership_unit.id = membership.unit_id
       AND membership_unit.active = true
      JOIN public.app_role_permissions role_permission
        ON role_permission.role_code = membership.role
      WHERE membership.tenant_id = public.current_app_tenant_id()
        AND membership.user_id = public.current_app_actor_id()
        AND role_permission.permission_code = target_permission
        AND (
          membership.role = 'TENANT_ADMIN'
          OR (target_unit_id IS NOT NULL AND membership.unit_id = target_unit_id)
        )
    )
  END
$$;

REVOKE ALL ON FUNCTION current_actor_has_permission(text,uuid)
  FROM PUBLIC, zap_pronto_app, zap_pronto_worker;
GRANT EXECUTE ON FUNCTION current_actor_has_permission(text,uuid) TO zap_pronto_api;

COMMIT;
