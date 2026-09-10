BEGIN;

-- Keep the published 0077 implementation immutable while making the SQL
-- boundary reject nullable enum inputs before they reach NOT NULL constraints.
ALTER FUNCTION public.set_channel_connection_metadata(
  uuid,text,text,text,text,text,text,jsonb,text,text,text
) RENAME TO set_channel_connection_metadata_v0077;

REVOKE ALL ON FUNCTION public.set_channel_connection_metadata_v0077(
  uuid,text,text,text,text,text,text,jsonb,text,text,text
) FROM PUBLIC,zap_pronto_app,zap_pronto_worker,zap_pronto_api;

CREATE FUNCTION public.set_channel_connection_metadata(
  requested_connection_id uuid, requested_scope text, requested_display_name text,
  requested_waba_id text, requested_phone_number_id text, requested_status text,
  requested_secret_reference text, requested_unit_ids jsonb, requested_idempotency_key text,
  requested_fingerprint text, requested_type text
) RETURNS TABLE(id uuid,scope text,display_name text,waba_id text,phone_number_id text,status text,
  secret_configured boolean,unit_ids uuid[],replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF requested_scope IS NULL OR requested_scope NOT IN ('CORPORATE','SINGLE_UNIT','SELECTED_UNITS')
    OR requested_status IS NULL OR requested_status NOT IN ('ACTIVE','DEGRADED','DISCONNECTED') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_CONNECTION_REQUEST' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT * FROM public.set_channel_connection_metadata_v0077(
    requested_connection_id,requested_scope,requested_display_name,requested_waba_id,
    requested_phone_number_id,requested_status,requested_secret_reference,requested_unit_ids,
    requested_idempotency_key,requested_fingerprint,requested_type
  );
END $$;

REVOKE ALL ON FUNCTION public.set_channel_connection_metadata(
  uuid,text,text,text,text,text,text,jsonb,text,text,text
) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION public.set_channel_connection_metadata(
  uuid,text,text,text,text,text,text,jsonb,text,text,text
) TO zap_pronto_api;

COMMIT;
