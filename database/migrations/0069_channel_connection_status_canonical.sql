BEGIN;

-- ACTIVE is the canonical operational state for channel_connections.  The
-- inbound, human-outbound and routing functions have always used ACTIVE;
-- 0029 accidentally introduced CONNECTED in the worker-only claim query.
-- Normalize any rows written by that incompatible contract before enforcing
-- the catalog, without touching credentials or connection ownership.
UPDATE public.channel_connections
SET status='ACTIVE'
WHERE status='CONNECTED';

ALTER TABLE public.channel_connections
  ADD CONSTRAINT channel_connections_status_catalog
  CHECK (status IN ('ACTIVE','DEGRADED','DISCONNECTED'));

CREATE OR REPLACE FUNCTION public.claim_outbound_delivery_events(requested_batch_size integer,requested_lease_seconds integer)
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
    AND connection.status='ACTIVE'
  JOIN public.contact_identities identity ON identity.tenant_id=conversation.tenant_id
    AND identity.id=conversation.contact_identity_id AND identity.channel_connection_id=conversation.channel_connection_id;
END $$;

REVOKE ALL ON FUNCTION public.claim_outbound_delivery_events(integer,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
GRANT EXECUTE ON FUNCTION public.claim_outbound_delivery_events(integer,integer) TO zap_pronto_worker;

COMMIT;
