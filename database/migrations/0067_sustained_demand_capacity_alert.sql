BEGIN;

INSERT INTO app_permissions(code) VALUES('sla_alert.manage') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,'sla_alert.manage' FROM app_roles role WHERE role.code IN('UNIT_MANAGER','TENANT_ADMIN')
ON CONFLICT DO NOTHING;

CREATE TABLE unit_capacity_alert_policy_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,unit_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),enabled boolean NOT NULL,
  minimum_queued integer NOT NULL CHECK(minimum_queued BETWEEN 1 AND 100),
  sustained_minutes integer NOT NULL CHECK(sustained_minutes BETWEEN 1 AND 120),
  created_by_user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,unit_id,version),UNIQUE(tenant_id,id),UNIQUE(tenant_id,unit_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE unit_capacity_alert_policy_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL,unit_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>=0),result_policy_version_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,result_policy_version_id) REFERENCES unit_capacity_alert_policy_versions(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE unit_capacity_alert_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_policy_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_policy_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_capacity_alert_policy_versions_tenant ON unit_capacity_alert_policy_versions
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_capacity_alert_policy_commands_tenant ON unit_capacity_alert_policy_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_capacity_alert_policy_versions,unit_capacity_alert_policy_commands
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE INDEX human_handoffs_queued_demand_idx ON human_handoffs(tenant_id,unit_id,queued_at)
  WHERE status='QUEUED';

CREATE FUNCTION get_unit_available_capacity_internal(requested_tenant_id uuid,requested_unit_id uuid,requested_as_of timestamptz)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  WITH active_counts AS MATERIALIZED(
    SELECT assigned.assigned_user_id user_id,count(*)::integer active_count
    FROM public.human_handoffs assigned
    WHERE assigned.tenant_id=requested_tenant_id AND assigned.unit_id=requested_unit_id
      AND assigned.assigned_user_id IS NOT NULL AND assigned.status='ACTIVE'
    GROUP BY assigned.assigned_user_id
  )
  SELECT COALESCE(sum(greatest(availability.max_active-COALESCE(active.active_count,0),0)),0)::integer
  FROM public.attendant_unit_availability availability
  JOIN public.user_units membership ON membership.tenant_id=availability.tenant_id
    AND membership.unit_id=availability.unit_id AND membership.user_id=availability.user_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
  JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id AND account.status='ACTIVE'
  CROSS JOIN LATERAL public.evaluate_unit_staff_shift_internal(availability.tenant_id,availability.unit_id,availability.user_id,requested_as_of) shift
  LEFT JOIN active_counts active ON active.user_id=availability.user_id
  WHERE availability.tenant_id=requested_tenant_id AND availability.unit_id=requested_unit_id
    AND availability.status='AVAILABLE' AND shift.state='IN_SHIFT'
$$;
REVOKE ALL ON FUNCTION get_unit_available_capacity_internal(uuid,uuid,timestamptz)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION list_inbox_sla_alerts(requested_unit_id uuid,requested_limit integer,requested_sla_status text,
  requested_priority text,requested_as_of timestamptz,anchor_alert_rank integer DEFAULT NULL,
  anchor_priority_rank integer DEFAULT NULL,anchor_sla_due_at timestamptz DEFAULT NULL,
  anchor_queued_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL)
RETURNS TABLE(handoff_id uuid,unit_id uuid,priority text,sla_status text,sla_due_at timestamptz,queued_at timestamptz,
  age_seconds integer,available_capacity integer,acknowledged_at timestamptz,acknowledgement_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  WITH capacity AS MATERIALIZED(
    SELECT public.get_unit_available_capacity_internal(public.current_app_tenant_id(),requested_unit_id,requested_as_of) value
  )
  SELECT item.handoff_id,item.unit_id,item.priority,item.sla_status,item.sla_due_at,item.queued_at,item.age_seconds,
    capacity.value,
    item.acknowledged_at,item.acknowledgement_version
  FROM public.list_inbox_sla_alerts_v0055(requested_unit_id,requested_limit,requested_sla_status,requested_priority,
    requested_as_of,anchor_alert_rank,anchor_priority_rank,anchor_sla_due_at,anchor_queued_at,anchor_id) item
  CROSS JOIN capacity
$$;

CREATE FUNCTION get_unit_capacity_alert_policy(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,enabled boolean,minimum_queued integer,sustained_minutes integer,version integer,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('sla_alert.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
  THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT requested_unit_id,false,NULL::integer,NULL::integer,0,NULL::timestamptz
  WHERE NOT EXISTS(SELECT 1 FROM public.unit_capacity_alert_policy_versions policy
    WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id);
  RETURN QUERY SELECT policy.unit_id,policy.enabled,policy.minimum_queued,policy.sustained_minutes,policy.version,
    date_trunc('milliseconds',policy.created_at) FROM public.unit_capacity_alert_policy_versions policy
  WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id
  ORDER BY policy.version DESC LIMIT 1;
END$$;
REVOKE ALL ON FUNCTION get_unit_capacity_alert_policy(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_capacity_alert_policy(uuid) TO zap_pronto_api;

CREATE FUNCTION set_unit_capacity_alert_policy(requested_unit_id uuid,requested_enabled boolean,requested_minimum_queued integer,
  requested_sustained_minutes integer,requested_expected_version integer,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,enabled boolean,minimum_queued integer,sustained_minutes integer,version integer,updated_at timestamptz,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_idempotency_key);command_record public.unit_capacity_alert_policy_commands%ROWTYPE;
  current_version integer;new_id uuid:=gen_random_uuid();now_at timestamptz:=clock_timestamp();result_record public.unit_capacity_alert_policy_versions%ROWTYPE;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_enabled IS NULL OR requested_minimum_queued NOT BETWEEN 1 AND 100
    OR requested_sustained_minutes NOT BETWEEN 1 AND 120 OR requested_expected_version IS NULL OR requested_expected_version<0
    OR normalized_key IS NULL OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'INVALID_CAPACITY_ALERT_POLICY_REQUEST' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':capacity-alert-policy:'||requested_unit_id::text,0));
  SELECT command.* INTO command_record FROM public.unit_capacity_alert_policy_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF NOT public.current_actor_has_permission('sla_alert.manage',command_record.unit_id) THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
    SELECT * INTO result_record FROM public.unit_capacity_alert_policy_versions policy
      WHERE policy.tenant_id=command_record.tenant_id AND policy.id=command_record.result_policy_version_id;
    IF command_record.unit_id<>requested_unit_id OR command_record.expected_version<>requested_expected_version
      OR command_record.request_fingerprint<>requested_fingerprint OR command_record.actor_id<>public.current_app_actor_id()
      OR result_record.enabled<>requested_enabled OR result_record.minimum_queued<>requested_minimum_queued
      OR result_record.sustained_minutes<>requested_sustained_minutes
    THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT result_record.unit_id,result_record.enabled,result_record.minimum_queued,result_record.sustained_minutes,
      result_record.version,date_trunc('milliseconds',result_record.created_at),true;RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    OR NOT public.current_actor_has_permission('sla_alert.manage',requested_unit_id)
  THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT COALESCE(max(policy.version),0) INTO current_version FROM public.unit_capacity_alert_policy_versions policy
    WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id;
  IF current_version<>requested_expected_version THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_CONFLICT' USING ERRCODE='P0001';END IF;
  INSERT INTO public.unit_capacity_alert_policy_versions(id,tenant_id,unit_id,version,enabled,minimum_queued,sustained_minutes,created_by_user_id,created_at)
    VALUES(new_id,public.current_app_tenant_id(),requested_unit_id,current_version+1,requested_enabled,requested_minimum_queued,
      requested_sustained_minutes,public.current_app_actor_id(),now_at);
  INSERT INTO public.unit_capacity_alert_policy_commands(tenant_id,idempotency_key,unit_id,expected_version,result_policy_version_id,request_fingerprint,actor_id)
    VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,requested_expected_version,new_id,requested_fingerprint,public.current_app_actor_id());
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),'CAPACITY_ALERT_POLICY_PUBLISHED','unit_capacity_alert_policy',new_id::text,
      jsonb_build_object('unitId',requested_unit_id,'version',current_version+1,'enabled',requested_enabled,
        'minimumQueued',requested_minimum_queued,'sustainedMinutes',requested_sustained_minutes));
  RETURN QUERY SELECT requested_unit_id,requested_enabled,requested_minimum_queued,requested_sustained_minutes,current_version+1,
    date_trunc('milliseconds',now_at),false;
