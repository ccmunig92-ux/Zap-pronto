BEGIN;

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_type_external_account_global_unique
  UNIQUE (type,external_account_id);

CREATE FUNCTION resolve_inbound_channel_binding(requested_provider text,requested_channel_account_id text)
RETURNS TABLE (
  tenant_id uuid,
  channel_connection_id uuid,
  unit_id uuid,
  routing_status text,
  routing_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  requested_type public.channel_type;
  connection_record record;
  active_unit_ids uuid[];
BEGIN
  IF requested_provider IS NULL OR requested_provider NOT IN
    ('META_WHATSAPP','META_INSTAGRAM','META_FACEBOOK') THEN
    RAISE EXCEPTION 'INVALID_INBOUND_PROVIDER' USING ERRCODE='22023';
  END IF;
  IF requested_channel_account_id IS NULL
    OR requested_channel_account_id<>pg_catalog.btrim(requested_channel_account_id)
    OR pg_catalog.length(requested_channel_account_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_ACCOUNT_ID' USING ERRCODE='22023';
  END IF;

  requested_type := CASE requested_provider
    WHEN 'META_WHATSAPP' THEN 'WHATSAPP'::public.channel_type
    WHEN 'META_INSTAGRAM' THEN 'INSTAGRAM'::public.channel_type
    WHEN 'META_FACEBOOK' THEN 'FACEBOOK_MESSENGER'::public.channel_type
  END;

  SELECT connection.id,connection.tenant_id
    INTO connection_record
  FROM public.channel_connections connection
  WHERE connection.type=requested_type
    AND connection.external_account_id=requested_channel_account_id
    AND connection.status='ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT pg_catalog.array_agg(mapping.unit_id ORDER BY mapping.unit_id)
    INTO active_unit_ids
  FROM public.channel_connection_units mapping
  JOIN public.units unit ON unit.tenant_id=mapping.tenant_id
    AND unit.id=mapping.unit_id AND unit.active=true
  WHERE mapping.tenant_id=connection_record.tenant_id
    AND mapping.channel_connection_id=connection_record.id;
  IF coalesce(pg_catalog.array_length(active_unit_ids,1),0)=0 THEN RETURN; END IF;

  tenant_id := connection_record.tenant_id;
  channel_connection_id := connection_record.id;
  IF pg_catalog.array_length(active_unit_ids,1)=1 THEN
    unit_id := active_unit_ids[1];
    routing_status := 'ROUTED';
    routing_reason := NULL;
  ELSE
    unit_id := NULL;
    routing_status := 'UNROUTED';
    routing_reason := 'MULTIPLE_ACTIVE_UNITS';
  END IF;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION resolve_inbound_channel_binding(text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbound_channel_binding(text,text) TO zap_pronto_api;

CREATE TABLE inbound_channel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  unit_id uuid,
  channel_connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('META_WHATSAPP','META_INSTAGRAM','META_FACEBOOK')),
  provider_event_id text NOT NULL CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 512),
  channel_account_id text NOT NULL CHECK (length(btrim(channel_account_id)) BETWEEN 1 AND 512),
  sender_external_id text NOT NULL CHECK (length(btrim(sender_external_id)) BETWEEN 1 AND 512),
  recipient_external_id text NOT NULL CHECK (length(btrim(recipient_external_id)) BETWEEN 1 AND 512),
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('TEXT','AUDIO','IMAGE','DOCUMENT','INTERACTIVE')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  routing_status text NOT NULL CHECK (routing_status IN ('ROUTED','UNROUTED')),
  routing_reason text CHECK (routing_reason IN ('MULTIPLE_ACTIVE_UNITS')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  CONSTRAINT inbound_channel_events_tenant_idempotency_unique UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,channel_connection_id)
    REFERENCES channel_connections(tenant_id,id),
  FOREIGN KEY (tenant_id,channel_connection_id,unit_id)
    REFERENCES channel_connection_units(tenant_id,channel_connection_id,unit_id),
  CHECK ((routing_status='ROUTED' AND unit_id IS NOT NULL AND routing_reason IS NULL)
    OR (routing_status='UNROUTED' AND unit_id IS NULL AND routing_reason IS NOT NULL))
);

