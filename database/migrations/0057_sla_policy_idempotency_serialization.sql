BEGIN;

CREATE OR REPLACE FUNCTION set_unit_sla_policy(requested_unit_id uuid,requested_expected_version integer,requested_targets jsonb,
  requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,version integer,effective_at timestamptz,targets jsonb,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE normalized_key text:=btrim(requested_idempotency_key);command_record public.unit_sla_policy_publish_commands%ROWTYPE;
  current_version integer;new_id uuid:=gen_random_uuid();now_at timestamptz:=clock_timestamp();canonical_targets jsonb;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_expected_version IS NULL OR requested_expected_version<0
    OR normalized_key IS NULL OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR requested_fingerprint IS NULL OR requested_fingerprint!~'^[0-9a-f]{64}$'
    OR jsonb_typeof(requested_targets)<>'array' OR jsonb_array_length(requested_targets)<>4
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested_targets) item
      WHERE jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2
        OR item->>'priority' NOT IN('LOW','NORMAL','HIGH','URGENT') OR (item->>'targetMinutes')!~'^[0-9]+$'
        OR (item->>'targetMinutes')::integer NOT BETWEEN 1 AND 10080)
    OR (SELECT count(DISTINCT item->>'priority') FROM jsonb_array_elements(requested_targets) item)<>4 THEN
    RAISE EXCEPTION 'INVALID_SLA_POLICY_REQUEST' USING ERRCODE='22023';END IF;
  SELECT jsonb_agg(jsonb_build_object('priority',item->>'priority','targetMinutes',(item->>'targetMinutes')::integer)
    ORDER BY CASE item->>'priority' WHEN 'LOW' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'HIGH' THEN 3 ELSE 4 END)
    INTO canonical_targets FROM jsonb_array_elements(requested_targets) item;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':sla-policy-key:'||normalized_key,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':sla-policy:'||requested_unit_id::text,0));
  SELECT command.* INTO command_record FROM public.unit_sla_policy_publish_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF NOT public.current_actor_has_permission('sla_policy.manage',command_record.unit_id) THEN RAISE EXCEPTION 'SLA_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
    IF command_record.unit_id<>requested_unit_id OR command_record.expected_version<>requested_expected_version
      OR command_record.request_fingerprint<>requested_fingerprint OR command_record.actor_id<>public.current_app_actor_id()
      OR command_record.targets<>canonical_targets THEN RAISE EXCEPTION 'SLA_POLICY_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';END IF;
    RETURN QUERY SELECT policy.unit_id,policy.version,date_trunc('milliseconds',policy.effective_at),command_record.targets,true
      FROM public.unit_sla_policy_versions policy WHERE policy.tenant_id=command_record.tenant_id AND policy.id=command_record.result_policy_version_id;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=requested_unit_id AND unit.active)
    OR NOT public.current_actor_has_permission('sla_policy.manage',requested_unit_id) THEN RAISE EXCEPTION 'SLA_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  SELECT COALESCE(max(policy.version),0) INTO current_version FROM public.unit_sla_policy_versions policy
    WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id;
  IF current_version<>requested_expected_version THEN RAISE EXCEPTION 'SLA_POLICY_CONFLICT' USING ERRCODE='P0001';END IF;
  INSERT INTO public.unit_sla_policy_versions(id,tenant_id,unit_id,version,effective_at,created_by_user_id)
    VALUES(new_id,public.current_app_tenant_id(),requested_unit_id,current_version+1,now_at,public.current_app_actor_id());
  INSERT INTO public.unit_sla_policy_targets(tenant_id,policy_version_id,priority,target_minutes)
    SELECT public.current_app_tenant_id(),new_id,item->>'priority',(item->>'targetMinutes')::integer FROM jsonb_array_elements(requested_targets) item;
  INSERT INTO public.unit_sla_policy_publish_commands(tenant_id,idempotency_key,unit_id,expected_version,result_policy_version_id,
    result_version,targets,request_fingerprint,actor_id) VALUES(public.current_app_tenant_id(),normalized_key,requested_unit_id,
    requested_expected_version,new_id,current_version+1,canonical_targets,requested_fingerprint,public.current_app_actor_id());
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(public.current_app_tenant_id(),'USER',public.current_app_actor_id(),'SLA_POLICY_PUBLISHED','unit_sla_policy',new_id::text,
      jsonb_build_object('unitId',requested_unit_id,'policyVersion',current_version+1,'targets',canonical_targets));
  RETURN QUERY SELECT requested_unit_id,current_version+1,date_trunc('milliseconds',now_at),canonical_targets,false;
END $$;
REVOKE ALL ON FUNCTION set_unit_sla_policy(uuid,integer,jsonb,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_unit_sla_policy(uuid,integer,jsonb,text,text) TO zap_pronto_api;

COMMIT;
