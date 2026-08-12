BEGIN;

ALTER FUNCTION reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)
  RENAME TO reconcile_meta_delivery_status_0025;
REVOKE ALL ON FUNCTION reconcile_meta_delivery_status_0025(text,text,text,text,text,timestamptz,integer[],text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION reconcile_meta_delivery_status(requested_channel_account_id text,requested_external_message_id text,
  requested_recipient_external_id text,requested_provider_status text,requested_normalized_status text,
  requested_occurred_at timestamptz,requested_error_codes integer[],requested_idempotency_key text,
  requested_fingerprint text,requested_correlation_id text)
RETURNS TABLE(receipt_id uuid,application_id uuid,message_id uuid,outcome text,previous_status text,result_status text,
  candidate_count integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE connection_record record;existing_receipt public.meta_delivery_status_receipts%ROWTYPE;
  existing_application public.meta_delivery_status_applications%ROWTYPE;candidate public.messages%ROWTYPE;
  candidate_total integer:=0;created_receipt_id uuid;created_application_id uuid;
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
  SELECT count(*)::integer INTO candidate_total FROM public.messages message JOIN public.conversations conversation
    ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
  WHERE message.tenant_id=connection_record.tenant_id AND conversation.channel_connection_id=connection_record.id
    AND message.direction='OUTBOUND' AND message.external_message_id=requested_external_message_id;
  IF candidate_total=1 THEN
    SELECT message.* INTO candidate FROM public.messages message JOIN public.conversations conversation
      ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
    WHERE message.tenant_id=connection_record.tenant_id AND conversation.channel_connection_id=connection_record.id
      AND message.direction='OUTBOUND' AND message.external_message_id=requested_external_message_id FOR UPDATE OF message;
  END IF;
  IF candidate_total=1 AND requested_occurred_at<candidate.created_at-interval '10 minutes' THEN
    INSERT INTO public.meta_delivery_status_receipts(tenant_id,channel_connection_id,provider,channel_account_id,
      external_message_id,recipient_external_id,provider_status,normalized_status,occurred_at,error_codes,
      idempotency_key,request_fingerprint,correlation_id)
    VALUES(connection_record.tenant_id,connection_record.id,'META_WHATSAPP',requested_channel_account_id,
      requested_external_message_id,requested_recipient_external_id,requested_provider_status,requested_normalized_status,
      requested_occurred_at,requested_error_codes,requested_idempotency_key,requested_fingerprint,requested_correlation_id)
    RETURNING id INTO created_receipt_id;
    INSERT INTO public.meta_delivery_status_applications(tenant_id,receipt_id,message_id,outcome,previous_status,result_status,candidate_count)
    VALUES(connection_record.tenant_id,created_receipt_id,candidate.id,'IGNORED_INVALID_TIMESTAMP',candidate.delivery_status,candidate.delivery_status,1)
    RETURNING id INTO created_application_id;
    INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(connection_record.tenant_id,'SYSTEM',NULL,'META_DELIVERY_STATUS_RECONCILED','meta_delivery_status_receipt',created_receipt_id::text,
      jsonb_build_object('receiptId',created_receipt_id,'applicationId',created_application_id,
        'messageId',candidate.id,'outcome','IGNORED_INVALID_TIMESTAMP','candidateCount',1));
    receipt_id:=created_receipt_id;application_id:=created_application_id;message_id:=candidate.id;
    outcome:='IGNORED_INVALID_TIMESTAMP';previous_status:=candidate.delivery_status;result_status:=candidate.delivery_status;
    candidate_count:=1;replayed:=false;RETURN NEXT;RETURN;
  END IF;
  RETURN QUERY SELECT result.receipt_id,result.application_id,result.message_id,result.outcome,
    result.previous_status,result.result_status,result.candidate_count,result.replayed
  FROM public.reconcile_meta_delivery_status_0025(requested_channel_account_id,requested_external_message_id,
    requested_recipient_external_id,requested_provider_status,requested_normalized_status,requested_occurred_at,
    requested_error_codes,requested_idempotency_key,requested_fingerprint,requested_correlation_id) result;
END $$;

REVOKE ALL ON FUNCTION reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION reconcile_meta_delivery_status(text,text,text,text,text,timestamptz,integer[],text,text,text)
  TO zap_pronto_api;

COMMIT;
