BEGIN;

INSERT INTO app_permissions(code) VALUES('handoff.history.read') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'handoff.history.read' FROM app_roles role
WHERE role.code IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR')
ON CONFLICT DO NOTHING;

CREATE INDEX handoffs_inbox_resolved_history_idx
  ON human_handoffs(tenant_id,unit_id,resolved_at DESC,id DESC)
  WHERE status='RESOLVED';

CREATE FUNCTION list_inbox_resolved_handoffs(requested_unit_id uuid,requested_limit integer,
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
  LEFT JOIN public.users actor ON actor.tenant_id=command.tenant_id AND actor.id=command.actor_id
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
    AND handoff.status='RESOLVED' AND handoff.resolved_at IS NOT NULL
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',handoff.resolved_at),handoff.id)<(anchor_resolved_at,anchor_id))
  ORDER BY date_trunc('milliseconds',handoff.resolved_at) DESC,handoff.id DESC
  LIMIT requested_limit;
END $$;

REVOKE ALL ON FUNCTION list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_resolved_handoffs(uuid,integer,timestamptz,uuid) TO zap_pronto_api;

CREATE FUNCTION list_inbox_conversation_messages_v4(requested_conversation_id uuid,requested_limit integer,
  anchor_created_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL,requested_before timestamptz DEFAULT NULL)
RETURNS TABLE(id uuid,direction text,actor text,body text,kind text,trust text,delivery_status text,
  cancel_queued boolean,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE detail record;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_limit NOT BETWEEN 1 AND 100 OR (anchor_created_at IS NULL)<>(anchor_id IS NULL)
    OR (requested_before IS NOT NULL AND anchor_created_at IS NOT NULL AND anchor_created_at>requested_before) THEN
    RAISE EXCEPTION 'INVALID_INBOX_CONVERSATION_REQUEST' USING ERRCODE='P0001'; END IF;
  SELECT * INTO detail FROM public.get_inbox_conversation(requested_conversation_id);
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages message
    WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
      AND message.id=anchor_id AND date_trunc('milliseconds',message.created_at)=anchor_created_at
      AND (requested_before IS NULL OR message.created_at<=requested_before)) THEN
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
    AND (requested_before IS NULL OR message.created_at<=requested_before)
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',message.created_at),message.id)<(anchor_created_at,anchor_id))
  ORDER BY date_trunc('milliseconds',message.created_at) DESC,message.id DESC LIMIT requested_limit+1;
END $$;
REVOKE ALL ON FUNCTION list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_conversation_messages_v4(uuid,integer,timestamptz,uuid,timestamptz) TO zap_pronto_api;

COMMIT;