CREATE INDEX inbound_channel_events_timeline_idx
  ON inbound_channel_events(tenant_id,unit_id,occurred_at,id);

ALTER TABLE inbound_channel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_channel_events FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_channel_events_insert_tenant ON inbound_channel_events
  FOR INSERT TO zap_pronto_api
  WITH CHECK (tenant_id=current_app_tenant_id());
CREATE POLICY inbound_channel_events_select_unit ON inbound_channel_events
  FOR SELECT TO zap_pronto_api
  USING (tenant_id=current_app_tenant_id() AND unit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM user_units membership
    WHERE membership.tenant_id=inbound_channel_events.tenant_id
      AND membership.user_id=current_app_actor_id()
      AND (membership.unit_id=inbound_channel_events.unit_id OR membership.role='TENANT_ADMIN')
  ));

REVOKE ALL ON inbound_channel_events FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
GRANT SELECT ON inbound_channel_events TO zap_pronto_api;

ALTER TABLE messages
  ADD COLUMN source_inbound_event_id uuid,
  ADD CONSTRAINT messages_source_inbound_event_unique UNIQUE (tenant_id,source_inbound_event_id),
  ADD CONSTRAINT messages_source_inbound_event_fk FOREIGN KEY (tenant_id,source_inbound_event_id)
    REFERENCES inbound_channel_events(tenant_id,id),
  ADD CONSTRAINT messages_source_inbound_direction_check CHECK
    (source_inbound_event_id IS NULL OR (direction='INBOUND' AND actor='CUSTOMER'));

WITH ranked_open_conversations AS (
  SELECT id,tenant_id,pg_catalog.row_number() OVER (
    PARTITION BY tenant_id,contact_identity_id,unit_id ORDER BY updated_at DESC,id DESC) AS duplicate_rank
  FROM conversations WHERE status='OPEN'
)
UPDATE conversations conversation SET status='CLOSED',closed_at=pg_catalog.clock_timestamp(),
  state_changed_at=pg_catalog.clock_timestamp()
FROM ranked_open_conversations ranked
WHERE conversation.tenant_id=ranked.tenant_id AND conversation.id=ranked.id AND ranked.duplicate_rank>1;

CREATE UNIQUE INDEX conversations_one_open_per_identity_unit
  ON conversations(tenant_id,contact_identity_id,unit_id) WHERE status='OPEN';

