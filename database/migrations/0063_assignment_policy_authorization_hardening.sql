BEGIN;

CREATE OR REPLACE FUNCTION set_unit_assignment_policy(requested_unit_id uuid,requested_mode text,requested_expected_version integer,requested_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,mode text,version integer,updated_at timestamptz,replayed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_mode text:=btrim(requested_mode);normalized_key text:=btrim(requested_key);computed text;command public.unit_assignment_policy_commands%ROWTYPE;
  policy public.unit_assignment_policies%ROWTYPE;changed_at timestamptz:=transaction_timestamp();members integer;schedules integer;tz boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR normalized_mode NOT IN('OBSERVE','ENFORCE_NEW_ASSIGNMENTS') OR requested_expected_version IS NULL OR requested_expected_version<1
    OR length(normalized_key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'INVALID_ASSIGNMENT_POLICY_REQUEST' USING ERRCODE='P0001';END IF;
  computed:=encode(digest(convert_to(format('{"unitId":"%s","mode":"%s","expectedVersion":%s}',lower(requested_unit_id::text),normalized_mode,requested_expected_version),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed THEN RAISE EXCEPTION 'INVALID_ASSIGNMENT_POLICY_REQUEST' USING ERRCODE='P0001';END IF;

  /* Authorization and membership lifecycle share this tenant fence.  The
     permission check must happen after it, including on replay. */
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':membership-lifecycle',0));
  IF NOT public.current_actor_has_permission('shift.manage',requested_unit_id) THEN
    RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':assignment-policy-key:'||normalized_key,0));
  SELECT item.* INTO command FROM public.unit_assignment_policy_commands item
    WHERE item.tenant_id=public.current_app_tenant_id() AND item.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command.unit_id<>requested_unit_id OR command.requested_mode<>normalized_mode OR command.expected_version<>requested_expected_version
      OR command.request_fingerprint<>computed OR command.actor_id<>public.current_app_actor_id() THEN
      RAISE EXCEPTION 'ASSIGNMENT_POLICY_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT command.unit_id,command.requested_mode,command.result_version,date_trunc('milliseconds',command.result_updated_at),true;RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-assignment-policy:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':shift-unit:'||requested_unit_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':unit-timezone:'||requested_unit_id::text,0));
  SELECT item.* INTO policy FROM public.unit_assignment_policies item JOIN public.units unit ON unit.tenant_id=item.tenant_id AND unit.id=item.unit_id AND unit.active
    WHERE item.tenant_id=public.current_app_tenant_id() AND item.unit_id=requested_unit_id FOR UPDATE OF item;
  IF NOT FOUND THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  IF policy.version<>requested_expected_version THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_CONFLICT' USING ERRCODE='P0001';END IF;
  IF normalized_mode='ENFORCE_NEW_ASSIGNMENTS' THEN
    SELECT readiness.operational_members,readiness.effective_schedules,readiness.timezone_configured INTO members,schedules,tz
      FROM public.get_unit_assignment_policy_readiness(requested_unit_id) readiness;
    IF NOT tz OR members=0 OR schedules<>members THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_NOT_READY' USING ERRCODE='P0001';END IF;
  END IF;
  UPDATE public.unit_assignment_policies item SET mode=normalized_mode,version=item.version+1,updated_by_user_id=public.current_app_actor_id(),updated_at=changed_at
    WHERE item.tenant_id=policy.tenant_id AND item.unit_id=policy.unit_id RETURNING item.version INTO policy.version;
  INSERT INTO public.unit_assignment_policy_commands(tenant_id,idempotency_key,unit_id,requested_mode,expected_version,request_fingerprint,actor_id,result_version,result_updated_at)
    VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,normalized_mode,requested_expected_version,computed,public.current_app_actor_id(),policy.version,changed_at);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),'UNIT_ASSIGNMENT_POLICY_CHANGED','unit_assignment_policy',requested_unit_id::text,
      jsonb_build_object('unitId',requested_unit_id,'mode',normalized_mode,'version',policy.version));
  RETURN QUERY SELECT requested_unit_id,normalized_mode,policy.version,date_trunc('milliseconds',changed_at),false;
END$$;

REVOKE ALL ON FUNCTION set_unit_assignment_policy(uuid,text,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_unit_assignment_policy(uuid,text,integer,text,text) TO zap_pronto_api;

COMMIT;
