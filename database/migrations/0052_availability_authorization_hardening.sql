BEGIN;

ALTER FUNCTION get_actor_unit_availability(uuid)
  RENAME TO get_actor_unit_availability_v0051;
REVOKE ALL ON FUNCTION get_actor_unit_availability_v0051(uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION get_actor_unit_availability(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,user_id uuid,status text,max_active integer,pause_reason text,paused_until timestamptz,
  active_count integer,version integer,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.tenants tenant
    JOIN public.users account ON account.tenant_id=tenant.id
    JOIN public.user_units membership ON membership.tenant_id=account.tenant_id AND membership.user_id=account.id
    JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
    WHERE tenant.id=public.current_app_tenant_id() AND tenant.status='ACTIVE'
      AND account.id=public.current_app_actor_id() AND account.status='ACTIVE'
      AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND unit.active
  ) THEN
    RAISE EXCEPTION 'AVAILABILITY_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT availability.unit_id,availability.user_id,availability.status,availability.max_active,
    availability.pause_reason,availability.paused_until,availability.active_count,availability.version,
    availability.updated_at
  FROM public.get_actor_unit_availability_v0051(requested_unit_id) availability;
END $$;
REVOKE ALL ON FUNCTION get_actor_unit_availability(uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_actor_unit_availability(uuid) TO zap_pronto_api;

ALTER FUNCTION set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text)
  RENAME TO set_actor_unit_availability_v0051;
REVOKE ALL ON FUNCTION set_actor_unit_availability_v0051(uuid,text,integer,text,timestamptz,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION set_actor_unit_availability(requested_unit_id uuid,requested_status text,requested_max_active integer,
  requested_pause_reason text,requested_paused_until timestamptz,requested_expected_version integer,
  requested_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,user_id uuid,status text,max_active integer,pause_reason text,paused_until timestamptz,
  active_count integer,version integer,updated_at timestamptz,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.tenants tenant
    JOIN public.users account ON account.tenant_id=tenant.id
    JOIN public.user_units membership ON membership.tenant_id=account.tenant_id AND membership.user_id=account.id
    JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
    WHERE tenant.id=public.current_app_tenant_id() AND tenant.status='ACTIVE'
      AND account.id=public.current_app_actor_id() AND account.status='ACTIVE'
      AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE' AND unit.active
  ) THEN
    RAISE EXCEPTION 'AVAILABILITY_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT result.unit_id,result.user_id,result.status,result.max_active,result.pause_reason,
    result.paused_until,result.active_count,result.version,result.updated_at,result.replayed
  FROM public.set_actor_unit_availability_v0051(requested_unit_id,requested_status,requested_max_active,
    requested_pause_reason,requested_paused_until,requested_expected_version,requested_key,requested_fingerprint) result;
END $$;
REVOKE ALL ON FUNCTION set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text) TO zap_pronto_api;

CREATE OR REPLACE FUNCTION list_inbox_handoff_transfer_candidates(requested_handoff_id uuid)
RETURNS TABLE(id uuid,display_name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT candidate.id,pg_catalog.left(candidate.display_name,160) FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.user_units membership ON membership.tenant_id=handoff.tenant_id AND membership.unit_id=handoff.unit_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
  JOIN public.users candidate ON candidate.tenant_id=membership.tenant_id AND candidate.id=membership.user_id AND candidate.status='ACTIVE'
  JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id AND availability.unit_id=membership.unit_id
    AND availability.user_id=membership.user_id AND availability.status='AVAILABLE'
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id AND handoff.status='ACTIVE'
    AND handoff.assigned_user_id=public.current_app_actor_id() AND service_case.status='IN_REVIEW'
    AND service_case.unit_id=handoff.unit_id AND service_case.conversation_id=handoff.conversation_id
    AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.unit_id=handoff.unit_id AND conversation.assigned_user_id=public.current_app_actor_id()
    AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id)
    AND candidate.id<>public.current_app_actor_id() AND (SELECT count(*) FROM public.human_handoffs active
      WHERE active.tenant_id=availability.tenant_id AND active.unit_id=availability.unit_id
        AND active.assigned_user_id=availability.user_id AND active.status='ACTIVE')<availability.max_active
  ORDER BY candidate.display_name,candidate.id
$$;
REVOKE ALL ON FUNCTION list_inbox_handoff_transfer_candidates(uuid)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_handoff_transfer_candidates(uuid) TO zap_pronto_api;

COMMIT;
