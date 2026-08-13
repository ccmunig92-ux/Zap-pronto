BEGIN;

INSERT INTO app_permissions(code) VALUES('unit_timezone.read'),('unit_timezone.manage') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,permission.code FROM app_roles role CROSS JOIN app_permissions permission
WHERE (permission.code='unit_timezone.read' AND role.code IN('SUPERVISOR','UNIT_MANAGER','TENANT_ADMIN'))
   OR (permission.code='unit_timezone.manage' AND role.code IN('UNIT_MANAGER','TENANT_ADMIN'))
ON CONFLICT DO NOTHING;

CREATE TABLE unit_operational_timezone_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,unit_id uuid NOT NULL,
  time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),version integer NOT NULL CHECK(version>0),
  created_by_user_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,unit_id,version),UNIQUE(tenant_id,id),UNIQUE(tenant_id,unit_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE unit_operational_timezone_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  unit_id uuid NOT NULL,time_zone text NOT NULL,expected_version integer NOT NULL CHECK(expected_version>=0),
  result_version_id uuid NOT NULL,result_version integer NOT NULL CHECK(result_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,result_version_id) REFERENCES unit_operational_timezone_versions(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE unit_operational_timezone_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_operational_timezone_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_operational_timezone_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_operational_timezone_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_operational_timezone_versions_tenant ON unit_operational_timezone_versions
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_operational_timezone_commands_tenant ON unit_operational_timezone_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_operational_timezone_versions,unit_operational_timezone_commands
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION get_unit_operational_timezone(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,time_zone text,version integer,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.units unit
      WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    OR NOT public.current_actor_has_permission('unit_timezone.read',requested_unit_id) THEN
    RAISE EXCEPTION 'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT configured.unit_id,configured.time_zone,configured.version,
    date_trunc('milliseconds',configured.updated_at)
  FROM public.unit_operational_timezone_versions configured
  WHERE configured.tenant_id=public.current_app_tenant_id() AND configured.unit_id=requested_unit_id
  ORDER BY configured.version DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION get_unit_operational_timezone(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_operational_timezone(uuid) TO zap_pronto_api;

CREATE FUNCTION set_unit_operational_timezone(requested_unit_id uuid,requested_time_zone text,
  requested_expected_version integer,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,time_zone text,version integer,updated_at timestamptz,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_idempotency_key);normalized_time_zone text:=btrim(requested_time_zone);
  command_record public.unit_operational_timezone_commands%ROWTYPE;current_version integer;
  new_id uuid:=gen_random_uuid();changed_at timestamptz:=clock_timestamp();computed_fingerprint text;command_found boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<0
    OR normalized_key IS NULL OR normalized_key<>requested_idempotency_key OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR normalized_time_zone IS NULL OR normalized_time_zone='' OR normalized_time_zone<>requested_time_zone
    OR length(normalized_time_zone)>100 OR normalized_time_zone~'\s' OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names zone WHERE zone.name=normalized_time_zone) THEN
    RAISE EXCEPTION 'INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST' USING ERRCODE='22023';END IF;
  computed_fingerprint:=encode(digest(convert_to(format('{"unitId":"%s","timeZone":%s,"expectedVersion":%s}',
    lower(requested_unit_id::text),to_json(normalized_time_zone)::text,requested_expected_version),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint<>computed_fingerprint THEN
    RAISE EXCEPTION 'INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone-key:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.unit_operational_timezone_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  command_found:=FOUND;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone:'||requested_unit_id::text,0));
  IF command_found THEN
    IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=command_record.tenant_id
        AND unit.id=command_record.unit_id AND unit.active)
      OR NOT public.current_actor_has_permission('unit_timezone.manage',command_record.unit_id) THEN
      RAISE EXCEPTION 'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' USING ERRCODE='P0001';END IF;
    IF command_record.unit_id<>requested_unit_id OR command_record.time_zone<>normalized_time_zone
      OR command_record.expected_version<>requested_expected_version OR command_record.request_fingerprint<>computed_fingerprint
      OR command_record.actor_id<>public.current_app_actor_id() THEN
      RAISE EXCEPTION 'UNIT_OPERATIONAL_TIMEZONE_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT configured.unit_id,configured.time_zone,configured.version,
      date_trunc('milliseconds',configured.updated_at),true
    FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=command_record.tenant_id AND configured.id=command_record.result_version_id;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id()
      AND unit.id=requested_unit_id AND unit.active)
    OR NOT public.current_actor_has_permission('unit_timezone.manage',requested_unit_id) THEN
    RAISE EXCEPTION 'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT COALESCE(max(configured.version),0) INTO current_version FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=public.current_app_tenant_id() AND configured.unit_id=requested_unit_id;
  IF current_version<>requested_expected_version THEN
    RAISE EXCEPTION 'UNIT_OPERATIONAL_TIMEZONE_CONFLICT' USING ERRCODE='P0001';END IF;
  INSERT INTO public.unit_operational_timezone_versions(id,tenant_id,unit_id,time_zone,version,created_by_user_id,updated_at)
    VALUES(new_id,public.current_app_tenant_id(),requested_unit_id,normalized_time_zone,current_version+1,
      public.current_app_actor_id(),changed_at);
  INSERT INTO public.unit_operational_timezone_commands(tenant_id,idempotency_key,unit_id,time_zone,expected_version,
    result_version_id,result_version,request_fingerprint,actor_id)
    VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,normalized_time_zone,requested_expected_version,
      new_id,current_version+1,computed_fingerprint,public.current_app_actor_id());
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),'UNIT_OPERATIONAL_TIMEZONE_CONFIGURED',
      'unit_operational_timezone',new_id::text,jsonb_build_object('unitId',requested_unit_id,
        'timeZone',normalized_time_zone,'version',current_version+1));
  RETURN QUERY SELECT requested_unit_id,normalized_time_zone,current_version+1,
    date_trunc('milliseconds',changed_at),false;
END $$;
REVOKE ALL ON FUNCTION set_unit_operational_timezone(uuid,text,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_unit_operational_timezone(uuid,text,integer,text,text) TO zap_pronto_api;

COMMIT;
