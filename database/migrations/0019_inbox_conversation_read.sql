BEGIN;

INSERT INTO app_permissions(code) VALUES ('conversation.read'),('conversation.supervise') ON CONFLICT DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code) VALUES
  ('TENANT_ADMIN','conversation.read'),('UNIT_MANAGER','conversation.read'),
  ('SUPERVISOR','conversation.read'),('ATTENDANT','conversation.read'),
  ('TENANT_ADMIN','conversation.supervise'),('UNIT_MANAGER','conversation.supervise'),('SUPERVISOR','conversation.supervise')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS messages_inbox_history_idx
  ON messages(tenant_id,conversation_id,created_at DESC,id DESC);

CREATE FUNCTION get_inbox_conversation(requested_conversation_id uuid)
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
  IF NOT FOUND OR c.unit_id IS NULL OR NOT public.current_actor_has_permission('conversation.read',c.unit_id) THEN
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

CREATE FUNCTION list_inbox_conversation_messages(requested_conversation_id uuid,requested_limit integer,
  anchor_created_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,direction text,actor text,body text,kind text,trust text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE ignored record;
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 100 OR (anchor_created_at IS NULL)<>(anchor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_INBOX_CONVERSATION_REQUEST' USING ERRCODE='P0001'; END IF;
  SELECT * INTO ignored FROM public.get_inbox_conversation(requested_conversation_id);
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages message
    WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
      AND message.id=anchor_id AND date_trunc('milliseconds',message.created_at)=anchor_created_at) THEN
    RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT message.id,message.direction,message.actor,
    CASE WHEN COALESCE(message.payload->>'kind','TEXT')='TEXT' THEN message.body ELSE NULL END,
    COALESCE(message.payload->>'kind','TEXT'),
    CASE WHEN message.payload->>'trust'='UNTRUSTED' THEN 'UNTRUSTED' ELSE NULL END,
    message.created_at
  FROM public.messages message
  WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',message.created_at),message.id)<(anchor_created_at,anchor_id))
  ORDER BY date_trunc('milliseconds',message.created_at) DESC,message.id DESC LIMIT requested_limit+1;
END $$;

REVOKE ALL ON FUNCTION get_inbox_conversation(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
REVOKE ALL ON FUNCTION list_inbox_conversation_messages(uuid,integer,timestamptz,uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_inbox_conversation(uuid) TO zap_pronto_api;
GRANT EXECUTE ON FUNCTION list_inbox_conversation_messages(uuid,integer,timestamptz,uuid) TO zap_pronto_api;

COMMIT;
