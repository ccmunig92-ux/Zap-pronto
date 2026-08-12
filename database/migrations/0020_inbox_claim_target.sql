BEGIN;

CREATE FUNCTION get_inbox_conversation_claim_target(requested_conversation_id uuid)
RETURNS TABLE(handoff_id uuid,expected_version integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE ignored record; authorized_unit_id uuid;
BEGIN
  SELECT * INTO ignored FROM public.get_inbox_conversation(requested_conversation_id);
  authorized_unit_id:=ignored.unit_id;
  IF NOT public.current_actor_has_permission('handoff.claim',authorized_unit_id) THEN RETURN; END IF;
  RETURN QUERY SELECT handoff.id,handoff.version
  FROM public.human_handoffs handoff
  WHERE handoff.tenant_id=public.current_app_tenant_id()
    AND handoff.conversation_id=requested_conversation_id
    AND handoff.unit_id=authorized_unit_id AND handoff.status='QUEUED'
  ORDER BY handoff.requested_at,handoff.id LIMIT 1;
END $$;

REVOKE ALL ON FUNCTION get_inbox_conversation_claim_target(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation_claim_target(uuid) TO zap_pronto_api;

COMMIT;
