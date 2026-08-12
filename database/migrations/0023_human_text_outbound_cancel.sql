BEGIN;

INSERT INTO app_permissions(code) VALUES('message.cancel') ON CONFLICT DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code) VALUES
  ('TENANT_ADMIN','message.cancel'),('UNIT_MANAGER','message.cancel'),
  ('SUPERVISOR','message.cancel'),('ATTENDANT','message.cancel')
ON CONFLICT DO NOTHING;

CREATE TABLE human_text_message_cancel_commands(
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  expected_conversation_version integer NOT NULL CHECK(expected_conversation_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[a-f0-9]{64}$'),
  result_conversation_version integer NOT NULL CHECK(result_conversation_version>0),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,idempotency_key),
  UNIQUE(tenant_id,message_id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id),
  FOREIGN KEY(tenant_id,outbox_id) REFERENCES outbox_events(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE human_text_message_cancel_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_text_message_cancel_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY human_text_message_cancel_commands_tenant ON human_text_message_cancel_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON human_text_message_cancel_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbox_conversation_messages_v3(requested_conversation_id uuid,requested_limit integer,
  anchor_created_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,direction text,actor text,body text,kind text,trust text,delivery_status text,
  cancel_queued boolean,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE detail record;
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 100 OR (anchor_created_at IS NULL)<>(anchor_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_INBOX_CONVERSATION_REQUEST' USING ERRCODE='P0001'; END IF;
  SELECT * INTO detail FROM public.get_inbox_conversation(requested_conversation_id);
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages message
    WHERE message.tenant_id=public.current_app_tenant_id() AND message.conversation_id=requested_conversation_id
      AND message.id=anchor_id AND date_trunc('milliseconds',message.created_at)=anchor_created_at) THEN
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
          AND command.actor_id=public.current_app_actor_id()
          AND event.aggregate_type='message' AND event.aggregate_id=message.id
          AND event.event_type='channel.outbound.requested' AND event.payload_version=1
          AND event.status='PENDING' AND event.attempts=0 AND event.lease_token IS NULL
          AND event.leased_at IS NULL AND event.lease_expires_at IS NULL
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
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',message.created_at),message.id)<(anchor_created_at,anchor_id))
  ORDER BY date_trunc('milliseconds',message.created_at) DESC,message.id DESC LIMIT requested_limit+1;
END $$;

CREATE FUNCTION cancel_human_text_message(requested_conversation_id uuid,requested_message_id uuid,
  requested_expected_version integer,requested_idempotency_key text)
RETURNS TABLE(message_id uuid,conversation_version integer,delivery_status text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;fingerprint text;existing public.human_text_message_cancel_commands%ROWTYPE;
  c public.conversations%ROWTYPE;message public.messages%ROWTYPE;event public.outbox_events%ROWTYPE;
  original public.human_text_message_commands%ROWTYPE;handoff public.human_handoffs%ROWTYPE;
  service_case public.service_cases%ROWTYPE;next_version integer;
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=pg_catalog.btrim(requested_idempotency_key);
  IF normalized_key IS NULL OR pg_catalog.length(normalized_key)<8 OR pg_catalog.length(normalized_key)>200 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='P0001'; END IF;
  IF requested_expected_version IS NULL OR requested_expected_version<1 THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_VERSION' USING ERRCODE='P0001'; END IF;
  fingerprint:=pg_catalog.encode(public.digest(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'conversationId',requested_conversation_id,'messageId',requested_message_id,
    'expectedVersion',requested_expected_version)::text,'UTF8'),'sha256'),'hex');
  SELECT command.* INTO existing FROM public.human_text_message_cancel_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF existing.conversation_id IS DISTINCT FROM requested_conversation_id OR existing.message_id IS DISTINCT FROM requested_message_id
      OR existing.expected_conversation_version IS DISTINCT FROM requested_expected_version
      OR existing.actor_id IS DISTINCT FROM public.current_app_actor_id()
      OR existing.request_fingerprint IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'MESSAGE_CANCEL_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    IF NOT public.current_actor_has_permission('message.cancel',(SELECT conversation.unit_id FROM public.conversations conversation
      WHERE conversation.tenant_id=existing.tenant_id AND conversation.id=existing.conversation_id)) THEN
      RAISE EXCEPTION 'MESSAGE_CANCEL_FORBIDDEN' USING ERRCODE='P0001'; END IF;
    message_id:=existing.message_id;conversation_version:=existing.result_conversation_version;
    delivery_status:='CANCELLED';replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT conversation.* INTO c FROM public.conversations conversation
  WHERE conversation.tenant_id=public.current_app_tenant_id() AND conversation.id=requested_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF NOT public.current_actor_has_permission('message.cancel',c.unit_id) THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_FORBIDDEN' USING ERRCODE='P0001'; END IF;
  SELECT command.* INTO existing FROM public.human_text_message_cancel_commands command
  WHERE command.tenant_id=c.tenant_id AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF existing.conversation_id IS DISTINCT FROM requested_conversation_id OR existing.message_id IS DISTINCT FROM requested_message_id
      OR existing.expected_conversation_version IS DISTINCT FROM requested_expected_version
      OR existing.actor_id IS DISTINCT FROM public.current_app_actor_id()
      OR existing.request_fingerprint IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'MESSAGE_CANCEL_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    message_id:=existing.message_id;conversation_version:=existing.result_conversation_version;
    delivery_status:='CANCELLED';replayed:=true;RETURN NEXT;RETURN;
  END IF;
  IF c.status<>'OPEN' OR c.automation_status<>'HUMAN_ACTIVE' OR c.assigned_user_id IS DISTINCT FROM public.current_app_actor_id()
    OR c.version<>requested_expected_version THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_STATE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT target.* INTO message FROM public.messages target WHERE target.tenant_id=c.tenant_id
    AND target.id=requested_message_id AND target.conversation_id=c.id FOR UPDATE;
  IF NOT FOUND OR message.direction<>'OUTBOUND' OR message.actor<>'HUMAN'
    OR COALESCE(message.payload->>'kind','TEXT')<>'TEXT' OR message.delivery_status<>'QUEUED'
    OR message.external_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_STATE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT command.* INTO original FROM public.human_text_message_commands command
  WHERE command.tenant_id=c.tenant_id AND command.message_id=message.id;
  IF NOT FOUND OR original.actor_id IS DISTINCT FROM public.current_app_actor_id() THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_STATE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT target.* INTO event FROM public.outbox_events target WHERE target.tenant_id=c.tenant_id AND target.id=original.outbox_id
    AND target.aggregate_type='message' AND target.aggregate_id=message.id
    AND target.event_type='channel.outbound.requested' AND target.payload_version=1 FOR UPDATE;
  IF NOT FOUND OR event.status<>'PENDING' OR event.attempts<>0 OR event.lease_token IS NOT NULL
    OR event.leased_at IS NOT NULL OR event.lease_expires_at IS NOT NULL OR event.published_at IS NOT NULL
    OR event.dead_lettered_at IS NOT NULL OR event.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_ALREADY_CLAIMED' USING ERRCODE='P0001'; END IF;
  SELECT h.* INTO handoff FROM public.human_handoffs h WHERE h.tenant_id=c.tenant_id AND h.conversation_id=c.id
    AND h.unit_id=c.unit_id AND h.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND OR handoff.assigned_user_id IS DISTINCT FROM public.current_app_actor_id() THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_STATE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT sc.* INTO service_case FROM public.service_cases sc WHERE sc.tenant_id=c.tenant_id AND sc.id=handoff.service_case_id FOR UPDATE;
  IF NOT FOUND OR service_case.conversation_id<>c.id OR service_case.unit_id IS DISTINCT FROM c.unit_id
    OR service_case.status<>'IN_REVIEW' THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_STATE_CONFLICT' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit JOIN public.channel_connection_units mapping
      ON mapping.tenant_id=unit.tenant_id AND mapping.unit_id=unit.id
    JOIN public.channel_connections connection ON connection.tenant_id=mapping.tenant_id AND connection.id=mapping.channel_connection_id
    WHERE unit.tenant_id=c.tenant_id AND unit.id=c.unit_id AND unit.active=true
      AND connection.id=c.channel_connection_id AND connection.status='ACTIVE') THEN
    RAISE EXCEPTION 'MESSAGE_CANCEL_TARGET_INACTIVE' USING ERRCODE='P0001'; END IF;
  UPDATE public.messages SET delivery_status='CANCELLED' WHERE tenant_id=c.tenant_id AND id=message.id;
  UPDATE public.outbox_events SET status='CANCELLED',cancelled_at=clock_timestamp(),available_at=clock_timestamp(),
    lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=c.tenant_id AND id=event.id;
  UPDATE public.conversations SET version=version+1,updated_at=clock_timestamp()
    WHERE tenant_id=c.tenant_id AND id=c.id RETURNING version INTO next_version;
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(c.tenant_id,'USER',public.current_app_actor_id()::text,'HUMAN_TEXT_MESSAGE_CANCELLED','message',message.id::text,
    pg_catalog.jsonb_build_object('conversationId',c.id,'unitId',c.unit_id,'channelConnectionId',c.channel_connection_id,'kind','TEXT'));
  INSERT INTO public.human_text_message_cancel_commands(tenant_id,idempotency_key,conversation_id,message_id,outbox_id,actor_id,
    expected_conversation_version,request_fingerprint,result_conversation_version,correlation_id)
  VALUES(c.tenant_id,normalized_key,c.id,message.id,event.id,public.current_app_actor_id(),requested_expected_version,
    fingerprint,next_version,current_setting('app.correlation_id'));
  message_id:=message.id;conversation_version:=next_version;delivery_status:='CANCELLED';replayed:=false;RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION list_inbox_conversation_messages_v3(uuid,integer,timestamptz,uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
REVOKE ALL ON FUNCTION cancel_human_text_message(uuid,uuid,integer,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_conversation_messages_v3(uuid,integer,timestamptz,uuid) TO zap_pronto_api;
GRANT EXECUTE ON FUNCTION cancel_human_text_message(uuid,uuid,integer,text) TO zap_pronto_api;

COMMIT;