END$$;
REVOKE ALL ON FUNCTION set_unit_capacity_alert_policy(uuid,boolean,integer,integer,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_unit_capacity_alert_policy(uuid,boolean,integer,integer,integer,text,text) TO zap_pronto_api;

CREATE FUNCTION get_unit_capacity_alert_snapshot(requested_unit_id uuid,requested_as_of timestamptz DEFAULT transaction_timestamp())
RETURNS TABLE(unit_id uuid,policy_version integer,enabled boolean,minimum_queued integer,sustained_minutes integer,
  queued_count integer,sustained_queued_count integer,oldest_queued_at timestamptz,available_capacity integer,state text,evaluated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE policy_record record;total integer;sustained integer;oldest timestamptz;capacity integer;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_as_of IS NULL OR NOT public.current_actor_has_permission('sla_alert.read',requested_unit_id)
    OR NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
  THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT * INTO policy_record FROM public.unit_capacity_alert_policy_versions policy
    WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id ORDER BY policy.version DESC LIMIT 1;
  SELECT count(*)::integer,min(handoff.queued_at) INTO total,oldest FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id AND handoff.status='QUEUED'
      AND handoff.queued_at<=requested_as_of;
  capacity:=public.get_unit_available_capacity_internal(public.current_app_tenant_id(),requested_unit_id,requested_as_of);
  IF policy_record.id IS NULL THEN
    RETURN QUERY SELECT requested_unit_id,0,false,NULL::integer,NULL::integer,total,0,oldest,capacity,'CLEAR'::text,
      date_trunc('milliseconds',requested_as_of);RETURN;
  END IF;
  SELECT count(*)::integer INTO sustained FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id AND handoff.status='QUEUED'
      AND handoff.queued_at<=requested_as_of-make_interval(mins=>policy_record.sustained_minutes);
  RETURN QUERY SELECT requested_unit_id,policy_record.version,policy_record.enabled,policy_record.minimum_queued,
    policy_record.sustained_minutes,total,sustained,oldest,capacity,
    CASE WHEN policy_record.enabled AND sustained>=policy_record.minimum_queued AND capacity>0 THEN 'ACTIVE' ELSE 'CLEAR' END,
    date_trunc('milliseconds',requested_as_of);
END$$;
REVOKE ALL ON FUNCTION get_unit_capacity_alert_snapshot(uuid,timestamptz) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_capacity_alert_snapshot(uuid,timestamptz) TO zap_pronto_api;

COMMIT;
