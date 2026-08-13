BEGIN;

CREATE TABLE unit_assignment_policies(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  unit_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN('OBSERVE','ENFORCE_NEW_ASSIGNMENTS')),
  version integer NOT NULL CHECK(version>0),
  updated_by_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,unit_id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,updated_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE unit_assignment_policy_commands(
  tenant_id uuid NOT NULL REFERENCES tenants(id),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  unit_id uuid NOT NULL,requested_mode text NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  result_version integer NOT NULL,result_updated_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,idempotency_key),FOREIGN KEY(tenant_id,unit_id) REFERENCES unit_assignment_policies(tenant_id,unit_id)
);
INSERT INTO unit_assignment_policies(tenant_id,unit_id,mode,version)
SELECT unit.tenant_id,unit.id,'OBSERVE',1 FROM units unit;

ALTER TABLE unit_assignment_policies ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_assignment_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_assignment_policy_commands ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_assignment_policy_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_assignment_policies_tenant ON unit_assignment_policies USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_assignment_policy_commands_tenant ON unit_assignment_policy_commands USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_assignment_policies,unit_assignment_policy_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION ensure_unit_assignment_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  INSERT INTO public.unit_assignment_policies(tenant_id,unit_id,mode,version)
    VALUES(NEW.tenant_id,NEW.id,'OBSERVE',1) ON CONFLICT DO NOTHING;RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION ensure_unit_assignment_policy() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE TRIGGER units_ensure_assignment_policy AFTER INSERT ON units FOR EACH ROW EXECUTE FUNCTION ensure_unit_assignment_policy();

/* Internal evaluator: deliberately has no EXECUTE grant to application roles. */
CREATE FUNCTION evaluate_unit_staff_shift_internal(requested_tenant_id uuid,requested_unit_id uuid,requested_user_id uuid,requested_at timestamptz)
RETURNS TABLE(state text,schedule_version integer,effective_from date,time_zone text,local_date date,local_time text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE selected public.unit_shift_schedule_versions%ROWTYPE;local_stamp timestamp;exception jsonb;slots jsonb;inside boolean:=false;
BEGIN
  IF requested_tenant_id IS NULL OR requested_unit_id IS NULL OR requested_user_id IS NULL OR requested_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_SHIFT_EVALUATION' USING ERRCODE='22023';END IF;
  SELECT schedule.* INTO selected FROM public.unit_shift_schedule_versions schedule
  WHERE schedule.tenant_id=requested_tenant_id AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id
    AND schedule.effective_from<=(requested_at AT TIME ZONE schedule.time_zone)::date
  ORDER BY schedule.effective_from DESC,schedule.version DESC LIMIT 1;
  IF NOT FOUND THEN state:=CASE WHEN EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule WHERE schedule.tenant_id=requested_tenant_id
    AND schedule.unit_id=requested_unit_id AND schedule.user_id=requested_user_id) THEN 'NOT_EFFECTIVE' ELSE 'UNCONFIGURED' END;
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

