BEGIN;

CREATE OR REPLACE FUNCTION list_inbox_resolved_handoffs(requested_unit_id uuid,requested_limit integer,
  anchor_resolved_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,conversation_id uuid,unit_id uuid,contact_name text,reason text,priority text,
  resolved_at timestamptz,disposition text,resolved_by_user_id uuid,resolved_by_display_name text,version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (anchor_resolved_at IS NULL)<>(anchor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_RESOLVED_HANDOFF_LIST_REQUEST' USING ERRCODE='P0001';
  END IF;
  IF NOT public.current_actor_has_permission('handoff.history.read',requested_unit_id) THEN
    RAISE EXCEPTION 'RESOLVED_HANDOFF_LIST_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.human_handoffs handoff
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id
      AND conversation.id=handoff.conversation_id AND conversation.unit_id=handoff.unit_id
    JOIN public.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
    JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
      AND handoff.id=anchor_id AND handoff.status='RESOLVED' AND handoff.resolved_at IS NOT NULL
      AND date_trunc('milliseconds',handoff.resolved_at)=anchor_resolved_at
  ) THEN RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;

  RETURN QUERY
  SELECT handoff.id,handoff.conversation_id,handoff.unit_id,pg_catalog.left(contact.display_name,160),
    handoff.reason,handoff.priority::text,date_trunc('milliseconds',handoff.resolved_at),
    COALESCE(command.disposition,'LEGACY_UNSPECIFIED'),command.actor_id,pg_catalog.left(actor.display_name,160),handoff.version
  FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id
    AND conversation.id=handoff.conversation_id AND conversation.unit_id=handoff.unit_id
  JOIN public.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id
  LEFT JOIN LATERAL(SELECT resolved.disposition,resolved.actor_id
    FROM public.handoff_resolve_commands resolved
    WHERE resolved.tenant_id=handoff.tenant_id AND resolved.handoff_id=handoff.id
      AND resolved.result_handoff_version=handoff.version
    ORDER BY resolved.created_at DESC,resolved.idempotency_key DESC LIMIT 1) command ON true
  LEFT JOIN public.users actor ON actor.tenant_id=handoff.tenant_id AND actor.id=command.actor_id
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
    AND handoff.status='RESOLVED' AND handoff.resolved_at IS NOT NULL
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',handoff.resolved_at),handoff.id)<(anchor_resolved_at,anchor_id))
  ORDER BY date_trunc('milliseconds',handoff.resolved_at) DESC,handoff.id DESC
  LIMIT requested_limit;
END $$;

REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid) TO zap_pronto_api;

COMMIT;
