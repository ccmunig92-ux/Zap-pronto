BEGIN;

/*
 * An effective schedule is valid only while its timezone snapshot matches the
 * unit's latest operational timezone.  A timezone change therefore fails
 * closed until every operational member has a newly published schedule.
 */
CREATE OR REPLACE FUNCTION evaluate_unit_staff_shift_internal(requested_tenant_id uuid,requested_unit_id uuid,requested_user_id uuid,requested_at timestamptz)
RETURNS TABLE(state text,schedule_version integer,effective_from date,time_zone text,local_date date,local_time text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE selected public.unit_shift_schedule_versions%ROWTYPE;current_time_zone text;current_time_zone_updated_at timestamptz;local_stamp timestamp;
  exception jsonb;slots jsonb;inside boolean:=false;
BEGIN
  IF requested_tenant_id IS NULL OR requested_unit_id IS NULL OR requested_user_id IS NULL OR requested_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_SHIFT_EVALUATION' USING ERRCODE='22023';END IF;
  SELECT configured.time_zone,configured.updated_at INTO current_time_zone,current_time_zone_updated_at FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=requested_tenant_id AND configured.unit_id=requested_unit_id
    ORDER BY configured.version DESC LIMIT 1;
  IF current_time_zone IS NULL THEN
    state:='UNCONFIGURED';schedule_version:=NULL;effective_from:=NULL;time_zone:=NULL;
    local_date:=NULL;local_time:=NULL;RETURN NEXT;RETURN;END IF;
  SELECT schedule.* INTO selected FROM public.unit_shift_schedule_versions schedule
    WHERE schedule.tenant_id=requested_tenant_id AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id
      AND schedule.time_zone=current_time_zone
      AND schedule.updated_at>=current_time_zone_updated_at
      AND schedule.effective_from<=(requested_at AT TIME ZONE current_time_zone)::date
    ORDER BY schedule.effective_from DESC,schedule.version DESC LIMIT 1;
  IF NOT FOUND THEN
    state:=CASE WHEN EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
      WHERE schedule.tenant_id=requested_tenant_id AND schedule.unit_id=requested_unit_id
        AND schedule.user_id=requested_user_id AND schedule.time_zone=current_time_zone
        AND schedule.updated_at>=current_time_zone_updated_at)
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
REVOKE ALL ON FUNCTION evaluate_unit_staff_shift_internal(uuid,uuid,uuid,timestamptz) FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION get_unit_assignment_policy_readiness(requested_unit_id uuid)
RETURNS TABLE(operational_members integer,effective_schedules integer,missing_schedules integer,timezone_configured boolean,ready boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE members integer;schedules integer;tz text;tz_updated_at timestamptz;
BEGIN PERFORM public.assert_app_context_authorized();IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
  THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT configured.time_zone,configured.updated_at INTO tz,tz_updated_at FROM public.unit_operational_timezone_versions configured
    WHERE configured.tenant_id=public.current_app_tenant_id() AND configured.unit_id=requested_unit_id ORDER BY configured.version DESC LIMIT 1;
  SELECT count(*)::integer INTO members FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT');
  SELECT count(*)::integer INTO schedules FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
        WHERE schedule.tenant_id=membership.tenant_id AND schedule.unit_id=membership.unit_id AND schedule.user_id=membership.user_id
          AND schedule.time_zone=tz AND schedule.updated_at>=tz_updated_at
          AND schedule.effective_from<=(transaction_timestamp() AT TIME ZONE tz)::date);
  RETURN QUERY SELECT members,schedules,members-schedules,(tz IS NOT NULL),(tz IS NOT NULL AND members>0 AND members=schedules);END$$;
REVOKE ALL ON FUNCTION get_unit_assignment_policy_readiness(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_assignment_policy_readiness(uuid) TO zap_pronto_api;

/* Serialize a status transition before the membership row changes. */
CREATE FUNCTION lock_membership_availability_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':membership-lifecycle',0));
  END IF;RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION lock_membership_availability_transition() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE TRIGGER user_units_lock_availability_transition BEFORE UPDATE OF status ON user_units
  FOR EACH ROW EXECUTE FUNCTION lock_membership_availability_transition();