CREATE FUNCTION assert_new_assignment_shift_internal(requested_unit_id uuid,requested_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE policy_mode text;shift_state text;
BEGIN
  PERFORM public.assert_app_context_authorized();
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':membership-lifecycle',0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-assignment-policy:'||requested_unit_id::text,0));
  SELECT policy.mode INTO policy_mode FROM public.unit_assignment_policies policy WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id;
  IF policy_mode IS NULL THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF policy_mode='OBSERVE' THEN RETURN;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-unit:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-user:'||requested_user_id::text,0));
  SELECT evaluation.state INTO shift_state FROM public.evaluate_unit_staff_shift_internal(public.current_app_tenant_id(),requested_unit_id,requested_user_id,transaction_timestamp()) evaluation;
  IF shift_state<>'IN_SHIFT' THEN RAISE EXCEPTION 'ASSIGNEE_OUTSIDE_SHIFT' USING ERRCODE='P0001';END IF;
END$$;
REVOKE ALL ON FUNCTION assert_new_assignment_shift_internal(uuid,uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION assert_actor_new_claim_shift(requested_unit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('handoff.claim',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.user_id=public.current_app_actor_id()
        AND membership.status='ACTIVE' AND account.status='ACTIVE' AND unit.active)
    THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  PERFORM public.assert_new_assignment_shift_internal(requested_unit_id,public.current_app_actor_id());
END$$;
REVOKE ALL ON FUNCTION assert_actor_new_claim_shift(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION assert_actor_new_claim_shift(uuid) TO zap_pronto_api;

CREATE OR REPLACE FUNCTION evaluate_unit_staff_shift(requested_unit_id uuid,requested_user_id uuid,requested_at timestamptz DEFAULT NULL)
RETURNS TABLE(unit_id uuid,user_id uuid,state text,schedule_version integer,effective_from date,time_zone text,local_date date,local_time text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_user_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit JOIN public.user_units membership ON membership.tenant_id=unit.tenant_id AND membership.unit_id=unit.id
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active AND membership.user_id=requested_user_id
        AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND account.status='ACTIVE')
    THEN RAISE EXCEPTION 'SHIFT_EVALUATION_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT requested_unit_id,requested_user_id,evaluation.state,evaluation.schedule_version,evaluation.effective_from,
    evaluation.time_zone,evaluation.local_date,evaluation.local_time FROM public.evaluate_unit_staff_shift_internal(public.current_app_tenant_id(),
      requested_unit_id,requested_user_id,COALESCE(requested_at,transaction_timestamp())) evaluation;
END$$;

CREATE FUNCTION get_unit_assignment_policy(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,mode text,version integer,updated_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN PERFORM public.assert_app_context_authorized();IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
  THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT policy.unit_id,policy.mode,policy.version,date_trunc('milliseconds',policy.updated_at) FROM public.unit_assignment_policies policy
    JOIN public.units unit ON unit.tenant_id=policy.tenant_id AND unit.id=policy.unit_id AND unit.active
    WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;END$$;
REVOKE ALL ON FUNCTION get_unit_assignment_policy(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;GRANT EXECUTE ON FUNCTION get_unit_assignment_policy(uuid) TO zap_pronto_api;

CREATE FUNCTION get_unit_assignment_policy_readiness(requested_unit_id uuid)
RETURNS TABLE(operational_members integer,effective_schedules integer,missing_schedules integer,timezone_configured boolean,ready boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE members integer;schedules integer;tz boolean;
BEGIN PERFORM public.assert_app_context_authorized();IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('shift.read',requested_unit_id)
  THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT count(*)::integer INTO members FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT');
  SELECT count(*)::integer INTO schedules FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    WHERE membership.tenant_id=public.current_app_tenant_id() AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE'
      AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT') AND EXISTS(SELECT 1 FROM public.unit_shift_schedule_versions schedule
        WHERE schedule.tenant_id=membership.tenant_id AND schedule.unit_id=membership.unit_id AND schedule.user_id=membership.user_id
          AND schedule.effective_from<=(transaction_timestamp() AT TIME ZONE schedule.time_zone)::date);
  SELECT EXISTS(SELECT 1 FROM public.unit_operational_timezone_versions timezone WHERE timezone.tenant_id=public.current_app_tenant_id() AND timezone.unit_id=requested_unit_id) INTO tz;
  RETURN QUERY SELECT members,schedules,members-schedules,tz,(tz AND members>0 AND members=schedules);END$$;
REVOKE ALL ON FUNCTION get_unit_assignment_policy_readiness(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;GRANT EXECUTE ON FUNCTION get_unit_assignment_policy_readiness(uuid) TO zap_pronto_api;

CREATE FUNCTION set_unit_assignment_policy(requested_unit_id uuid,requested_mode text,requested_expected_version integer,requested_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,mode text,version integer,updated_at timestamptz,replayed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_mode text:=btrim(requested_mode);normalized_key text:=btrim(requested_key);computed text;command public.unit_assignment_policy_commands%ROWTYPE;
  policy public.unit_assignment_policies%ROWTYPE;changed_at timestamptz:=transaction_timestamp();members integer;schedules integer;tz boolean;
BEGIN PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR normalized_mode NOT IN('OBSERVE','ENFORCE_NEW_ASSIGNMENTS') OR requested_expected_version IS NULL OR requested_expected_version<1
    OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'INVALID_ASSIGNMENT_POLICY_REQUEST' USING ERRCODE='P0001';END IF;
  computed:=encode(digest(convert_to(format('{"unitId":"%s","mode":"%s","expectedVersion":%s}',lower(requested_unit_id::text),normalized_mode,requested_expected_version),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed THEN RAISE EXCEPTION 'INVALID_ASSIGNMENT_POLICY_REQUEST' USING ERRCODE='P0001';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':assignment-policy-key:'||normalized_key,0));
  SELECT item.* INTO command FROM public.unit_assignment_policy_commands item WHERE item.tenant_id=public.current_app_tenant_id() AND item.idempotency_key=normalized_key;
  IF FOUND THEN IF command.unit_id<>requested_unit_id OR command.requested_mode<>normalized_mode OR command.expected_version<>requested_expected_version
      OR command.request_fingerprint<>computed THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    IF NOT public.current_actor_has_permission('shift.manage',command.unit_id) THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT command.unit_id,command.requested_mode,command.result_version,date_trunc('milliseconds',command.result_updated_at),true;RETURN;END IF;
  IF NOT public.current_actor_has_permission('shift.manage',requested_unit_id) THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':membership-lifecycle',0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-assignment-policy:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-unit:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone:'||requested_unit_id::text,0));
  SELECT item.* INTO policy FROM public.unit_assignment_policies item JOIN public.units unit ON unit.tenant_id=item.tenant_id AND unit.id=item.unit_id AND unit.active
    WHERE item.tenant_id=public.current_app_tenant_id() AND item.unit_id=requested_unit_id FOR UPDATE OF item;
  IF NOT FOUND THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF policy.version<>requested_expected_version THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_CONFLICT' USING ERRCODE='P0001';END IF;
  IF normalized_mode='ENFORCE_NEW_ASSIGNMENTS' THEN
    SELECT readiness.operational_members,readiness.effective_schedules,readiness.timezone_configured INTO members,schedules,tz FROM public.get_unit_assignment_policy_readiness(requested_unit_id) readiness;
    IF NOT tz OR members=0 OR schedules<>members THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_READY' USING ERRCODE='P0001';END IF;
  END IF;
  UPDATE public.unit_assignment_policies item SET mode=normalized_mode,version=item.version+1,updated_by_user_id=public.current_app_actor_id(),updated_at=changed_at
    WHERE item.tenant_id=policy.tenant_id AND item.unit_id=policy.unit_id RETURNING item.version INTO policy.version;
  INSERT INTO public.unit_assignment_policy_commands(tenant_id,idempotency_key,unit_id,requested_mode,expected_version,request_fingerprint,actor_id,result_version,result_updated_at)
    VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,normalized_mode,requested_expected_version,computed,public.current_app_actor_id(),policy.version,changed_at);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),
    'UNIT_ASSIGNMENT_POLICY_CHANGED','unit_assignment_policy',requested_unit_id::text,
    jsonb_build_object('unitId',requested_unit_id,'mode',normalized_mode,'version',policy.version));
  RETURN QUERY SELECT requested_unit_id,normalized_mode,policy.version,date_trunc('milliseconds',changed_at),false;END$$;
REVOKE ALL ON FUNCTION set_unit_assignment_policy(uuid,text,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;GRANT EXECUTE ON FUNCTION set_unit_assignment_policy(uuid,text,integer,text,text) TO zap_pronto_api;

/* Transfer replay remains stable; only a new assignment is gated. */
ALTER FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text) RENAME TO transfer_inbox_handoff_v0041;
REVOKE ALL ON FUNCTION transfer_inbox_handoff_v0041(uuid,integer,uuid,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE FUNCTION transfer_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,requested_target_user_id uuid,requested_reason text,requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,target_user_id uuid,handoff_version integer,conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE command_exists boolean;target_unit uuid;
BEGIN PERFORM public.assert_app_context_authorized();SELECT EXISTS(SELECT 1 FROM public.handoff_transfer_commands command WHERE command.tenant_id=public.current_app_tenant_id()
    AND command.idempotency_key=btrim(requested_key)) INTO command_exists;
  IF NOT command_exists THEN SELECT handoff.unit_id INTO target_unit FROM public.human_handoffs handoff WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id;
    IF target_unit IS NOT NULL THEN PERFORM public.assert_new_assignment_shift_internal(target_unit,requested_target_user_id);END IF;END IF;
  RETURN QUERY SELECT result.* FROM public.transfer_inbox_handoff_v0041(requested_handoff_id,requested_expected_version,requested_target_user_id,requested_reason,requested_key,requested_fingerprint) result;END$$;
REVOKE ALL ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;GRANT EXECUTE ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text) TO zap_pronto_api;

CREATE OR REPLACE FUNCTION list_inbox_handoff_transfer_candidates(requested_handoff_id uuid)
RETURNS TABLE(id uuid,display_name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT candidate.id,pg_catalog.left(candidate.display_name,160) FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.user_units membership ON membership.tenant_id=handoff.tenant_id AND membership.unit_id=handoff.unit_id AND membership.status='ACTIVE'
    AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
  JOIN public.users candidate ON candidate.tenant_id=membership.tenant_id AND candidate.id=membership.user_id AND candidate.status='ACTIVE'
  JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id AND availability.unit_id=membership.unit_id
    AND availability.user_id=membership.user_id AND availability.status='AVAILABLE'
  JOIN public.unit_assignment_policies policy ON policy.tenant_id=handoff.tenant_id AND policy.unit_id=handoff.unit_id
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id AND handoff.status='ACTIVE'
    AND handoff.assigned_user_id=public.current_app_actor_id() AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
    AND service_case.conversation_id=handoff.conversation_id AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.unit_id=handoff.unit_id AND conversation.assigned_user_id=public.current_app_actor_id()
    AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id) AND candidate.id<>public.current_app_actor_id()
    AND (SELECT count(*) FROM public.human_handoffs active WHERE active.tenant_id=availability.tenant_id AND active.unit_id=availability.unit_id
      AND active.assigned_user_id=availability.user_id AND active.status='ACTIVE')<availability.max_active
    AND (policy.mode='OBSERVE' OR (SELECT evaluation.state FROM public.evaluate_unit_staff_shift_internal(handoff.tenant_id,handoff.unit_id,candidate.id,transaction_timestamp()) evaluation)='IN_SHIFT')
  ORDER BY candidate.display_name,candidate.id
$$;
REVOKE ALL ON FUNCTION list_inbox_handoff_transfer_candidates(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;GRANT EXECUTE ON FUNCTION list_inbox_handoff_transfer_candidates(uuid) TO zap_pronto_api;

COMMIT;
