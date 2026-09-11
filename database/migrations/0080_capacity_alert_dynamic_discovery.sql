BEGIN;

-- Capacity evaluation is policy-driven. The worker discovers only the latest
-- enabled policy for active tenants/units through this narrow global catalog,
-- without adding a direct grant on the protected policy table.
CREATE FUNCTION list_capacity_alert_evaluation_targets(
  requested_after_tenant_id uuid DEFAULT NULL,
  requested_after_unit_id uuid DEFAULT NULL,
  requested_limit integer DEFAULT 100
)
RETURNS TABLE(tenant_id uuid,unit_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 100
    OR (requested_after_tenant_id IS NULL) <> (requested_after_unit_id IS NULL)
  THEN
    RAISE EXCEPTION 'INVALID_CAPACITY_ALERT_DISCOVERY_REQUEST' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT tenant.id,unit.id
  FROM public.tenants tenant
  JOIN public.units unit ON unit.tenant_id=tenant.id AND unit.active
  JOIN LATERAL (
    SELECT policy.enabled
    FROM public.unit_capacity_alert_policy_versions policy
    WHERE policy.tenant_id=tenant.id AND policy.unit_id=unit.id
    ORDER BY policy.version DESC,policy.id DESC
    LIMIT 1
  ) latest_policy ON latest_policy.enabled
  WHERE tenant.status='ACTIVE'
    AND (requested_after_tenant_id IS NULL
      OR (tenant.id,unit.id)>(requested_after_tenant_id,requested_after_unit_id))
  ORDER BY tenant.id,unit.id
  LIMIT requested_limit;
END $$;

CREATE INDEX unit_capacity_alert_policy_discovery_idx
  ON unit_capacity_alert_policy_versions(tenant_id,unit_id,version DESC,id DESC)
  INCLUDE(enabled);
CREATE INDEX units_active_capacity_discovery_idx ON units(tenant_id,id) WHERE active;

REVOKE ALL ON FUNCTION list_capacity_alert_evaluation_targets(uuid,uuid,integer)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_capacity_alert_evaluation_targets(uuid,uuid,integer)
  TO zap_pronto_worker;

COMMIT;
