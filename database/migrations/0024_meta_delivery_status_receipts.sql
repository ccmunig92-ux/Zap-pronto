BEGIN;

ALTER TABLE messages
  ADD COLUMN provider_sent_at timestamptz,
  ADD COLUMN provider_delivered_at timestamptz,
  ADD COLUMN provider_read_at timestamptz,
  ADD COLUMN provider_failed_at timestamptz,
  ADD COLUMN last_provider_status_at timestamptz;

CREATE TABLE meta_delivery_status_receipts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider='META_WHATSAPP'),
  channel_account_id text NOT NULL CHECK(length(btrim(channel_account_id)) BETWEEN 1 AND 512),
  external_message_id text NOT NULL CHECK(length(btrim(external_message_id)) BETWEEN 1 AND 512),
  recipient_external_id text CHECK(recipient_external_id IS NULL OR length(btrim(recipient_external_id)) BETWEEN 1 AND 512),
  provider_status text NOT NULL CHECK(provider_status~'^[a-z_]{1,64}$'),
  normalized_status text CHECK(normalized_status IS NULL OR normalized_status IN('SENT','DELIVERED','READ','FAILED')),
  occurred_at timestamptz NOT NULL,
  error_codes integer[] NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id text NOT NULL,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,channel_connection_id) REFERENCES channel_connections(tenant_id,id),
  CHECK(cardinality(error_codes)<=20)
);
CREATE INDEX meta_delivery_status_receipts_external_idx
  ON meta_delivery_status_receipts(tenant_id,channel_connection_id,external_message_id,occurred_at,id);
ALTER TABLE meta_delivery_status_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_delivery_status_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_delivery_status_receipts_tenant ON meta_delivery_status_receipts
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON meta_delivery_status_receipts FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE TABLE meta_delivery_status_applications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  message_id uuid,
  outcome text NOT NULL CHECK(outcome IN('APPLIED','IGNORED_DUPLICATE','IGNORED_STALE','IGNORED_CANCELLED','UNMATCHED','AMBIGUOUS','UNSUPPORTED','RECIPIENT_MISMATCH')),
  previous_status text CHECK(previous_status IS NULL OR previous_status IN('QUEUED','SENT','DELIVERED','READ','FAILED','CANCELLED')),
  result_status text CHECK(result_status IS NULL OR result_status IN('QUEUED','SENT','DELIVERED','READ','FAILED','CANCELLED')),
  candidate_count integer NOT NULL CHECK(candidate_count>=0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,receipt_id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES meta_delivery_status_receipts(tenant_id,id),
  FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id)
);
ALTER TABLE meta_delivery_status_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_delivery_status_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_delivery_status_applications_tenant ON meta_delivery_status_applications
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON meta_delivery_status_applications FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION reconcile_meta_delivery_status(requested_channel_account_id text,requested_external_message_id text,
  requested_recipient_external_id text,requested_provider_status text,requested_normalized_status text,
  requested_occurred_at timestamptz,requested_error_codes integer[],requested_idempotency_key text,
  requested_fingerprint text,requested_correlation_id text)
