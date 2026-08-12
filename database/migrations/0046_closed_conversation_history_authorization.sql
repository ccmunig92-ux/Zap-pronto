BEGIN;

CREATE OR REPLACE FUNCTION get_inbox_conversation(requested_conversation_id uuid)
RETURNS TABLE(conversation_id uuid,unit_id uuid,channel_connection_id uuid,status text,
  automation_status text,assigned_user_id uuid,version integer,updated_at timestamptz,
  state_changed_at timestamptz,closed_at timestamptz,display_name text,allowed_actions text[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE c public.conversations%ROWTYPE; privileged boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  SELECT * INTO c FROM public.conversations
  WHERE tenant_id=public.current_app_tenant_id() AND id=requested_conversation_id;
  IF NOT FOUND OR c.unit_id IS NULL OR NOT public.current_actor_has_permission('conversation.read',c.unit_id)
    OR (c.status='CLOSED' AND NOT public.current_actor_has_permission('handoff.history.read',c.unit_id)) THEN
    RAISE EXCEPTION 'INBOX_CONVERSATION_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  SELECT public.current_actor_has_permission('conversation.supervise',c.unit_id) INTO privileged;
  IF c.automation_status='HUMAN_ACTIVE' AND c.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    AND NOT privileged THEN RAISE EXCEPTION 'INBOX_CONVERSATION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT c.id,c.unit_id,c.channel_connection_id,c.status::text,c.automation_status::text,
    CASE WHEN privileged OR c.assigned_user_id=public.current_app_actor_id() THEN c.assigned_user_id ELSE NULL END,
    c.version,c.updated_at,c.state_changed_at,c.closed_at,pg_catalog.left(contact.display_name,200),
    CASE WHEN public.current_actor_has_permission('handoff.claim',c.unit_id) AND EXISTS(
      SELECT 1 FROM public.human_handoffs handoff WHERE handoff.tenant_id=c.tenant_id
        AND handoff.conversation_id=c.id AND handoff.status='QUEUED')
      THEN ARRAY['CLAIM_HANDOFF']::text[] ELSE ARRAY[]::text[] END
  FROM public.contacts contact WHERE contact.tenant_id=c.tenant_id AND contact.id=c.contact_id;
END $$;

REVOKE ALL ON FUNCTION get_inbox_conversation(uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation(uuid) TO zap_pronto_api;

COMMIT;
