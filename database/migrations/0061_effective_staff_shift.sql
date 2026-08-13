BEGIN;

CREATE FUNCTION evaluate_unit_staff_shift(requested_unit_id uuid,requested_user_id uuid,requested_at timestamptz DEFAULT NULL)
RETURNS TABLE(unit_id uuid,user_id uuid,state text,schedule_version integer,effective_from date,time_zone text,local_date date,local_time text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE instant timestamptz:=COALESCE(requested_at,transaction_timestamp());selected public.unit_shift_schedule_versions%ROWTYPE;
  local_stamp timestamp;exception jsonb;slots jsonb;inside boolean:=false;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_user_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit JOIN public.user_units membership
      ON membership.tenant_id=unit.tenant_id AND membership.unit_id=unit.id
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active
        AND membership.user_id=requested_user_id AND membership.status='ACTIVE'
        AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND account.status='ACTIVE') THEN
    RAISE EXCEPTION 'SHIFT_EVALUATION_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  SELECT schedule.* INTO selected FROM public.unit_shift_schedule_versions schedule
    WHERE schedule.tenant_id=public.current_app_tenant_id() AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id
      AND schedule.effective_from<=(instant AT TIME ZONE schedule.time_zone)::date
    ORDER BY schedule.effective_from DESC,schedule.version DESC LIMIT 1;
  IF NOT FOUND THEN
    unit_id:=requested_unit_id;user_id:=requested_user_id;state:=CASE WHEN EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
      WHERE schedule.tenant_id=public.current_app_tenant_id() AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id)
      THEN 'NOT_EFFECTIVE' ELSE 'UNCONFIGURED' END;
    schedule_version:=NULL;effective_from:=NULL;time_zone:=NULL;local_date:=NULL;local_time:=NULL;RETURN NEXT;RETURN;
  END IF;
  local_stamp:=instant AT TIME ZONE selected.time_zone;
  SELECT item INTO exception FROM jsonb_array_elements(selected.exceptions) item WHERE item->>'date'=local_stamp::date::text LIMIT 1;
  IF exception->>'type'='CLOSED' THEN state:='CLOSED';
  ELSE
    slots:=CASE WHEN exception->>'type'='REPLACE' THEN exception->'slots' ELSE
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',item->>'start','end',item->>'end')) FROM jsonb_array_elements(selected.weekly_slots) item
        WHERE (item->>'weekday')::integer=extract(isodow FROM local_stamp)::integer),'[]'::jsonb) END;
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(slots) item WHERE local_stamp::time>=(item->>'start')::time
      AND local_stamp::time<(item->>'end')::time) INTO inside;
    state:=CASE WHEN inside THEN 'IN_SHIFT' ELSE 'OUTSIDE_SHIFT' END;
  END IF;
  unit_id:=selected.unit_id;user_id:=selected.user_id;schedule_version:=selected.version;effective_from:=selected.effective_from;
  time_zone:=selected.time_zone;local_date:=local_stamp::date;local_time:=to_char(local_stamp,'HH24:MI:SS');RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION evaluate_unit_staff_shift(uuid,uuid,timestamptz) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION evaluate_unit_staff_shift(uuid,uuid,timestamptz) TO zap_pronto_api;

COMMIT;
