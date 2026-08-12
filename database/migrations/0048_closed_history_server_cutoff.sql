BEGIN;

CREATE OR REPLACE FUNCTION list_inbox_conversation_messages_v4(requested_conversation_id uuid,requested_limit integer,
  anchor_created_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL,requested_before timestamptz DEFAULT NULL)
RETURNS TABLE(id uuid,direction text,actor text,body text,kind text,trust text,delivery_status text,
  cancel_queued boolean,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE detail record; effective_before timestamptz;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_limit NOT BETWEEN 1 AND 100 OR (anchor_created_at IS NULL)<>(anchor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_INBOX_CONVERSATION_REQUEST' USING ERRCODE='P0001'; END IF;
  SELECT * INTO detail FROM public.get_inbox_conversation(requested_conversation_id);
  IF detail.status='CLOSED' AND detail.closed_at IS NULL THEN
    RAISE EXCEPTION 'INBOX_CONVERSATION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  effective_before:=CASE WHEN detail.status='CLOSED'
    THEN LEAST(COALESCE(requested_before,detail.closed_at),detail.closed_at)
    ELSE requested_before END;
  IF effective_before IS NOT NULL AND anchor_created_at IS NOT NULL AND anchor_created_at>effective_before THEN
    RAISE EXCEPTION 'INVALID_INBOX_CONVERSATION_REQUEST' USING ERRCODE='P0001'; END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages message
    WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
      AND message.id=anchor_id AND date_trunc('milliseconds',message.created_at)=anchor_created_at
      AND (effective_before IS NULL OR message.created_at<=effective_before)) THEN
    RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT message.id,message.direction,message.actor,
    CASE WHEN COALESCE(message.payload->>'kind','TEXT')='TEXT' THEN message.body ELSE NULL END,
    COALESCE(message.payload->>'kind','TEXT'),
    CASE WHEN message.payload->>'trust'='UNTRUSTED' THEN 'UNTRUSTED' ELSE NULL END,
    message.delivery_status,
    (message.direction='OUTBOUND' AND message.actor='HUMAN' AND COALESCE(message.payload->>'kind','TEXT')='TEXT'
      AND message.delivery_status='QUEUED' AND message.external_message_id IS NULL
      AND detail.status='OPEN' AND detail.automation_status='HUMAN_ACTIVE'
      AND detail.assigned_user_id=public.current_app_actor_id()
      AND public.current_actor_has_permission('message.cancel',detail.unit_id)
      AND EXISTS(SELECT 1 FROM public.human_text_message_commands command
        JOIN public.outbox_events event ON event.tenant_id=command.tenant_id AND event.id=command.outbox_id
        WHERE command.tenant_id=message.tenant_id AND command.message_id=message.id
          AND command.actor_id=public.current_app_actor_id() AND event.aggregate_type='message'
          AND event.aggregate_id=message.id AND event.event_type='channel.outbound.requested'
          AND event.payload_version=1 AND event.status='PENDING' AND event.attempts=0
          AND event.lease_token IS NULL AND event.leased_at IS NULL AND event.lease_expires_at IS NULL
          AND event.published_at IS NULL AND event.dead_lettered_at IS NULL AND event.cancelled_at IS NULL)
      AND EXISTS(SELECT 1 FROM public.human_handoffs handoff
        JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
        WHERE handoff.tenant_id=message.tenant_id AND handoff.conversation_id=message.conversation_id
          AND handoff.unit_id=detail.unit_id AND handoff.status='ACTIVE'
          AND handoff.assigned_user_id=public.current_app_actor_id()
          AND service_case.conversation_id=message.conversation_id AND service_case.unit_id=detail.unit_id
          AND service_case.status='IN_REVIEW')
      AND EXISTS(SELECT 1 FROM public.units unit
        JOIN public.channel_connection_units mapping ON mapping.tenant_id=unit.tenant_id AND mapping.unit_id=unit.id
        JOIN public.channel_connections connection ON connection.tenant_id=mapping.tenant_id AND connection.id=mapping.channel_connection_id
        WHERE unit.tenant_id=message.tenant_id AND unit.id=detail.unit_id AND unit.active=true
          AND connection.id=detail.channel_connection_id AND connection.status='ACTIVE')),
    message.created_at
  FROM public.messages message
  WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
    AND (effective_before IS NULL OR message.created_at<=effective_before)
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',message.created_at),message.id)<(anchor_created_at,anchor_id))
  ORDER BY date_trunc('milliseconds',message.created_at) DESC,message.id DESC LIMIT requested_limit+1;
END $$;

REVOKE ALL ON FUNCTION list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)
  TO zap_pronto_api;

REVOKE EXECUTE ON FUNCTION list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)
  FROM zap_pronto_api;

COMMIT;