CREATE FUNCTION persist_inbound_channel_event(
  requested_provider text,requested_provider_event_id text,requested_channel_account_id text,
  requested_sender_external_id text,requested_recipient_external_id text,requested_occurred_at timestamptz,
  requested_kind text,requested_payload jsonb,requested_idempotency_key text,
  requested_fingerprint text,expected_channel_connection_id uuid,expected_unit_id uuid,
  expected_routing_status text,expected_routing_reason text
) RETURNS TABLE (
  id uuid,tenant_id uuid,unit_id uuid,channel_connection_id uuid,
  routing_status text,routing_reason text,replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  binding record;
  inserted_id uuid;
  existing record;
BEGIN
  SELECT * INTO binding
  FROM public.resolve_inbound_channel_binding(requested_provider,requested_channel_account_id);
  IF NOT FOUND OR binding.tenant_id<>public.current_app_tenant_id()
    OR binding.channel_connection_id<>expected_channel_connection_id
    OR binding.unit_id IS DISTINCT FROM expected_unit_id
    OR binding.routing_status<>expected_routing_status
    OR binding.routing_reason IS DISTINCT FROM expected_routing_reason THEN
    RAISE EXCEPTION 'CHANNEL_ACCOUNT_BINDING_CHANGED' USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.inbound_channel_events
    (tenant_id,unit_id,channel_connection_id,provider,provider_event_id,channel_account_id,
     sender_external_id,recipient_external_id,occurred_at,kind,payload,idempotency_key,
     request_fingerprint,routing_status,routing_reason)
  VALUES (binding.tenant_id,binding.unit_id,binding.channel_connection_id,requested_provider,
    requested_provider_event_id,requested_channel_account_id,requested_sender_external_id,
    requested_recipient_external_id,requested_occurred_at,requested_kind,requested_payload,
    requested_idempotency_key,requested_fingerprint,expected_routing_status,expected_routing_reason)
  ON CONFLICT ON CONSTRAINT inbound_channel_events_tenant_idempotency_unique DO NOTHING
  RETURNING inbound_channel_events.id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    INSERT INTO public.outbox_events
      (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,payload_version)
    VALUES (binding.tenant_id,'inbound_channel_event',inserted_id,
      CASE WHEN binding.routing_status='ROUTED' THEN 'channel.inbound.received'
        ELSE 'channel.inbound.routing_required' END,
      pg_catalog.jsonb_build_object(
        'receiptId',inserted_id,
        'provider',requested_provider,
        'kind',requested_kind,
        'channelConnectionId',binding.channel_connection_id,
        'unitId',binding.unit_id,
        'routingStatus',binding.routing_status
      ),CASE WHEN binding.routing_status='ROUTED' THEN 'channel.inbound.received:'
        ELSE 'channel.inbound.routing_required:' END||inserted_id::text,1);
    id:=inserted_id; tenant_id:=binding.tenant_id; unit_id:=binding.unit_id;
    channel_connection_id:=binding.channel_connection_id; routing_status:=binding.routing_status;
    routing_reason:=binding.routing_reason; replayed:=false; RETURN NEXT; RETURN;
  END IF;

  SELECT event.id,event.unit_id,event.channel_connection_id,event.request_fingerprint,
    event.routing_status,event.routing_reason INTO existing
  FROM public.inbound_channel_events event
  WHERE event.tenant_id=binding.tenant_id AND event.idempotency_key=requested_idempotency_key;
  IF NOT FOUND OR existing.request_fingerprint<>requested_fingerprint
    OR existing.channel_connection_id<>binding.channel_connection_id
    OR existing.unit_id IS DISTINCT FROM binding.unit_id
    OR existing.routing_status<>binding.routing_status
    OR existing.routing_reason IS DISTINCT FROM binding.routing_reason THEN
    RAISE EXCEPTION 'INBOUND_IDEMPOTENCY_COLLISION' USING ERRCODE='P0001';
  END IF;
  id:=existing.id; tenant_id:=binding.tenant_id; unit_id:=existing.unit_id;
  channel_connection_id:=existing.channel_connection_id; routing_status:=existing.routing_status;
  routing_reason:=existing.routing_reason; replayed:=true; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION persist_inbound_channel_event(text,text,text,text,text,timestamptz,text,jsonb,text,text,uuid,uuid,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION persist_inbound_channel_event(text,text,text,text,text,timestamptz,text,jsonb,text,text,uuid,uuid,text,text)
  TO zap_pronto_api;

CREATE FUNCTION materialize_inbound_channel_event(requested_outbox_id uuid,requested_lease_token uuid)
RETURNS TABLE (contact_id uuid,contact_identity_id uuid,conversation_id uuid,message_id uuid,replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  outbox_record record;
  receipt record;
  resolved_contact_id uuid;
  resolved_identity_id uuid;
  resolved_conversation_id uuid;
  resolved_message_id uuid;
  existing_message_conversation_id uuid;
  message_body text;
  message_payload jsonb;
  acknowledged_count integer;
BEGIN
  IF requested_outbox_id IS NULL OR requested_lease_token IS NULL THEN
    RAISE EXCEPTION 'INVALID_INBOUND_MATERIALIZATION_REQUEST' USING ERRCODE='22023';
  END IF;
  SELECT event.id,event.tenant_id,event.aggregate_type,event.aggregate_id,event.event_type,event.payload,
    event.payload_version,event.status,event.lease_token,event.lease_expires_at
    INTO outbox_record
  FROM public.outbox_events event
  WHERE event.tenant_id=public.current_app_tenant_id() AND event.id=requested_outbox_id
  FOR UPDATE;
  IF NOT FOUND OR outbox_record.status<>'PROCESSING' OR outbox_record.lease_token<>requested_lease_token
    OR outbox_record.lease_expires_at IS NULL OR outbox_record.lease_expires_at<=pg_catalog.clock_timestamp()
    OR outbox_record.aggregate_type<>'inbound_channel_event'
    OR outbox_record.event_type<>'channel.inbound.received' OR outbox_record.payload_version<>1
    OR (outbox_record.payload->>'receiptId') IS DISTINCT FROM outbox_record.aggregate_id::text
    OR (outbox_record.payload->>'routingStatus') IS DISTINCT FROM 'ROUTED' THEN
    RAISE EXCEPTION 'INBOUND_MATERIALIZATION_LEASE_REJECTED' USING ERRCODE='P0001';
  END IF;

  SELECT event.* INTO receipt
  FROM public.inbound_channel_events event
  WHERE event.tenant_id=outbox_record.tenant_id AND event.id=outbox_record.aggregate_id
  FOR UPDATE;
  IF NOT FOUND OR receipt.routing_status<>'ROUTED' OR receipt.unit_id IS NULL THEN
    RAISE EXCEPTION 'INBOUND_MATERIALIZATION_RECEIPT_REJECTED' USING ERRCODE='P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    receipt.tenant_id::text||pg_catalog.chr(31)||receipt.channel_connection_id::text||
      pg_catalog.chr(31)||receipt.sender_external_id,0));

  SELECT identity.id,identity.contact_id INTO resolved_identity_id,resolved_contact_id
  FROM public.contact_identities identity
  WHERE identity.tenant_id=receipt.tenant_id
    AND identity.channel_connection_id=receipt.channel_connection_id
    AND identity.external_user_id=receipt.sender_external_id;
  IF NOT FOUND THEN
    INSERT INTO public.contacts(tenant_id) VALUES(receipt.tenant_id) RETURNING id INTO resolved_contact_id;
    INSERT INTO public.contact_identities(tenant_id,contact_id,channel_connection_id,external_user_id)
    VALUES(receipt.tenant_id,resolved_contact_id,receipt.channel_connection_id,receipt.sender_external_id)
    RETURNING id INTO resolved_identity_id;
  END IF;

  SELECT conversation.id INTO resolved_conversation_id
  FROM public.conversations conversation
  WHERE conversation.tenant_id=receipt.tenant_id AND conversation.contact_identity_id=resolved_identity_id
    AND conversation.unit_id=receipt.unit_id AND conversation.status='OPEN'
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.conversations
      (tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,automation_status)
    VALUES(receipt.tenant_id,receipt.channel_connection_id,resolved_contact_id,resolved_identity_id,
      receipt.unit_id,'ACTIVE') RETURNING id INTO resolved_conversation_id;
  END IF;

  SELECT message.id,message.conversation_id INTO resolved_message_id,existing_message_conversation_id
  FROM public.messages message
  WHERE message.tenant_id=receipt.tenant_id AND message.source_inbound_event_id=receipt.id;
  IF FOUND THEN
    resolved_conversation_id:=existing_message_conversation_id;
    replayed:=true;
  ELSE
    IF receipt.kind='TEXT' THEN
      message_body:=receipt.payload->>'text';
      IF message_body IS NULL OR pg_catalog.length(message_body) NOT BETWEEN 1 AND 32000 THEN
        RAISE EXCEPTION 'INBOUND_MATERIALIZATION_CONTENT_REJECTED' USING ERRCODE='P0001';
      END IF;
      message_payload:=pg_catalog.jsonb_build_object('kind','TEXT','trust','UNTRUSTED');
    ELSE
      IF receipt.kind NOT IN ('AUDIO','IMAGE','DOCUMENT','INTERACTIVE')
        OR receipt.payload->>'trust'<>'UNTRUSTED' THEN
        RAISE EXCEPTION 'INBOUND_MATERIALIZATION_CONTENT_REJECTED' USING ERRCODE='P0001';
      END IF;
      message_body:=NULL;
      message_payload:=receipt.payload||pg_catalog.jsonb_build_object('kind',receipt.kind,'trust','UNTRUSTED');
    END IF;
    INSERT INTO public.messages
      (tenant_id,conversation_id,direction,actor,external_message_id,body,payload,created_at,source_inbound_event_id)
    VALUES(receipt.tenant_id,resolved_conversation_id,'INBOUND','CUSTOMER',receipt.provider_event_id,
      message_body,message_payload,receipt.occurred_at,receipt.id)
    RETURNING id INTO resolved_message_id;
    INSERT INTO public.outbox_events
      (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,payload_version)
    VALUES(receipt.tenant_id,'message',resolved_message_id,'channel.inbound.materialized',
      pg_catalog.jsonb_build_object('messageId',resolved_message_id,'conversationId',resolved_conversation_id,
        'receiptId',receipt.id,'channelConnectionId',receipt.channel_connection_id,'unitId',receipt.unit_id),
      'channel.inbound.materialized:'||receipt.id::text,1);
    replayed:=false;
  END IF;

  UPDATE public.outbox_events event SET status='PUBLISHED',published_at=pg_catalog.clock_timestamp(),
    lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=pg_catalog.clock_timestamp()
  WHERE event.tenant_id=receipt.tenant_id AND event.id=requested_outbox_id AND event.status='PROCESSING'
    AND event.lease_token=requested_lease_token AND event.lease_expires_at>pg_catalog.clock_timestamp();
  GET DIAGNOSTICS acknowledged_count=ROW_COUNT;
  IF acknowledged_count<>1 THEN
    RAISE EXCEPTION 'INBOUND_MATERIALIZATION_ACK_FAILED' USING ERRCODE='P0001';
  END IF;

  contact_id:=resolved_contact_id;contact_identity_id:=resolved_identity_id;
  conversation_id:=resolved_conversation_id;message_id:=resolved_message_id;RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION materialize_inbound_channel_event(uuid,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api;
GRANT EXECUTE ON FUNCTION materialize_inbound_channel_event(uuid,uuid) TO zap_pronto_worker;

CREATE FUNCTION claim_inbound_materialization_events(requested_batch_size integer,requested_lease_seconds integer)
RETURNS TABLE(tenant_id uuid,outbox_id uuid,aggregate_id uuid,event_type text,payload_version integer,
  lease_token uuid,lease_expires_at timestamptz,attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
BEGIN
  IF requested_batch_size IS NULL OR requested_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_INBOUND_WORKER_BATCH_SIZE' USING ERRCODE='22023';
  END IF;
  IF requested_lease_seconds IS NULL OR requested_lease_seconds NOT BETWEEN 5 AND 900 THEN
    RAISE EXCEPTION 'INVALID_INBOUND_WORKER_LEASE_SECONDS' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT event.tenant_id,event.id
    FROM public.outbox_events event
    WHERE event.aggregate_type='inbound_channel_event'
      AND event.event_type='channel.inbound.received' AND event.payload_version=1
      AND event.attempts<event.max_attempts
      AND ((event.status='PENDING' AND event.available_at<=pg_catalog.clock_timestamp())
        OR (event.status='PROCESSING' AND event.lease_expires_at<=pg_catalog.clock_timestamp()))
    ORDER BY CASE WHEN event.status='PROCESSING' THEN event.lease_expires_at ELSE event.available_at END,
      event.occurred_at,event.id
    FOR UPDATE SKIP LOCKED LIMIT requested_batch_size
  )
  UPDATE public.outbox_events event SET status='PROCESSING',attempts=event.attempts+1,
    lease_token=public.gen_random_uuid(),leased_at=pg_catalog.clock_timestamp(),
    lease_expires_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>requested_lease_seconds),
    updated_at=pg_catalog.clock_timestamp()
  FROM candidates WHERE event.tenant_id=candidates.tenant_id AND event.id=candidates.id
  RETURNING event.tenant_id,event.id,event.aggregate_id,event.event_type,event.payload_version,
    event.lease_token,event.lease_expires_at,event.attempts;
END $$;

CREATE FUNCTION fail_inbound_materialization_event(requested_outbox_id uuid,requested_lease_token uuid,
  requested_error_code text,requested_backoff_seconds integer DEFAULT 30)
RETURNS outbox_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE next_status outbox_status;
BEGIN
  IF requested_error_code IS NULL OR requested_error_code !~ '^INBOUND_[A-Z0-9_]{1,80}$' THEN
    RAISE EXCEPTION 'INVALID_INBOUND_WORKER_ERROR_CODE' USING ERRCODE='22023';
  END IF;
  IF requested_backoff_seconds IS NULL OR requested_backoff_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_INBOUND_WORKER_BACKOFF' USING ERRCODE='22023';
  END IF;
  UPDATE public.outbox_events event
  SET status=CASE WHEN attempts>=max_attempts THEN 'DEAD'::public.outbox_status ELSE 'PENDING'::public.outbox_status END,
    available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE pg_catalog.clock_timestamp()+
      pg_catalog.make_interval(secs=>LEAST(3600::double precision,
        requested_backoff_seconds*pg_catalog.power(2::double precision,attempts-1))) END,
    lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,last_error=requested_error_code,
    dead_lettered_at=CASE WHEN attempts>=max_attempts THEN pg_catalog.clock_timestamp() ELSE NULL END,
    updated_at=pg_catalog.clock_timestamp()
  WHERE event.id=requested_outbox_id AND event.aggregate_type='inbound_channel_event'
    AND event.event_type='channel.inbound.received' AND event.payload_version=1
    AND event.status='PROCESSING' AND event.lease_token=requested_lease_token
    AND event.lease_expires_at>pg_catalog.clock_timestamp()
  RETURNING event.status INTO next_status;
  RETURN next_status;
END $$;

REVOKE ALL ON FUNCTION claim_inbound_materialization_events(integer,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
REVOKE ALL ON FUNCTION fail_inbound_materialization_event(uuid,uuid,text,integer) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
GRANT EXECUTE ON FUNCTION claim_inbound_materialization_events(integer,integer) TO zap_pronto_worker;
GRANT EXECUTE ON FUNCTION fail_inbound_materialization_event(uuid,uuid,text,integer) TO zap_pronto_worker;

REVOKE SELECT,INSERT,UPDATE,DELETE ON outbox_events,inbound_channel_events,contacts,contact_identities,conversations,messages
  FROM zap_pronto_worker;

INSERT INTO app_permissions(code) VALUES('inbound.routing.read'),('inbound.routing.resolve')
ON CONFLICT DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code) VALUES
  ('TENANT_ADMIN','inbound.routing.read'),('TENANT_ADMIN','inbound.routing.resolve')
ON CONFLICT DO NOTHING;

CREATE INDEX inbound_channel_events_unrouted_queue_idx
  ON inbound_channel_events(tenant_id,received_at,id) WHERE routing_status='UNROUTED';

CREATE TABLE inbound_routing_commands(
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  receipt_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK(length(correlation_id) BETWEEN 8 AND 128),
  outbox_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES inbound_channel_events(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(outbox_id) REFERENCES outbox_events(id)
);
ALTER TABLE inbound_routing_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_routing_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_routing_commands_no_direct_access ON inbound_routing_commands USING(false) WITH CHECK(false);
REVOKE ALL ON inbound_routing_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION list_inbound_routing_required(requested_limit integer,anchor_received_at timestamptz,anchor_id uuid)
RETURNS TABLE(receipt_id uuid,channel_connection_id uuid,provider text,kind text,occurred_at timestamptz,
  received_at timestamptz,eligible_units jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF NOT public.current_actor_has_permission('inbound.routing.read',NULL) THEN
    RAISE EXCEPTION 'INBOUND_ROUTING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR ((anchor_received_at IS NULL)<>(anchor_id IS NULL)) THEN
    RAISE EXCEPTION 'INVALID_INBOUND_ROUTING_PAGE' USING ERRCODE='22023';
  END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.inbound_channel_events event
    WHERE event.tenant_id=public.current_app_tenant_id() AND event.id=anchor_id
      AND pg_catalog.date_trunc('milliseconds',event.received_at)=anchor_received_at) THEN
    RAISE EXCEPTION 'INVALID_INBOUND_ROUTING_CURSOR' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT event.id,event.channel_connection_id,event.provider,event.kind,event.occurred_at,event.received_at,
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',unit.id,'code',unit.code,'name',unit.name)
      ORDER BY unit.code,unit.id) FROM public.channel_connection_units mapping JOIN public.units unit
      ON unit.tenant_id=mapping.tenant_id AND unit.id=mapping.unit_id AND unit.active=true
      WHERE mapping.tenant_id=event.tenant_id AND mapping.channel_connection_id=event.channel_connection_id
        AND connection.status='ACTIVE'),'[]'::jsonb)
  FROM public.inbound_channel_events event JOIN public.channel_connections connection
    ON connection.tenant_id=event.tenant_id AND connection.id=event.channel_connection_id
  WHERE event.tenant_id=public.current_app_tenant_id() AND event.routing_status='UNROUTED'
    AND (anchor_id IS NULL OR (pg_catalog.date_trunc('milliseconds',event.received_at),event.id)>
      (anchor_received_at,anchor_id))
  ORDER BY pg_catalog.date_trunc('milliseconds',event.received_at),event.id LIMIT requested_limit;