CREATE OR REPLACE FUNCTION ensure_membership_availability() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.status='ACTIVE' THEN
    INSERT INTO public.attendant_unit_availability(tenant_id,user_id,unit_id,status,max_active)
      VALUES(NEW.tenant_id,NEW.user_id,NEW.unit_id,'OFFLINE',100)
    ON CONFLICT(tenant_id,user_id,unit_id) DO NOTHING;
  ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM 'ACTIVE' AND NEW.status='ACTIVE' THEN
    INSERT INTO public.attendant_unit_availability(tenant_id,user_id,unit_id,status,max_active)
      VALUES(NEW.tenant_id,NEW.user_id,NEW.unit_id,'OFFLINE',100)
    ON CONFLICT(tenant_id,user_id,unit_id) DO UPDATE SET status='OFFLINE',max_active=100,
      pause_reason=NULL,paused_until=NULL,version=public.attendant_unit_availability.version+1,updated_at=clock_timestamp()
    ;
  END IF;RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION ensure_membership_availability() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

/* Keep the team cursor stable across database locales. */
CREATE OR REPLACE FUNCTION list_unit_team_availability(requested_unit_id uuid,requested_limit integer,requested_status text DEFAULT NULL,
  anchor_display_name text DEFAULT NULL,anchor_user_id uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid,display_name text,role text,status text,max_active integer,active_count integer,
  remaining_capacity integer,pause_reason text,paused_until timestamptz,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101
    OR (requested_status IS NOT NULL AND requested_status NOT IN('AVAILABLE','PAUSED','OFFLINE'))
    OR ((anchor_display_name IS NULL)<>(anchor_user_id IS NULL))
    OR (anchor_display_name IS NOT NULL AND length(anchor_display_name) NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'INVALID_TEAM_AVAILABILITY_REQUEST' USING ERRCODE='22023';END IF;
  IF NOT public.current_actor_has_permission('availability.supervise',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.tenants tenant JOIN public.units unit ON unit.tenant_id=tenant.id
      WHERE tenant.id=public.current_app_tenant_id() AND tenant.status='ACTIVE'
        AND unit.id=requested_unit_id AND unit.active) THEN
    RAISE EXCEPTION 'TEAM_AVAILABILITY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF anchor_user_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.user_units membership
    JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id
      AND availability.unit_id=membership.unit_id AND availability.user_id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id
      AND membership.user_id=anchor_user_id AND membership.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
      AND account.status='ACTIVE' AND account.display_name=anchor_display_name
      AND (requested_status IS NULL OR availability.status=requested_status)) THEN
    RAISE EXCEPTION 'TEAM_AVAILABILITY_CURSOR_INVALID' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT account.id,pg_catalog.left(account.display_name,160),membership.role::text,availability.status,
    availability.max_active,count(handoff.id)::integer,
    greatest(availability.max_active-count(handoff.id)::integer,0),availability.pause_reason,
    availability.paused_until,availability.updated_at
  FROM public.user_units membership
  JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
  JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id
    AND availability.unit_id=membership.unit_id AND availability.user_id=membership.user_id
  LEFT JOIN public.human_handoffs handoff ON handoff.tenant_id=membership.tenant_id AND handoff.unit_id=membership.unit_id
    AND handoff.assigned_user_id=membership.user_id AND handoff.status='ACTIVE'
  WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
    AND account.status='ACTIVE' AND (requested_status IS NULL OR availability.status=requested_status)
    AND (anchor_user_id IS NULL OR (lower(account.display_name) COLLATE "C",account.display_name COLLATE "C",account.id)>
      (lower(anchor_display_name) COLLATE "C",anchor_display_name COLLATE "C",anchor_user_id))
  GROUP BY account.id,account.display_name,membership.role,availability.status,availability.max_active,
    availability.pause_reason,availability.paused_until,availability.updated_at
  ORDER BY lower(account.display_name) COLLATE "C",account.display_name COLLATE "C",account.id LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_unit_team_availability(uuid,integer,text,text,uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_unit_team_availability(uuid,integer,text,text,uuid) TO zap_pronto_api;

COMMIT;
