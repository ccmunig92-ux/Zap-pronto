BEGIN;

ALTER FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text)
  RENAME TO reopen_inbox_handoff_v0049;
REVOKE ALL ON FUNCTION reopen_inbox_handoff_v0049(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION reopen_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_reason text,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(source_handoff_id uuid,handoff_id uuid,conversation_id uuid,service_case_id uuid,
  handoff_version integer,conversation_version integer,service_case_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_idempotency_key);has_command boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  SELECT EXISTS(SELECT 1 FROM public.handoff_reopen_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key
      AND command.actor_id=public.current_app_actor_id()) INTO has_command;
  IF NOT has_command AND EXISTS(SELECT 1 FROM public.human_handoffs source
    JOIN public.handoff_reopen_commands successor ON successor.tenant_id=source.tenant_id
      AND successor.source_handoff_id=source.id
    JOIN public.human_handoffs newer ON newer.tenant_id=successor.tenant_id
      AND newer.id=successor.result_handoff_id AND newer.status='RESOLVED'
    WHERE source.tenant_id=public.current_app_tenant_id() AND source.id=requested_handoff_id
      AND source.status='RESOLVED') THEN
    RAISE EXCEPTION 'HANDOFF_REOPEN_CONFLICT' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT * FROM public.reopen_inbox_handoff_v0049(requested_handoff_id,requested_expected_version,
    requested_reason,requested_idempotency_key,requested_fingerprint);
END $$;
REVOKE ALL ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) TO zap_pronto_api;

ALTER FUNCTION resolve_inbox_handoff_reopen_unit(uuid,integer,text,text,text)
  RENAME TO resolve_inbox_handoff_reopen_unit_v0049;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_reopen_unit_v0049(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION resolve_inbox_handoff_reopen_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_reason text,requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT unit_id FROM (
    SELECT command.unit_id,1 precedence FROM public.handoff_reopen_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.actor_id=public.current_app_actor_id()
    UNION ALL
    SELECT legacy.unit_id,2 FROM public.resolve_inbox_handoff_reopen_unit_v0049(requested_handoff_id,
      requested_expected_version,requested_reason,requested_key,requested_fingerprint) legacy(unit_id)
    WHERE NOT EXISTS(SELECT 1 FROM public.human_handoffs source
      JOIN public.handoff_reopen_commands successor ON successor.tenant_id=source.tenant_id
        AND successor.source_handoff_id=source.id
      JOIN public.human_handoffs newer ON newer.tenant_id=successor.tenant_id
        AND newer.id=successor.result_handoff_id AND newer.status='RESOLVED'
      WHERE source.tenant_id=public.current_app_tenant_id() AND source.id=requested_handoff_id
        AND source.status='RESOLVED')
  ) authorized ORDER BY precedence LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_reopen_unit(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_reopen_unit(uuid,integer,text,text,text) TO zap_pronto_api;

ALTER FUNCTION list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  RENAME TO list_inbox_resolved_handoffs_v3_v0049;
REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs_v3_v0049(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_resolved_handoffs_v3(requested_unit_id uuid,requested_limit integer,
  requested_priority text DEFAULT NULL,requested_disposition text DEFAULT NULL,
  requested_from timestamptz DEFAULT NULL,requested_before timestamptz DEFAULT NULL,
  anchor_resolved_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,conversation_id uuid,unit_id uuid,contact_name text,reason text,priority text,
  resolved_at timestamptz,disposition text,resolved_by_user_id uuid,resolved_by_display_name text,version integer,
  reopen_handoff_id uuid,reopen_expected_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT history.id,history.conversation_id,history.unit_id,history.contact_name,history.reason,history.priority,
    history.resolved_at,history.disposition,history.resolved_by_user_id,history.resolved_by_display_name,history.version,
    CASE WHEN NOT EXISTS(SELECT 1 FROM public.handoff_reopen_commands successor
      JOIN public.human_handoffs newer ON newer.tenant_id=successor.tenant_id
        AND newer.id=successor.result_handoff_id AND newer.status='RESOLVED'
      WHERE successor.tenant_id=public.current_app_tenant_id() AND successor.source_handoff_id=source.id)
      THEN history.reopen_handoff_id END,
    CASE WHEN NOT EXISTS(SELECT 1 FROM public.handoff_reopen_commands successor
      JOIN public.human_handoffs newer ON newer.tenant_id=successor.tenant_id
        AND newer.id=successor.result_handoff_id AND newer.status='RESOLVED'
      WHERE successor.tenant_id=public.current_app_tenant_id() AND successor.source_handoff_id=source.id)
      THEN history.reopen_expected_version END
  FROM public.list_inbox_resolved_handoffs_v3_v0049(requested_unit_id,requested_limit,requested_priority,
    requested_disposition,requested_from,requested_before,anchor_resolved_at,anchor_id) history
  JOIN public.human_handoffs source ON source.tenant_id=public.current_app_tenant_id() AND source.id=history.id
$$;
REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_resolved_handoffs_v3(uuid,integer,text,text,timestamptz,timestamptz,timestamptz,uuid)
  TO zap_pronto_api;

COMMIT;