END $$;

CREATE FUNCTION resolve_inbound_routing_required(requested_receipt_id uuid,requested_unit_id uuid,
  requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(receipt_id uuid,unit_id uuid,outbox_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE existing record;receipt record;created_outbox_id uuid;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_receipt_id IS NULL OR requested_unit_id IS NULL OR requested_idempotency_key IS NULL
    OR requested_idempotency_key<>pg_catalog.btrim(requested_idempotency_key)
    OR pg_catalog.length(requested_idempotency_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_INBOUND_ROUTING_REQUEST' USING ERRCODE='22023';
  END IF;
  IF NOT public.current_actor_has_permission('inbound.routing.resolve',requested_unit_id) THEN
    RAISE EXCEPTION 'INBOUND_ROUTING_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    public.current_app_tenant_id()::text||pg_catalog.chr(31)||requested_idempotency_key,0));
  SELECT command.* INTO existing FROM public.inbound_routing_commands command
  WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=requested_idempotency_key;
  IF FOUND THEN
    IF existing.receipt_id IS DISTINCT FROM requested_receipt_id OR existing.unit_id IS DISTINCT FROM requested_unit_id
      OR existing.request_fingerprint IS DISTINCT FROM requested_fingerprint THEN
      RAISE EXCEPTION 'INBOUND_ROUTING_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';
    END IF;
    receipt_id:=existing.receipt_id;unit_id:=existing.unit_id;outbox_id:=existing.outbox_id;replayed:=true;RETURN NEXT;RETURN;
  END IF;
  SELECT event.* INTO receipt FROM public.inbound_channel_events event
  WHERE event.tenant_id=public.current_app_tenant_id() AND event.id=requested_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INBOUND_ROUTING_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF receipt.routing_status='ROUTED' THEN
    SELECT command.* INTO existing FROM public.inbound_routing_commands command
    WHERE command.tenant_id=receipt.tenant_id AND command.receipt_id=receipt.id ORDER BY command.created_at,command.idempotency_key LIMIT 1;
    IF FOUND AND existing.unit_id=requested_unit_id THEN
      INSERT INTO public.inbound_routing_commands(tenant_id,idempotency_key,receipt_id,unit_id,request_fingerprint,
        actor_id,correlation_id,outbox_id) VALUES(receipt.tenant_id,requested_idempotency_key,receipt.id,requested_unit_id,
        requested_fingerprint,public.current_app_actor_id(),current_setting('app.correlation_id'),existing.outbox_id);
      receipt_id:=existing.receipt_id;unit_id:=existing.unit_id;outbox_id:=existing.outbox_id;replayed:=true;RETURN NEXT;RETURN;
    END IF;
    RAISE EXCEPTION 'INBOUND_ROUTING_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.channel_connections connection
      JOIN public.channel_connection_units mapping ON mapping.tenant_id=connection.tenant_id
        AND mapping.channel_connection_id=connection.id AND mapping.unit_id=requested_unit_id
      JOIN public.units unit ON unit.tenant_id=mapping.tenant_id AND unit.id=mapping.unit_id
    WHERE connection.tenant_id=receipt.tenant_id AND connection.id=receipt.channel_connection_id
      AND connection.status='ACTIVE' AND unit.active=true) THEN
    RAISE EXCEPTION 'INBOUND_ROUTING_TARGET_INVALID' USING ERRCODE='P0001';
  END IF;
  UPDATE public.inbound_channel_events event SET unit_id=requested_unit_id,routing_status='ROUTED',routing_reason=NULL
  WHERE event.tenant_id=receipt.tenant_id AND event.id=receipt.id;
  UPDATE public.outbox_events event SET status='PUBLISHED',published_at=pg_catalog.clock_timestamp(),updated_at=pg_catalog.clock_timestamp()
  WHERE event.tenant_id=receipt.tenant_id AND event.aggregate_id=receipt.id
    AND event.event_type='channel.inbound.routing_required' AND event.status='PENDING';
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,payload_version)
  VALUES(receipt.tenant_id,'inbound_channel_event',receipt.id,'channel.inbound.received',
    pg_catalog.jsonb_build_object('receiptId',receipt.id,'provider',receipt.provider,'kind',receipt.kind,
      'channelConnectionId',receipt.channel_connection_id,'unitId',requested_unit_id,'routingStatus','ROUTED'),
    'channel.inbound.received:'||receipt.id::text,1) RETURNING id INTO created_outbox_id;
  INSERT INTO public.inbound_routing_commands(tenant_id,idempotency_key,receipt_id,unit_id,request_fingerprint,
    actor_id,correlation_id,outbox_id) VALUES(receipt.tenant_id,requested_idempotency_key,receipt.id,requested_unit_id,
      requested_fingerprint,public.current_app_actor_id(),current_setting('app.correlation_id'),created_outbox_id);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(receipt.tenant_id,'USER',public.current_app_actor_id()::text,'INBOUND_ROUTING_RESOLVED','inbound_channel_event',
    receipt.id::text,pg_catalog.jsonb_build_object('unitId',requested_unit_id,'channelConnectionId',receipt.channel_connection_id));
  receipt_id:=receipt.id;unit_id:=requested_unit_id;outbox_id:=created_outbox_id;replayed:=false;RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION list_inbound_routing_required(integer,timestamptz,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
REVOKE ALL ON FUNCTION resolve_inbound_routing_required(uuid,uuid,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbound_routing_required(integer,timestamptz,uuid) TO zap_pronto_api;
GRANT EXECUTE ON FUNCTION resolve_inbound_routing_required(uuid,uuid,text,text) TO zap_pronto_api;

COMMENT ON TABLE inbound_channel_events IS
  'Validated inbound receipts. UNROUTED rows are exposed only through narrow administrative routing functions.';

COMMIT;
