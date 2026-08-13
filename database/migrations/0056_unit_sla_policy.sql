BEGIN;

INSERT INTO app_permissions(code) VALUES('sla_policy.read'),('sla_policy.manage') ON CONFLICT(code) DO NOTHING;
INSERT INTO app_role_permissions(role_code,permission_code)
SELECT role.code,permission.code FROM app_roles role CROSS JOIN app_permissions permission
WHERE (permission.code='sla_policy.read' AND role.code IN('SUPERVISOR','UNIT_MANAGER','TENANT_ADMIN'))
   OR (permission.code='sla_policy.manage' AND role.code IN('UNIT_MANAGER','TENANT_ADMIN'))
ON CONFLICT DO NOTHING;

CREATE TABLE unit_sla_policy_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,unit_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,unit_id,version),UNIQUE(tenant_id,id),UNIQUE(tenant_id,unit_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE unit_sla_policy_targets(
  tenant_id uuid NOT NULL,policy_version_id uuid NOT NULL,priority text NOT NULL
    CHECK(priority IN('LOW','NORMAL','HIGH','URGENT')),
  target_minutes integer NOT NULL CHECK(target_minutes BETWEEN 1 AND 10080),
  PRIMARY KEY(tenant_id,policy_version_id,priority),
  FOREIGN KEY(tenant_id,policy_version_id) REFERENCES unit_sla_policy_versions(tenant_id,id)
);
CREATE TABLE unit_sla_policy_publish_commands(
  tenant_id uuid NOT NULL,idempotency_key text NOT NULL,unit_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>=0),
  result_policy_version_id uuid NOT NULL,result_version integer NOT NULL CHECK(result_version>0),targets jsonb NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,result_policy_version_id) REFERENCES unit_sla_policy_versions(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE unit_sla_policy_versions ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_sla_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_sla_policy_targets ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_sla_policy_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_sla_policy_publish_commands ENABLE ROW LEVEL SECURITY;ALTER TABLE unit_sla_policy_publish_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_sla_policy_versions_tenant ON unit_sla_policy_versions USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_sla_policy_targets_tenant ON unit_sla_policy_targets USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_sla_policy_commands_tenant ON unit_sla_policy_publish_commands USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_sla_policy_versions,unit_sla_policy_targets,unit_sla_policy_publish_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

ALTER TABLE human_handoffs ADD COLUMN sla_policy_version_id uuid NULL;
ALTER TABLE human_handoffs ADD CONSTRAINT human_handoffs_sla_policy_version_fk
  FOREIGN KEY(tenant_id,unit_id,sla_policy_version_id) REFERENCES unit_sla_policy_versions(tenant_id,unit_id,id);

CREATE FUNCTION get_unit_sla_policy(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,version integer,effective_at timestamptz,targets jsonb,replayed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR NOT public.current_actor_has_permission('sla_policy.read',requested_unit_id) THEN
    RAISE EXCEPTION 'SLA_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT policy.unit_id,policy.version,date_trunc('milliseconds',policy.effective_at),
    jsonb_agg(jsonb_build_object('priority',target.priority,'targetMinutes',target.target_minutes)
      ORDER BY CASE target.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END),false
  FROM public.unit_sla_policy_versions policy JOIN public.unit_sla_policy_targets target
    ON target.tenant_id=policy.tenant_id AND target.policy_version_id=policy.id
  WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id
    AND policy.version=(SELECT max(latest.version) FROM public.unit_sla_policy_versions latest
      WHERE latest.tenant_id=policy.tenant_id AND latest.unit_id=policy.unit_id)
  GROUP BY policy.unit_id,policy.version,policy.effective_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'SLA_POLICY_NOT_FOUND' USING ERRCODE='P0001';END IF;
END $$;
REVOKE ALL ON FUNCTION get_unit_sla_policy(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_unit_sla_policy(uuid) TO zap_pronto_api;

CREATE FUNCTION set_unit_sla_policy(requested_unit_id uuid,requested_expected_version integer,requested_targets jsonb,
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

CREATE FUNCTION resolve_unit_sla_policy_target(requested_unit_id uuid,requested_priority text)
RETURNS TABLE(policy_version_id uuid,target_minutes integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_priority NOT IN('LOW','NORMAL','HIGH','URGENT') THEN
    RAISE EXCEPTION 'INVALID_SLA_POLICY_TARGET_REQUEST' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':sla-policy:'||requested_unit_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM public.units unit WHERE unit.tenant_id=public.current_app_tenant_id()
    AND unit.id=requested_unit_id AND unit.active) THEN
    RAISE EXCEPTION 'SLA_POLICY_TARGET_NOT_FOUND' USING ERRCODE='P0001';END IF;
  RETURN QUERY SELECT policy.id,target.target_minutes
  FROM public.unit_sla_policy_versions policy JOIN public.unit_sla_policy_targets target
    ON target.tenant_id=policy.tenant_id AND target.policy_version_id=policy.id
  WHERE policy.tenant_id=public.current_app_tenant_id() AND policy.unit_id=requested_unit_id
    AND target.priority=requested_priority
  ORDER BY policy.version DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION resolve_unit_sla_policy_target(uuid,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_unit_sla_policy_target(uuid,text) TO zap_pronto_api;

ALTER FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) RENAME TO reopen_inbox_handoff_v0050;
REVOKE ALL ON FUNCTION reopen_inbox_handoff_v0050(uuid,integer,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE FUNCTION reopen_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,requested_reason text,
  requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(source_handoff_id uuid,handoff_id uuid,conversation_id uuid,service_case_id uuid,handoff_version integer,
  conversation_version integer,service_case_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE result record;policy_id uuid;target integer;
BEGIN
  SELECT * INTO result FROM public.reopen_inbox_handoff_v0050(requested_handoff_id,requested_expected_version,requested_reason,requested_idempotency_key,requested_fingerprint);
  IF NOT result.replayed THEN
    SELECT policy.id,t.target_minutes INTO policy_id,target FROM public.human_handoffs h
      JOIN LATERAL(SELECT p.id FROM public.unit_sla_policy_versions p WHERE p.tenant_id=h.tenant_id AND p.unit_id=h.unit_id ORDER BY p.version DESC LIMIT 1) policy ON true
      JOIN public.unit_sla_policy_targets t ON t.tenant_id=h.tenant_id AND t.policy_version_id=policy.id AND t.priority=h.priority::text
      WHERE h.tenant_id=public.current_app_tenant_id() AND h.id=result.handoff_id;
    UPDATE public.human_handoffs SET sla_policy_version_id=policy_id,
      sla_due_at=CASE WHEN policy_id IS NULL THEN NULL ELSE requested_at+make_interval(mins=>target) END
      WHERE tenant_id=public.current_app_tenant_id() AND id=result.handoff_id;
  END IF;
  RETURN QUERY SELECT result.source_handoff_id,result.handoff_id,result.conversation_id,result.service_case_id,result.handoff_version,
    result.conversation_version,result.service_case_version,result.replayed;
END $$;
REVOKE ALL ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION reopen_inbox_handoff(uuid,integer,text,text,text) TO zap_pronto_api;

COMMIT;
