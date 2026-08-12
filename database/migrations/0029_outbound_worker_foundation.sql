BEGIN;

ALTER FUNCTION public.send_human_text_message(uuid,integer,text,text)
  RENAME TO send_human_text_message_0028;
REVOKE ALL ON FUNCTION public.send_human_text_message_0028(uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION public.send_human_text_message(requested_conversation_id uuid,requested_expected_version integer,
  requested_body text,requested_idempotency_key text)
RETURNS TABLE(message_id uuid,conversation_version integer,delivery_status text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=pg_catalog.btrim(requested_idempotency_key);
  IF normalized_key IS NULL OR pg_catalog.length(normalized_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    public.current_app_tenant_id()::text||':human-text-send:'||normalized_key,0));
  RETURN QUERY SELECT result.message_id,result.conversation_version,result.delivery_status,result.replayed
    FROM public.send_human_text_message_0028(requested_conversation_id,requested_expected_version,
      requested_body,normalized_key) result;
END $$;

ALTER FUNCTION public.cancel_human_text_message(uuid,uuid,integer,text)
  RENAME TO cancel_human_text_message_0028;
REVOKE ALL ON FUNCTION public.cancel_human_text_message_0028(uuid,uuid,integer,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION public.cancel_human_text_message(requested_conversation_id uuid,requested_message_id uuid,
  requested_expected_version integer,requested_idempotency_key text)
RETURNS TABLE(message_id uuid,conversation_version integer,delivery_status text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text;
BEGIN
  PERFORM public.assert_app_context_authorized();
  normalized_key:=pg_catalog.btrim(requested_idempotency_key);
  IF normalized_key IS NULL OR pg_catalog.length(normalized_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    public.current_app_tenant_id()::text||':human-text-cancel:'||normalized_key,0));
  RETURN QUERY SELECT result.message_id,result.conversation_version,result.delivery_status,result.replayed
    FROM public.cancel_human_text_message_0028(requested_conversation_id,requested_message_id,
      requested_expected_version,normalized_key) result;
END $$;

CREATE FUNCTION public.claim_outbound_delivery_events(requested_batch_size integer,requested_lease_seconds integer)
RETURNS TABLE(tenant_id uuid,outbox_id uuid,message_id uuid,channel_connection_id uuid,
  channel_account_id text,recipient_external_id text,body text,event_type text,payload_version integer,
  lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF requested_batch_size IS NULL OR requested_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_OUTBOUND_WORKER_BATCH_SIZE' USING ERRCODE='22023'; END IF;
  IF requested_lease_seconds IS NULL OR requested_lease_seconds NOT BETWEEN 5 AND 900 THEN
    RAISE EXCEPTION 'INVALID_OUTBOUND_WORKER_LEASE_SECONDS' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT event.tenant_id,event.id
    FROM public.outbox_events event
    JOIN public.messages message ON message.tenant_id=event.tenant_id AND message.id=event.aggregate_id
    WHERE event.aggregate_type='message' AND event.event_type='channel.outbound.requested'
      AND event.payload_version=1 AND message.direction='OUTBOUND' AND message.actor='HUMAN'
      AND message.delivery_status='QUEUED' AND message.external_message_id IS NULL
      AND event.cancelled_at IS NULL AND event.attempts<event.max_attempts
      AND ((event.status='PENDING' AND event.available_at<=pg_catalog.clock_timestamp())
        OR (event.status='PROCESSING' AND event.lease_expires_at<=pg_catalog.clock_timestamp()))
    ORDER BY CASE WHEN event.status='PROCESSING' THEN event.lease_expires_at ELSE event.available_at END,
      event.occurred_at,event.id FOR UPDATE OF event SKIP LOCKED LIMIT requested_batch_size
  ), leased AS (
    UPDATE public.outbox_events event SET status='PROCESSING',attempts=event.attempts+1,
      lease_token=public.gen_random_uuid(),leased_at=pg_catalog.clock_timestamp(),
      lease_expires_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>requested_lease_seconds),
      updated_at=pg_catalog.clock_timestamp()
    FROM candidates WHERE event.tenant_id=candidates.tenant_id AND event.id=candidates.id
    RETURNING event.*
  )
  SELECT leased.tenant_id,leased.id,message.id,conversation.channel_connection_id,
    connection.external_account_id,identity.external_user_id,message.body,leased.event_type,
    leased.payload_version,leased.lease_token
  FROM leased JOIN public.messages message ON message.tenant_id=leased.tenant_id AND message.id=leased.aggregate_id
  JOIN public.conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
  JOIN public.channel_connections connection ON connection.tenant_id=conversation.tenant_id
    AND connection.id=conversation.channel_connection_id AND connection.type='WHATSAPP'
    AND connection.status='CONNECTED'
  JOIN public.contact_identities identity ON identity.tenant_id=conversation.tenant_id
    AND identity.id=conversation.contact_identity_id AND identity.channel_connection_id=conversation.channel_connection_id;
END $$;

CREATE FUNCTION public.finalize_outbound_delivery_event(requested_outbox_id uuid,requested_lease_token uuid,
  requested_external_message_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE event_record record;affected integer;normalized_external_id text;
BEGIN
  normalized_external_id:=pg_catalog.btrim(requested_external_message_id);
  IF requested_outbox_id IS NULL OR requested_lease_token IS NULL OR normalized_external_id IS NULL
    OR pg_catalog.length(normalized_external_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_OUTBOUND_FINALIZE_REQUEST' USING ERRCODE='22023'; END IF;
  SELECT event.tenant_id,event.aggregate_id INTO event_record FROM public.outbox_events event
  WHERE event.id=requested_outbox_id AND event.aggregate_type='message'
    AND event.event_type='channel.outbound.requested' AND event.payload_version=1
    AND event.status='PROCESSING' AND event.lease_token=requested_lease_token
    AND event.lease_expires_at>pg_catalog.clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.messages message SET external_message_id=normalized_external_id,delivery_status='SENT'
  WHERE message.tenant_id=event_record.tenant_id AND message.id=event_record.aggregate_id
    AND message.direction='OUTBOUND' AND message.actor='HUMAN'
    AND message.delivery_status='QUEUED' AND message.external_message_id IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'OUTBOUND_FINALIZE_MESSAGE_REJECTED' USING ERRCODE='P0001'; END IF;
  UPDATE public.outbox_events SET status='PUBLISHED',published_at=pg_catalog.clock_timestamp(),
    lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=pg_catalog.clock_timestamp()
  WHERE tenant_id=event_record.tenant_id AND id=requested_outbox_id AND status='PROCESSING'
    AND lease_token=requested_lease_token AND lease_expires_at>pg_catalog.clock_timestamp();
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'OUTBOUND_FINALIZE_LEASE_LOST' USING ERRCODE='P0001'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.fail_outbound_delivery_event(requested_outbox_id uuid,requested_lease_token uuid,
  requested_error_code text,requested_backoff_seconds integer DEFAULT 30)
RETURNS outbox_status LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE event_record record;next_status public.outbox_status;
BEGIN
  IF requested_error_code IS NULL OR requested_error_code!~'^OUTBOUND_[A-Z0-9_]{1,80}$' THEN
    RAISE EXCEPTION 'INVALID_OUTBOUND_WORKER_ERROR_CODE' USING ERRCODE='22023'; END IF;
  IF requested_backoff_seconds IS NULL OR requested_backoff_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_OUTBOUND_WORKER_BACKOFF' USING ERRCODE='22023'; END IF;
  UPDATE public.outbox_events event SET
    status=CASE WHEN attempts>=max_attempts THEN 'DEAD'::public.outbox_status ELSE 'PENDING'::public.outbox_status END,
    available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE pg_catalog.clock_timestamp()+
      pg_catalog.make_interval(secs=>LEAST(3600::double precision,requested_backoff_seconds*
        pg_catalog.power(2::double precision,attempts-1))) END,
    lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,last_error=requested_error_code,
    dead_lettered_at=CASE WHEN attempts>=max_attempts THEN pg_catalog.clock_timestamp() ELSE NULL END,
    updated_at=pg_catalog.clock_timestamp()
  WHERE event.id=requested_outbox_id AND event.aggregate_type='message'
    AND event.event_type='channel.outbound.requested' AND event.payload_version=1
    AND event.status='PROCESSING' AND event.lease_token=requested_lease_token
    AND event.lease_expires_at>pg_catalog.clock_timestamp()
  RETURNING event.tenant_id,event.aggregate_id,event.status INTO event_record;
  IF NOT FOUND THEN RETURN NULL; END IF;
  next_status:=event_record.status;
  IF next_status='DEAD' THEN
    UPDATE public.messages SET delivery_status='FAILED'
    WHERE tenant_id=event_record.tenant_id AND id=event_record.aggregate_id
      AND delivery_status='QUEUED' AND external_message_id IS NULL;
    INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(event_record.tenant_id,'SYSTEM',NULL,'OUTBOUND_DELIVERY_DEAD_LETTERED','message',
      event_record.aggregate_id::text,pg_catalog.jsonb_build_object('errorCode',requested_error_code));
  END IF;
  RETURN next_status;
END $$;

REVOKE ALL ON FUNCTION public.send_human_text_message(uuid,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION public.send_human_text_message(uuid,integer,text,text) TO zap_pronto_api;
REVOKE ALL ON FUNCTION public.cancel_human_text_message(uuid,uuid,integer,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION public.cancel_human_text_message(uuid,uuid,integer,text) TO zap_pronto_api;
REVOKE ALL ON FUNCTION public.claim_outbound_delivery_events(integer,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
REVOKE ALL ON FUNCTION public.finalize_outbound_delivery_event(uuid,uuid,text) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
REVOKE ALL ON FUNCTION public.fail_outbound_delivery_event(uuid,uuid,text,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
GRANT EXECUTE ON FUNCTION public.claim_outbound_delivery_events(integer,integer) TO zap_pronto_worker;
GRANT EXECUTE ON FUNCTION public.finalize_outbound_delivery_event(uuid,uuid,text) TO zap_pronto_worker;
GRANT EXECUTE ON FUNCTION public.fail_outbound_delivery_event(uuid,uuid,text,integer) TO zap_pronto_worker;

COMMIT;
