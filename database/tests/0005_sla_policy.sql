BEGIN;
INSERT INTO tenants(id,name) VALUES('91000000-0000-4000-8000-000000000001','SLA policy test');
INSERT INTO units(id,tenant_id,code,name) VALUES('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','POL','Policy Unit');
INSERT INTO users(id,tenant_id,email,display_name) VALUES('93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','policy@test.local','Policy Manager');
INSERT INTO user_units(tenant_id,user_id,unit_id,role) VALUES('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','UNIT_MANAGER');
SELECT set_config('app.tenant_id','91000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','93000000-0000-4000-8000-000000000001',true),set_config('app.correlation_id','sla-policy-test',true);
DO $$ DECLARE created record;replayed record;listed record;BEGIN
 SELECT * INTO created FROM set_unit_sla_policy('92000000-0000-4000-8000-000000000001',0,
  '[{"priority":"LOW","targetMinutes":120},{"priority":"NORMAL","targetMinutes":60},{"priority":"HIGH","targetMinutes":30},{"priority":"URGENT","targetMinutes":15}]',
  'sla-policy-command-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 SELECT * INTO replayed FROM set_unit_sla_policy('92000000-0000-4000-8000-000000000001',0,
  '[{"priority":"LOW","targetMinutes":120},{"priority":"NORMAL","targetMinutes":60},{"priority":"HIGH","targetMinutes":30},{"priority":"URGENT","targetMinutes":15}]',
  'sla-policy-command-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 SELECT * INTO listed FROM get_unit_sla_policy('92000000-0000-4000-8000-000000000001');
 IF created.version<>1 OR created.replayed OR NOT replayed.replayed OR listed.version<>1
   OR (SELECT count(*) FROM unit_sla_policy_targets WHERE policy_version_id=(SELECT id FROM unit_sla_policy_versions LIMIT 1))<>4 THEN
   RAISE EXCEPTION 'SLA_POLICY_PUBLISH_INVALID';END IF;
 IF (SELECT count(*) FROM audit_events WHERE action='SLA_POLICY_PUBLISHED')<>1 THEN
   RAISE EXCEPTION 'SLA_POLICY_AUDIT_COUNT_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events event JOIN unit_sla_policy_versions policy
      ON policy.tenant_id=event.tenant_id AND policy.id::text=event.entity_id
    WHERE event.action='SLA_POLICY_PUBLISHED' AND event.actor_type='USER'
      AND event.actor_id='93000000-0000-4000-8000-000000000001'
      AND event.entity_type='unit_sla_policy'
      AND event.metadata=jsonb_build_object('unitId','92000000-0000-4000-8000-000000000001'::uuid,
        'policyVersion',1,'targets',
        '[{"priority":"LOW","targetMinutes":120},{"priority":"NORMAL","targetMinutes":60},{"priority":"HIGH","targetMinutes":30},{"priority":"URGENT","targetMinutes":15}]'::jsonb)) THEN
   RAISE EXCEPTION 'SLA_POLICY_AUDIT_METADATA_INVALID';END IF;
 BEGIN
  PERFORM set_unit_sla_policy('92000000-0000-4000-8000-000000000001',0,
   '[{"priority":"LOW","targetMinutes":121},{"priority":"NORMAL","targetMinutes":60},{"priority":"HIGH","targetMinutes":30},{"priority":"URGENT","targetMinutes":15}]',
   'sla-policy-command-2','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  RAISE EXCEPTION 'EXPECTED_CONFLICT';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'SLA_POLICY_CONFLICT' THEN RAISE;END IF;END;
 IF (SELECT count(*) FROM audit_events WHERE action='SLA_POLICY_PUBLISHED')<>1 THEN
   RAISE EXCEPTION 'SLA_POLICY_CONFLICT_AUDIT_SIDE_EFFECT';END IF;
END$$;
DO $$ BEGIN
 IF has_table_privilege('zap_pronto_api','unit_sla_policy_versions','SELECT')
   OR has_table_privilege('zap_pronto_api','unit_sla_policy_targets','SELECT')
   OR has_table_privilege('zap_pronto_api','unit_sla_policy_publish_commands','SELECT') THEN
   RAISE EXCEPTION 'SLA_POLICY_API_TABLE_GRANT_FORBIDDEN';END IF;
 IF NOT has_function_privilege('zap_pronto_api','resolve_unit_sla_policy_target(uuid,text)','EXECUTE') THEN
   RAISE EXCEPTION 'SLA_POLICY_TARGET_RESOLVER_GRANT_MISSING';END IF;
END$$;
SET LOCAL ROLE zap_pronto_api;
DO $$ DECLARE resolved record;BEGIN
 SELECT * INTO resolved FROM resolve_unit_sla_policy_target('92000000-0000-4000-8000-000000000001','URGENT');
 IF resolved.target_minutes<>15 OR resolved.policy_version_id IS NULL THEN
   RAISE EXCEPTION 'SLA_POLICY_API_RESOLUTION_INVALID';END IF;
END$$;
RESET ROLE;
ROLLBACK;