RETURNS TABLE(receipt_id uuid,application_id uuid,message_id uuid,outcome text,previous_status text,result_status text,
  candidate_count integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE connection_record record;existing_receipt public.meta_delivery_status_receipts%ROWTYPE;
  existing_application public.meta_delivery_status_applications%ROWTYPE;created_receipt_id uuid;candidate_ids uuid[];
  candidate_message public.messages%ROWTYPE;candidate_total integer;recipient_matches integer;next_outcome text;
  previous_value text;result_value text;created_application_id uuid;can_advance boolean:=false;
BEGIN
  IF requested_channel_account_id IS NULL OR requested_channel_account_id<>btrim(requested_channel_account_id)
    OR length(requested_channel_account_id) NOT BETWEEN 1 AND 512
    OR requested_external_message_id IS NULL OR requested_external_message_id<>btrim(requested_external_message_id)
    OR length(requested_external_message_id) NOT BETWEEN 1 AND 512
    OR requested_provider_status IS NULL OR requested_provider_status!~'^[a-z_]{1,64}$'
    OR requested_normalized_status IS NOT NULL AND requested_normalized_status NOT IN('SENT','DELIVERED','READ','FAILED')
    OR requested_occurred_at IS NULL OR requested_error_codes IS NULL OR cardinality(requested_error_codes)>20
    OR requested_idempotency_key IS NULL OR length(requested_idempotency_key) NOT BETWEEN 1 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[a-f0-9]{64}$'
    OR requested_correlation_id IS NULL OR length(requested_correlation_id) NOT BETWEEN 1 AND 512
    OR requested_recipient_external_id IS NOT NULL AND (requested_recipient_external_id<>btrim(requested_recipient_external_id)
      OR length(requested_recipient_external_id) NOT BETWEEN 1 AND 512) THEN
    RAISE EXCEPTION 'INVALID_META_DELIVERY_STATUS' USING ERRCODE='22023'; END IF;
  SELECT connection.tenant_id,connection.id INTO connection_record FROM public.channel_connections connection
  WHERE connection.type='WHATSAPP' AND connection.external_account_id=requested_channel_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_STATUS_ACCOUNT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(connection_record.tenant_id::text||':'||requested_idempotency_key,0));
  SELECT receipt.* INTO existing_receipt FROM public.meta_delivery_status_receipts receipt
  WHERE receipt.tenant_id=connection_record.tenant_id AND receipt.idempotency_key=requested_idempotency_key;
  IF FOUND THEN
    IF existing_receipt.request_fingerprint IS DISTINCT FROM requested_fingerprint THEN
      RAISE EXCEPTION 'META_STATUS_IDEMPOTENCY_COLLISION' USING ERRCODE='P0001'; END IF;
    SELECT application.* INTO existing_application FROM public.meta_delivery_status_applications application
    WHERE application.tenant_id=existing_receipt.tenant_id AND application.receipt_id=existing_receipt.id;
    receipt_id:=existing_receipt.id;application_id:=existing_application.id;message_id:=existing_application.message_id;
    outcome:=existing_application.outcome;previous_status:=existing_application.previous_status;
    result_status:=existing_application.result_status;candidate_count:=existing_application.candidate_count;replayed:=true;
    RETURN NEXT;RETURN;
  END IF;
  INSERT INTO public.meta_delivery_status_receipts(tenant_id,channel_connection_id,provider,channel_account_id,
    external_message_id,recipient_external_id,provider_status,normalized_status,occurred_at,error_codes,
    idempotency_key,request_fingerprint,correlation_id)
  VALUES(connection_record.tenant_id,connection_record.id,'META_WHATSAPP',requested_channel_account_id,
    requested_external_message_id,requested_recipient_external_id,requested_provider_status,requested_normalized_status,
    requested_occurred_at,requested_error_codes,requested_idempotency_key,requested_fingerprint,requested_correlation_id)
  RETURNING id INTO created_receipt_id;
  SELECT array_agg(message.id ORDER BY message.id),count(*)::integer INTO candidate_ids,candidate_total
  FROM public.messages message JOIN public.conversations conversation
    ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
  WHERE message.tenant_id=connection_record.tenant_id AND conversation.channel_connection_id=connection_record.id
    AND message.direction='OUTBOUND' AND message.external_message_id=requested_external_message_id;
  candidate_total:=coalesce(candidate_total,0);
  IF requested_normalized_status IS NULL THEN next_outcome:='UNSUPPORTED';
  ELSIF candidate_total=0 THEN next_outcome:='UNMATCHED';
  ELSIF candidate_total>1 THEN next_outcome:='AMBIGUOUS';
  ELSE
    SELECT message.* INTO candidate_message FROM public.messages message
    WHERE message.tenant_id=connection_record.tenant_id AND message.id=candidate_ids[1] FOR UPDATE;
    IF requested_recipient_external_id IS NOT NULL THEN
      SELECT count(*)::integer INTO recipient_matches FROM public.conversations conversation
      JOIN public.contact_identities identity ON identity.tenant_id=conversation.tenant_id
        AND identity.id=conversation.contact_identity_id AND identity.channel_connection_id=conversation.channel_connection_id
      WHERE conversation.tenant_id=candidate_message.tenant_id AND conversation.id=candidate_message.conversation_id
        AND identity.external_user_id=requested_recipient_external_id;
      IF recipient_matches<>1 THEN next_outcome:='RECIPIENT_MISMATCH'; END IF;
    END IF;
    IF next_outcome IS NULL THEN
      previous_value:=candidate_message.delivery_status;
      result_value:=previous_value;
      IF previous_value='CANCELLED' THEN next_outcome:='IGNORED_CANCELLED';
      ELSIF previous_value=requested_normalized_status THEN next_outcome:='IGNORED_DUPLICATE';
      ELSIF previous_value='READ' THEN next_outcome:='IGNORED_STALE';
      ELSIF candidate_message.last_provider_status_at IS NOT NULL AND requested_occurred_at<=candidate_message.last_provider_status_at THEN
        next_outcome:='IGNORED_STALE';
      ELSE
        can_advance:=(previous_value='QUEUED')
          OR (previous_value='FAILED' AND requested_normalized_status IN('SENT','DELIVERED','READ'))
          OR (previous_value='SENT' AND requested_normalized_status IN('DELIVERED','READ'))
          OR (previous_value='DELIVERED' AND requested_normalized_status='READ');
        IF requested_normalized_status='FAILED' AND previous_value<>'QUEUED' THEN can_advance:=false; END IF;
        IF can_advance THEN
          UPDATE public.messages SET delivery_status=requested_normalized_status,
            provider_sent_at=CASE WHEN requested_normalized_status='SENT' THEN requested_occurred_at ELSE provider_sent_at END,
            provider_delivered_at=CASE WHEN requested_normalized_status='DELIVERED' THEN requested_occurred_at ELSE provider_delivered_at END,
            provider_read_at=CASE WHEN requested_normalized_status='READ' THEN requested_occurred_at ELSE provider_read_at END,
            provider_failed_at=CASE WHEN requested_normalized_status='FAILED' THEN requested_occurred_at ELSE provider_failed_at END,
            last_provider_status_at=requested_occurred_at
          WHERE tenant_id=candidate_message.tenant_id AND id=candidate_message.id;
          result_value:=requested_normalized_status;next_outcome:='APPLIED';
        ELSE next_outcome:='IGNORED_STALE'; END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.meta_delivery_status_applications(tenant_id,receipt_id,message_id,outcome,previous_status,result_status,candidate_count)
  VALUES(connection_record.tenant_id,created_receipt_id,
    CASE WHEN candidate_total=1 AND next_outcome NOT IN('UNSUPPORTED','RECIPIENT_MISMATCH') THEN candidate_ids[1] ELSE NULL END,
    next_outcome,previous_value,result_value,candidate_total) RETURNING id INTO created_application_id;
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(connection_record.tenant_id,'SYSTEM',NULL,'META_DELIVERY_STATUS_RECONCILED','meta_delivery_status_receipt',created_receipt_id::text,
    jsonb_build_object('receiptId',created_receipt_id,'applicationId',created_application_id,
      'messageId',CASE WHEN candidate_total=1 THEN candidate_ids[1] ELSE NULL END,'outcome',next_outcome,'candidateCount',candidate_total));
  receipt_id:=created_receipt_id;application_id:=created_application_id;
  message_id:=CASE WHEN candidate_total=1 AND next_outcome NOT IN('UNSUPPORTED','RECIPIENT_MISMATCH') THEN candidate_ids[1] ELSE NULL END;
  outcome:=next_outcome;previous_status:=previous_value;result_status:=result_value;candidate_count:=candidate_total;replayed:=false;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)
  TO zap_pronto_api;

COMMIT;
