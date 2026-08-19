BEGIN;

/*
 * A timestamp cannot prove which timezone version a concurrent schedule
 * publication observed.  New schedules therefore persist the exact version
 * selected under the canonical tenant:unit-timezone:<unit> fence.
 *
 * Existing rows intentionally remain NULL and fail closed.  Their causal
 * timezone version cannot be reconstructed safely from wall-clock values;
 * managers must republish them after this migration.
 */
ALTER TABLE unit_shift_schedule_versions
  ADD COLUMN operational_timezone_version_id uuid;

ALTER TABLE unit_shift_schedule_versions
  ADD CONSTRAINT unit_shift_schedule_timezone_version_fk
  FOREIGN KEY(tenant_id,unit_id,operational_timezone_version_id)
  REFERENCES unit_operational_timezone_versions(tenant_id,unit_id,id);

CREATE FUNCTION bind_shift_schedule_timezone_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE configured_id uuid;configured_time_zone text;
BEGIN
  SELECT configured.id,configured.time_zone INTO configured_id,configured_time_zone
  FROM public.unit_operational_timezone_versions configured
  WHERE configured.tenant_id=NEW.tenant_id AND configured.unit_id=NEW.unit_id
  ORDER BY configured.version DESC LIMIT 1;
  IF configured_id IS NULL OR configured_time_zone<>NEW.time_zone THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_TIMEZONE_NOT_CONFIGURED' USING ERRCODE='23503';
  END IF;
  NEW.operational_timezone_version_id:=configured_id;
  RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION bind_shift_schedule_timezone_version()
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE TRIGGER unit_shift_schedule_bind_timezone_version
  BEFORE INSERT ON unit_shift_schedule_versions
  FOR EACH ROW EXECUTE FUNCTION bind_shift_schedule_timezone_version();

CREATE OR REPLACE FUNCTION evaluate_unit_staff_shift_internal(requested_tenant_id uuid,requested_unit_id uuid,requested_user_id uuid,requested_at timestamptz)
RETURNS TABLE(state text,schedule_version integer,effective_from date,time_zone text,local_date date,local_time text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE selected public.unit_shift_schedule_versions%ROWTYPE;current_time_zone text;current_timezone_version_id uuid;local_stamp timestamp;
  exception jsonb;slots jsonb;inside boolean:=false;
BEGIN
  IF requested_tenant_id IS NULL OR requested_unit_id IS NULL OR requested_user_id IS NULL OR requested_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_SHIFT_EVALUATION' USING ERRCODE='22023';END IF;
  SELECT configured.time_zone,configured.id INTO current_time_zone,current_timezone_version_id
  FROM public.unit_operational_timezone_versions configured
  WHERE configured.tenant_id=requested_tenant_id AND configured.unit_id=requested_unit_id
  ORDER BY configured.version DESC LIMIT 1;
  IF current_time_zone IS NULL THEN
    state:='UNCONFIGURED';schedule_version:=NULL;effective_from:=NULL;time_zone:=NULL;
    local_date:=NULL;local_time:=NULL;RETURN NEXT;RETURN;END IF;
  SELECT schedule.* INTO selected FROM public.unit_shift_schedule_versions schedule
  WHERE schedule.tenant_id=requested_tenant_id AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id
    AND schedule.operational_timezone_version_id=current_timezone_version_id
    AND schedule.effective_from<=(requested_at AT TIME ZONE current_time_zone)::date
  ORDER BY schedule.effective_from DESC,schedule.version DESC LIMIT 1;
  IF NOT FOUND THEN
    state:=CASE WHEN EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
      WHERE schedule.tenant_id=requested_tenant_id AND schedule.unit_id=requested_unit_id
        AND schedule.user_id=requested_user_id AND schedule.operational_timezone_version_id=current_timezone_version_id)
      THEN 'NOT_EFFECTIVE' ELSE 'UNCONFIGURED' END;
    schedule_version:=NULL;effective_from:=NULL;time_zone:=NULL;local_date:=NULL;local_time:=NULL;RETURN NEXT;RETURN;END IF;
  local_stamp:=requested_at AT TIME ZONE selected.time_zone;
  SELECT item INTO exception FROM jsonb_array_elements(selected.exceptions) item WHERE item->>'date'=local_stamp::date::text LIMIT 1;
  IF exception->>'type'='CLOSED' THEN state:='CLOSED';ELSE
    slots:=CASE WHEN exception->>'type'='REPLACE' THEN exception->'slots' ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('start',item->>'start','end',item->>'end'))
      FROM jsonb_array_elements(selected.weekly_slots) item WHERE (item->>'weekday')::integer=extract(isodow FROM local_stamp)::integer),'[]'::jsonb) END;
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(slots) item WHERE local_stamp::time>=(item->>'start')::time AND local_stamp::time<(item->>'end')::time) INTO inside;
    state:=CASE WHEN inside THEN 'IN_SHIFT' ELSE 'OUTSIDE_SHIFT' END;END IF;
  schedule_version:=selected.version;effective_from:=selected.effective_from;time_zone:=selected.time_zone;local_date:=local_stamp::date;
  local_time:=to_char(local_stamp,'HH24:MI:SS');RETURN NEXT;
END$$;
REVOKE ALL ON FUNCTION evaluate_unit_staff_shift_internal(uuid,uuid,uuid,timestamptz)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION get_unit_assignment_policy_readiness(requested_unit_id uuid)
RETURNS TABLE(operational_members integer,effective_schedules integer,missing_schedules integer,timezone_configured boolean,ready boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE members integer;schedules integer;tz text;timezone_version_id uuid;
BEGIN PERFORM public.assert_app_context_authorized();IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
  THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT configured.time_zone,configured.id INTO tz,timezone_version_id FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=public.current_app_tenant_id() AND configured.unit_id=requested_unit_id ORDER BY configured.version DESC LIMIT 1;
  SELECT count(*)::integer INTO members FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT');
  SELECT count(*)::integer INTO schedules FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
        WHERE schedule.tenant_id=membership.tenant_id AND schedule.unit_id=membership.unit_id AND schedule.user_id=membership.user_id
          AND schedule.operational_timezone_version_id=timezone_version_id
          AND schedule.effective_from<=(transaction_timestamp() AT TIME ZONE tz)::date);
  RETURN QUERY SELECT members,schedules,members-schedules,(tz IS NOT NULL),(tz IS NOT NULL AND members>0 AND members=schedules);END$$;
REVOKE ALL ON FUNCTION get_unit_assignment_policy_readiness(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_assignment_policy_readiness(uuid) TO zap_pronto_api;

COMMIT;
