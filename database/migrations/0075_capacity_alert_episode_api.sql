BEGIN;

-- API reads and authorization lookups for capacity alert episodes.  The
-- episode tables remain inaccessible to the API role; all reads go through
-- these SECURITY DEFINER functions in the current tenant context.
CREATE FUNCTION list_unit_capacity_alert_episodes(requested_unit_id uuid, requested_status text DEFAULT NULL,
  requested_limit integer DEFAULT 25)
RETURNS TABLE(episode_id uuid,unit_id uuid,policy_version integer,status text,opened_at timestamptz,
  last_evaluated_at timestamptz,cooldown_until timestamptz,escalation_level integer,acknowledged_at timestamptz,
  acknowledged_by_user_id uuid,acknowledgement_reason text,escalated_at timestamptz,closed_at timestamptz,
  version integer,recipient_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 100
    OR (requested_status IS NOT NULL AND requested_status NOT IN('OPEN','ACKNOWLEDGED','ESCALATED','RESOLVED'))
    OR NOT public.current_actor_has_permission('sla_alert.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id()
      AND unit.id=requested_unit_id AND unit.active)
  THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_LIST_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  RETURN QUERY
  SELECT episode.id,episode.unit_id,episode.policy_version,episode.status,episode.opened_at,episode.last_evaluated_at,
    episode.cooldown_until,episode.escalation_level,episode.acknowledged_at,episode.acknowledged_by_user_id,
    episode.acknowledgement_reason,episode.escalated_at,episode.closed_at,episode.version,
    count(recipient.recipient_user_id)::integer
  FROM public.unit_capacity_alert_episodes episode
  LEFT JOIN public.unit_capacity_alert_episode_recipients recipient
    ON recipient.tenant_id=episode.tenant_id AND recipient.episode_id=episode.id
  WHERE episode.tenant_id=public.current_app_tenant_id() AND episode.unit_id=requested_unit_id
    AND (requested_status IS NULL OR episode.status=requested_status)
  GROUP BY episode.id
  ORDER BY episode.opened_at DESC,episode.id DESC
  LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_unit_capacity_alert_episodes(uuid,text,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_unit_capacity_alert_episodes(uuid,text,integer) TO zap_pronto_api;

-- The protected route needs the unit scope before invoking the acknowledgement
-- command.  It returns no row for a missing/cross-tenant episode.
CREATE FUNCTION resolve_unit_capacity_alert_episode(requested_episode_id uuid)
RETURNS TABLE(unit_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_episode_id IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT episode.unit_id
  FROM public.unit_capacity_alert_episodes episode
  WHERE episode.tenant_id=public.current_app_tenant_id() AND episode.id=requested_episode_id
    AND public.current_actor_has_permission('sla_alert.acknowledge',episode.unit_id)
    AND episode.status<>'RESOLVED';
END $$;
REVOKE ALL ON FUNCTION resolve_unit_capacity_alert_episode(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_unit_capacity_alert_episode(uuid) TO zap_pronto_api;

COMMIT;
