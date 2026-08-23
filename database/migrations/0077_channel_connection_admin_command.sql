BEGIN;

-- The administrative API stores only a provider-safe pointer. The access token
-- is provisioned separately in the worker secret manager and is never accepted
-- by this command or returned by its projection.
CREATE TABLE channel_connection_metadata_commands(
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  connection_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES channel_connections(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE channel_connection_metadata_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connection_metadata_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_connection_metadata_commands_tenant ON channel_connection_metadata_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON channel_connection_metadata_commands FROM PUBLIC,zap_pronto_app,zap_pronto_worker;

CREATE OR REPLACE FUNCTION set_channel_connection_metadata(
  requested_connection_id uuid, requested_scope text, requested_display_name text,
  requested_waba_id text, requested_phone_number_id text, requested_status text,
  requested_secret_reference text, requested_unit_ids jsonb, requested_idempotency_key text,
  requested_fingerprint text, requested_type text
) RETURNS TABLE(id uuid,scope text,display_name text,waba_id text,phone_number_id text,status text,
  secret_configured boolean,unit_ids uuid[],replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE
  tenant_id_value uuid:=public.current_app_tenant_id(); actor_id_value uuid:=public.current_app_actor_id();
  normalized_key text:=requested_idempotency_key; normalized_name text:=NULLIF(btrim(requested_display_name),'');
  normalized_secret text:=requested_secret_reference; command_record public.channel_connection_metadata_commands%ROWTYPE;
  payload jsonb; connection_record public.channel_connections%ROWTYPE; unit_list uuid[]; new_id uuid;
  command_found boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_type IS DISTINCT FROM 'WHATSAPP' OR requested_scope NOT IN ('CORPORATE','SINGLE_UNIT','SELECTED_UNITS')
    OR requested_status NOT IN ('ACTIVE','DEGRADED','DISCONNECTED') OR requested_connection_id IS NULL AND requested_scope IS NULL
    OR normalized_key IS NULL OR normalized_key<>requested_idempotency_key OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint !~ '^[0-9a-f]{64}$'
    OR requested_waba_id !~ '^[0-9]{6,32}$' OR requested_phone_number_id !~ '^[0-9]{6,32}$'
    OR requested_secret_reference !~ '^[A-Za-z0-9._-]{1,128}$'
    OR (requested_display_name IS NOT NULL AND (requested_display_name<>btrim(requested_display_name)
      OR length(normalized_name) NOT BETWEEN 1 AND 160))
    OR jsonb_typeof(requested_unit_ids) IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested_unit_ids) item WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
      OR item #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR requested_scope='CORPORATE' AND jsonb_array_length(requested_unit_ids)<>0
    OR requested_scope='SINGLE_UNIT' AND jsonb_array_length(requested_unit_ids)<>1
    OR requested_scope='SELECTED_UNITS' AND jsonb_array_length(requested_unit_ids)<1
    OR jsonb_array_length(requested_unit_ids)>100 THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_CONNECTION_REQUEST' USING ERRCODE='22023';
  END IF;
  IF NOT public.current_actor_has_permission('channel_connections.manage',NULL) THEN
    RAISE EXCEPTION 'CHANNEL_CONNECTION_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  SELECT array_agg(value::uuid ORDER BY value::uuid) INTO unit_list
    FROM jsonb_array_elements_text(requested_unit_ids) values(value);
  IF EXISTS(SELECT 1 FROM unnest(COALESCE(unit_list,'{}'::uuid[])) selected
    WHERE NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=tenant_id_value AND unit.id=selected AND unit.active)) THEN
    RAISE EXCEPTION 'CHANNEL_CONNECTION_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  payload:=jsonb_build_object('connectionId',requested_connection_id,'scope',requested_scope,'displayName',normalized_name,
    'wabaId',requested_waba_id,'phoneNumberId',requested_phone_number_id,'status',requested_status,
    'secretReference',requested_secret_reference,'unitIds',to_jsonb(COALESCE(unit_list,'{}'::uuid[])),'type',requested_type);
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':channel-connection-key:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.channel_connection_metadata_commands command
    WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=normalized_key;
  command_found:=FOUND;
  IF command_found THEN
    IF command_record.request_fingerprint<>requested_fingerprint OR command_record.request_payload<>payload
      OR command_record.actor_id<>actor_id_value THEN
      RAISE EXCEPTION 'CHANNEL_CONNECTION_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';
    END IF;
    SELECT connection.* INTO connection_record FROM public.channel_connections connection
      WHERE connection.tenant_id=tenant_id_value AND connection.id=command_record.connection_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHANNEL_CONNECTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    RETURN QUERY SELECT connection_record.id,connection_record.scope,connection_record.display_name,connection_record.waba_id,
      connection_record.external_account_id,connection_record.status,
      connection_record.secret_reference IS NOT NULL AND length(btrim(connection_record.secret_reference))>0,
      COALESCE((SELECT array_agg(mapping.unit_id ORDER BY mapping.unit_id) FROM public.channel_connection_units mapping
        WHERE mapping.tenant_id=tenant_id_value AND mapping.channel_connection_id=connection_record.id),'{}'::uuid[]),true;
    RETURN;
  END IF;
  IF requested_connection_id IS NULL THEN new_id:=public.gen_random_uuid();
  ELSE new_id:=requested_connection_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':channel-connection:'||new_id::text,0));
  IF requested_connection_id IS NOT NULL THEN
    SELECT connection.* INTO connection_record FROM public.channel_connections connection
      WHERE connection.tenant_id=tenant_id_value AND connection.id=new_id AND connection.type='WHATSAPP';
    IF NOT FOUND THEN RAISE EXCEPTION 'CHANNEL_CONNECTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
    UPDATE public.channel_connections connection SET scope=requested_scope,display_name=normalized_name,waba_id=requested_waba_id,
      external_account_id=requested_phone_number_id,status=requested_status,secret_reference=requested_secret_reference
      WHERE connection.tenant_id=tenant_id_value AND connection.id=new_id;
  ELSE
    IF EXISTS(SELECT 1 FROM public.channel_connections connection WHERE connection.tenant_id=tenant_id_value
      AND connection.type='WHATSAPP' AND connection.external_account_id=requested_phone_number_id) THEN
      RAISE EXCEPTION 'CHANNEL_CONNECTION_CONFLICT' USING ERRCODE='P0001';
    END IF;
    INSERT INTO public.channel_connections(id,tenant_id,type,scope,external_account_id,status,secret_reference,waba_id,display_name)
      VALUES(new_id,tenant_id_value,'WHATSAPP',requested_scope,requested_phone_number_id,requested_status,requested_secret_reference,requested_waba_id,normalized_name)
      RETURNING channel_connections.* INTO connection_record;
  END IF;
  DELETE FROM public.channel_connection_units mapping WHERE mapping.tenant_id=tenant_id_value AND mapping.channel_connection_id=new_id;
  INSERT INTO public.channel_connection_units(tenant_id,channel_connection_id,unit_id)
    SELECT tenant_id_value,new_id,selected FROM unnest(COALESCE(unit_list,'{}'::uuid[])) selected;
  INSERT INTO public.channel_connection_metadata_commands(tenant_id,idempotency_key,connection_id,request_fingerprint,request_payload,actor_id)
    VALUES(tenant_id_value,normalized_key,new_id,requested_fingerprint,payload,actor_id_value);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_id_value,'USER',actor_id_value,'CHANNEL_CONNECTION_METADATA_CONFIGURED','channel_connection',new_id::text,
      jsonb_build_object('scope',requested_scope,'wabaId',requested_waba_id,'phoneNumberId',requested_phone_number_id,'status',requested_status));
  RETURN QUERY SELECT new_id,requested_scope,normalized_name,requested_waba_id,requested_phone_number_id,requested_status,true,unit_list,false;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'CHANNEL_CONNECTION_CONFLICT' USING ERRCODE='P0001';
END $$;
REVOKE ALL ON FUNCTION set_channel_connection_metadata(uuid,text,text,text,text,text,text,jsonb,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_channel_connection_metadata(uuid,text,text,text,text,text,text,jsonb,text,text,text) TO zap_pronto_api;

COMMIT;
