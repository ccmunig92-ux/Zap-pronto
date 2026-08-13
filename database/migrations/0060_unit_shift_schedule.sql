BEGIN;

INSERT INTO app_permissions(code) VALUES('shift.read'),('shift.manage') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,permission.code FROM app_roles role CROSS JOIN app_permissions permission
WHERE (permission.code='shift.read' AND role.code IN('SUPERVISOR','UNIT_MANAGER','TENANT_ADMIN'))
   OR (permission.code='shift.manage' AND role.code IN('UNIT_MANAGER','TENANT_ADMIN'))
ON CONFLICT DO NOTHING;

CREATE TABLE unit_shift_schedule_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,unit_id uuid NOT NULL,user_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),effective_from date NOT NULL,time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  weekly_slots jsonb NOT NULL CHECK(jsonb_typeof(weekly_slots)='array'),exceptions jsonb NOT NULL CHECK(jsonb_typeof(exceptions)='array'),
  created_by_user_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,unit_id,user_id,version),UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id,unit_id) REFERENCES user_units(tenant_id,user_id,unit_id),
  FOREIGN KEY(tenant_id,created_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE unit_shift_schedule_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  unit_id uuid NOT NULL,user_id uuid NOT NULL,effective_from date NOT NULL,expected_version integer NOT NULL CHECK(expected_version>=0),
  time_zone text NOT NULL,weekly_slots jsonb NOT NULL,exceptions jsonb NOT NULL,result_version_id uuid NOT NULL,
  result_version integer NOT NULL CHECK(result_version>0),request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),FOREIGN KEY(tenant_id,user_id,unit_id) REFERENCES user_units(tenant_id,user_id,unit_id),
  FOREIGN KEY(tenant_id,result_version_id) REFERENCES unit_shift_schedule_versions(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE unit_shift_schedule_versions ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_shift_schedule_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_shift_schedule_commands ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_shift_schedule_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_shift_schedule_versions_tenant ON unit_shift_schedule_versions USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_shift_schedule_commands_tenant ON unit_shift_schedule_commands USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_shift_schedule_versions,unit_shift_schedule_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION get_unit_shift_schedule(requested_unit_id uuid,requested_user_id uuid)
RETURNS TABLE(unit_id uuid,user_id uuid,version integer,effective_from date,time_zone text,weekly_slots jsonb,exceptions jsonb,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_user_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit JOIN public.user_units membership ON membership.tenant_id=unit.tenant_id AND membership.unit_id=unit.id
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active
        AND membership.user_id=requested_user_id AND membership.status='ACTIVE'
        AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND account.status='ACTIVE') THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT schedule.unit_id,schedule.user_id,schedule.version,schedule.effective_from,schedule.time_zone,
    schedule.weekly_slots,schedule.exceptions,date_trunc('milliseconds',schedule.updated_at)
  FROM public.unit_shift_schedule_versions schedule WHERE schedule.tenant_id=public.current_app_tenant_id()
    AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id ORDER BY schedule.version DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION get_unit_shift_schedule(uuid,uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_shift_schedule(uuid,uuid) TO zap_pronto_api;

CREATE FUNCTION list_unit_shift_members(requested_unit_id uuid)
RETURNS TABLE(user_id uuid,display_name text,role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id()
      AND unit.id=requested_unit_id AND unit.active) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT account.id,pg_catalog.left(account.display_name,160),membership.role::text
  FROM public.user_units membership JOIN public.users account
    ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
  WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
    AND account.status='ACTIVE' ORDER BY lower(account.display_name),account.display_name,account.id;
END $$;
REVOKE ALL ON FUNCTION list_unit_shift_members(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_unit_shift_members(uuid) TO zap_pronto_api;

CREATE FUNCTION set_unit_shift_schedule(requested_unit_id uuid,requested_user_id uuid,requested_effective_from date,
  requested_weekly_slots jsonb,requested_exceptions jsonb,requested_expected_version integer,
  requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,user_id uuid,version integer,effective_from date,time_zone text,weekly_slots jsonb,exceptions jsonb,updated_at timestamptz,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_idempotency_key);canonical_weekly jsonb;canonical_exceptions jsonb;
  command_record public.unit_shift_schedule_commands%ROWTYPE;command_found boolean;timezone_snapshot text;local_today date;
  current_version integer;new_id uuid:=gen_random_uuid();changed_at timestamptz:=clock_timestamp();computed text;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_user_id IS NULL OR requested_effective_from IS NULL
    OR requested_expected_version IS NULL OR requested_expected_version<0 OR normalized_key IS NULL
    OR normalized_key<>requested_idempotency_key OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$'
    OR requested_weekly_slots IS NULL OR jsonb_typeof(requested_weekly_slots) IS DISTINCT FROM 'array' OR jsonb_array_length(requested_weekly_slots)>28
    OR requested_exceptions IS NULL OR jsonb_typeof(requested_exceptions) IS DISTINCT FROM 'array' OR jsonb_array_length(requested_exceptions)>90 THEN
    RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(requested_weekly_slots) slot
      WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(slot))<>3
        OR jsonb_typeof(slot->'weekday') IS DISTINCT FROM 'number' OR jsonb_typeof(slot->'start') IS DISTINCT FROM 'string'
        OR jsonb_typeof(slot->'end') IS DISTINCT FROM 'string' OR (slot->>'weekday')!~'^[1-7]$'
        OR (slot->>'start')!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (slot->>'end')!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' OR slot->>'start'>=slot->>'end')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested_exceptions) exception
      WHERE jsonb_typeof(exception) IS DISTINCT FROM 'object' OR jsonb_typeof(exception->'date') IS DISTINCT FROM 'string'
        OR jsonb_typeof(exception->'type') IS DISTINCT FROM 'string' OR exception->>'date'!~'^\d{4}-\d{2}-\d{2}$' OR NOT pg_input_is_valid(exception->>'date','date')
        OR exception->>'type' NOT IN('CLOSED','REPLACE')
        OR (exception->>'type'='CLOSED' AND ((SELECT count(*) FROM jsonb_object_keys(exception))<>2))
        OR (exception->>'type'='REPLACE' AND ((SELECT count(*) FROM jsonb_object_keys(exception))<>3
          OR jsonb_typeof(exception->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(exception->'slots') NOT BETWEEN 1 AND 4
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(exception->'slots') slot WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object'
            OR (SELECT count(*) FROM jsonb_object_keys(slot))<>2 OR jsonb_typeof(slot->'start') IS DISTINCT FROM 'string'
            OR jsonb_typeof(slot->'end') IS DISTINCT FROM 'string' OR (slot->>'start')!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
            OR (slot->>'end')!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' OR slot->>'start'>=slot->>'end')))) THEN
    RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(requested_exceptions) exception
      WHERE (exception->>'date')::date<requested_effective_from OR (exception->>'date')::date>requested_effective_from+365) THEN
    RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('weekday',(slot->>'weekday')::integer,'start',slot->>'start','end',slot->>'end')
      ORDER BY (slot->>'weekday')::integer,slot->>'start',slot->>'end'),'[]'::jsonb) INTO canonical_weekly FROM jsonb_array_elements(requested_weekly_slots) slot;
  SELECT COALESCE(jsonb_agg(CASE WHEN exception->>'type'='CLOSED' THEN jsonb_build_object('date',exception->>'date','type','CLOSED')
      ELSE jsonb_build_object('date',exception->>'date','type','REPLACE','slots',(SELECT jsonb_agg(jsonb_build_object('start',slot->>'start','end',slot->>'end') ORDER BY slot->>'start',slot->>'end') FROM jsonb_array_elements(exception->'slots') slot)) END
      ORDER BY exception->>'date'),'[]'::jsonb) INTO canonical_exceptions FROM jsonb_array_elements(requested_exceptions) exception;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(canonical_weekly) WITH ORDINALITY a(slot,n)
      JOIN jsonb_array_elements(canonical_weekly) WITH ORDINALITY b(slot,n) ON a.n<b.n
      AND a.slot->>'weekday'=b.slot->>'weekday' AND a.slot->>'start'<b.slot->>'end' AND b.slot->>'start'<a.slot->>'end')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(canonical_weekly) slot GROUP BY slot->>'weekday' HAVING count(*)>4)
    OR (SELECT count(DISTINCT exception->>'date') FROM jsonb_array_elements(canonical_exceptions) exception)<>jsonb_array_length(canonical_exceptions)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(canonical_exceptions) exception WHERE exception->>'type'='REPLACE' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(exception->'slots') WITH ORDINALITY a(slot,n)
        JOIN jsonb_array_elements(exception->'slots') WITH ORDINALITY b(slot,n) ON a.n<b.n
          AND a.slot->>'start'<b.slot->>'end' AND b.slot->>'start'<a.slot->>'end')) THEN
    RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-key:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.unit_shift_schedule_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;command_found:=FOUND;
  -- Ordem global: idempotency key -> unidade da escala -> timezone da unidade -> usuario alvo.
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-unit:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-user:'||requested_user_id::text,0));
  computed:=encode(digest(convert_to(format('{"unitId":"%s","userId":"%s","effectiveFrom":"%s","weeklySlots":%s,"exceptions":%s,"expectedVersion":%s}',
    lower(requested_unit_id::text),lower(requested_user_id::text),requested_effective_from,
    regexp_replace(canonical_weekly::text,'\s','','g'),regexp_replace(canonical_exceptions::text,'\s','','g'),requested_expected_version),'UTF8'),'sha256'),'hex');
  IF computed<>requested_fingerprint THEN RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  IF command_found THEN
    IF NOT public.current_actor_has_permission('shift.manage',command_record.unit_id) OR NOT EXISTS(SELECT 1 FROM public.user_units membership
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=command_record.tenant_id AND membership.unit_id=command_record.unit_id AND membership.user_id=command_record.user_id
        AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND account.status='ACTIVE' AND unit.active) THEN
      RAISE EXCEPTION 'SHIFT_SCHEDULE_NOT_FOUND' USING ERRCODE='P0001';END IF;
    IF command_record.unit_id<>requested_unit_id OR command_record.user_id<>requested_user_id OR command_record.effective_from<>requested_effective_from
      OR command_record.expected_version<>requested_expected_version OR command_record.weekly_slots<>canonical_weekly
      OR command_record.exceptions<>canonical_exceptions OR command_record.request_fingerprint<>computed OR command_record.actor_id<>public.current_app_actor_id() THEN
      RAISE EXCEPTION 'SHIFT_SCHEDULE_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT schedule.unit_id,schedule.user_id,schedule.version,schedule.effective_from,schedule.time_zone,
      schedule.weekly_slots,schedule.exceptions,date_trunc('milliseconds',schedule.updated_at),true FROM public.unit_shift_schedule_versions schedule
      WHERE schedule.tenant_id=command_record.tenant_id AND schedule.id=command_record.result_version_id;RETURN;
  END IF;
  SELECT configured.time_zone INTO timezone_snapshot FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=public.current_app_tenant_id() AND configured.unit_id=requested_unit_id ORDER BY configured.version DESC LIMIT 1;
  IF timezone_snapshot IS NULL THEN RAISE EXCEPTION 'SHIFT_SCHEDULE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  local_today:=(transaction_timestamp() AT TIME ZONE timezone_snapshot)::date;
  IF requested_effective_from<local_today OR requested_effective_from>local_today+365 THEN
    RAISE EXCEPTION 'INVALID_SHIFT_SCHEDULE_REQUEST' USING ERRCODE='22023';END IF;
  IF NOT public.current_actor_has_permission('shift.manage',requested_unit_id) OR NOT EXISTS(SELECT 1 FROM public.user_units membership
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.user_id=requested_user_id
        AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND account.status='ACTIVE' AND unit.active) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT COALESCE(max(schedule.version),0) INTO current_version FROM public.unit_shift_schedule_versions schedule
    WHERE schedule.tenant_id=public.current_app_tenant_id() AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id;
  IF current_version<>requested_expected_version THEN RAISE EXCEPTION 'SHIFT_SCHEDULE_CONFLICT' USING ERRCODE='P0001';END IF;
  INSERT INTO public.unit_shift_schedule_versions(id,tenant_id,unit_id,user_id,version,effective_from,time_zone,weekly_slots,exceptions,created_by_user_id,updated_at)
    VALUES(new_id,public.current_app_tenant_id(),requested_unit_id,requested_user_id,current_version+1,requested_effective_from,timezone_snapshot,canonical_weekly,canonical_exceptions,public.current_app_actor_id(),changed_at);
  INSERT INTO public.unit_shift_schedule_commands(tenant_id,idempotency_key,unit_id,user_id,effective_from,expected_version,time_zone,weekly_slots,exceptions,result_version_id,result_version,request_fingerprint,actor_id)
    VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,requested_user_id,requested_effective_from,requested_expected_version,timezone_snapshot,canonical_weekly,canonical_exceptions,new_id,current_version+1,computed,public.current_app_actor_id());
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),
    'SHIFT_SCHEDULE_PUBLISHED','unit_shift_schedule',new_id::text,jsonb_build_object('unitId',requested_unit_id,'userId',requested_user_id,'version',current_version+1,'effectiveFrom',requested_effective_from,'timeZone',timezone_snapshot));
  RETURN QUERY SELECT requested_unit_id,requested_user_id,current_version+1,requested_effective_from,timezone_snapshot,canonical_weekly,canonical_exceptions,date_trunc('milliseconds',changed_at),false;
END $$;
REVOKE ALL ON FUNCTION set_unit_shift_schedule(uuid,uuid,date,jsonb,jsonb,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_unit_shift_schedule(uuid,uuid,date,jsonb,jsonb,integer,text,text) TO zap_pronto_api;

COMMIT;
