BEGIN;

INSERT INTO tenants(id,name,status) VALUES
  ('81000000-0000-4000-8000-000000000001','Discovery tenant A','ACTIVE'),
  ('81000000-0000-4000-8000-000000000002','Discovery tenant B','ACTIVE');
INSERT INTO users(id,tenant_id,email,display_name) VALUES
  ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','discovery-a@test.local','Discovery A'),
  ('82000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000002','discovery-b@test.local','Discovery B');
INSERT INTO units(id,tenant_id,code,name)
SELECT ('81000001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '81000000-0000-4000-8000-000000000001','DYN-A-'||n,'Discovery A '||n
FROM generate_series(1,102)n;
INSERT INTO units(id,tenant_id,code,name)
SELECT ('81000002-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '81000000-0000-4000-8000-000000000002','DYN-B-'||n,'Discovery B '||n
FROM generate_series(1,2)n;
INSERT INTO unit_capacity_alert_policy_versions(tenant_id,unit_id,version,enabled,minimum_queued,sustained_minutes,created_by_user_id)
SELECT '81000000-0000-4000-8000-000000000001',unit.id,1,true,1,5,
  '82000000-0000-4000-8000-000000000001'
FROM units unit WHERE unit.tenant_id='81000000-0000-4000-8000-000000000001';
INSERT INTO unit_capacity_alert_policy_versions(tenant_id,unit_id,version,enabled,minimum_queued,sustained_minutes,created_by_user_id)
SELECT '81000000-0000-4000-8000-000000000002',unit.id,1,true,1,5,
  '82000000-0000-4000-8000-000000000002'
FROM units unit WHERE unit.tenant_id='81000000-0000-4000-8000-000000000002';

-- Latest policy wins and inactive units are never scheduled.
INSERT INTO unit_capacity_alert_policy_versions(tenant_id,unit_id,version,enabled,minimum_queued,sustained_minutes,created_by_user_id)
VALUES('81000000-0000-4000-8000-000000000001','81000001-0000-4000-8000-000000000001',2,false,1,5,
  '82000000-0000-4000-8000-000000000001');
UPDATE units SET active=false
WHERE tenant_id='81000000-0000-4000-8000-000000000002'
  AND id='81000002-0000-4000-8000-000000000002';

DO $$
DECLARE first_count integer;second_count integer;cursor_tenant uuid;cursor_unit uuid;
BEGIN
  SELECT count(*) INTO first_count FROM list_capacity_alert_evaluation_targets(NULL,NULL,100);
  SELECT page.tenant_id,page.unit_id INTO cursor_tenant,cursor_unit
  FROM list_capacity_alert_evaluation_targets(NULL,NULL,100) page
  ORDER BY page.tenant_id DESC,page.unit_id DESC LIMIT 1;
  SELECT count(*) INTO second_count
  FROM list_capacity_alert_evaluation_targets(cursor_tenant,cursor_unit,100);
  IF first_count<>100 OR second_count<>2 THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_PAGINATION_INVALID';
  END IF;
  IF EXISTS(SELECT 1 FROM list_capacity_alert_evaluation_targets(NULL,NULL,100) page
    WHERE page.unit_id IN('81000001-0000-4000-8000-000000000001','81000002-0000-4000-8000-000000000002')) THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_DISABLED_TARGET_VISIBLE';
  END IF;
END$$;

DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN PERFORM list_capacity_alert_evaluation_targets('81000000-0000-4000-8000-000000000001',NULL,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=SQLERRM='INVALID_CAPACITY_ALERT_DISCOVERY_REQUEST'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_PARTIAL_CURSOR_ACCEPTED'; END IF;
END$$;

DO $$
BEGIN
  IF NOT has_function_privilege('zap_pronto_worker','list_capacity_alert_evaluation_targets(uuid,uuid,integer)','EXECUTE')
    OR has_function_privilege('zap_pronto_api','list_capacity_alert_evaluation_targets(uuid,uuid,integer)','EXECUTE')
    OR has_function_privilege('zap_pronto_app','list_capacity_alert_evaluation_targets(uuid,uuid,integer)','EXECUTE')
    OR has_table_privilege('zap_pronto_worker','unit_capacity_alert_policy_versions','SELECT') THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_PRIVILEGE_INVALID';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_proc proc
    CROSS JOIN LATERAL aclexplode(COALESCE(proc.proacl,acldefault('f',proc.proowner))) acl_entry
    WHERE proc.oid='list_capacity_alert_evaluation_targets(uuid,uuid,integer)'::regprocedure
      AND acl_entry.grantee=0 AND acl_entry.privilege_type='EXECUTE'
  ) THEN RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_PUBLIC_EXECUTE_VISIBLE'; END IF;
  IF to_regclass('unit_capacity_alert_policy_discovery_idx') IS NULL THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_INDEX_MISSING';
  END IF;
  IF to_regclass('units_active_capacity_discovery_idx') IS NULL THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_DISCOVERY_UNIT_INDEX_MISSING';
  END IF;
END$$;

SET LOCAL ROLE zap_pronto_worker;
DO $$ DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM list_capacity_alert_evaluation_targets(NULL,NULL,100);
  IF visible_count<>100 THEN RAISE EXCEPTION 'CAPACITY_ALERT_WORKER_DISCOVERY_INVALID'; END IF;
END$$;
RESET ROLE;

-- Simulate a target disabled after discovery. Evaluation must close/no-op, not
-- create an episode; the empty queue is also the required zero-demand case.
INSERT INTO unit_capacity_alert_policy_versions(tenant_id,unit_id,version,enabled,minimum_queued,sustained_minutes,created_by_user_id)
VALUES('81000000-0000-4000-8000-000000000001','81000001-0000-4000-8000-000000000002',2,false,1,5,
  '82000000-0000-4000-8000-000000000001');
SET LOCAL ROLE zap_pronto_worker;
SELECT set_config('app.tenant_id','81000000-0000-4000-8000-000000000001',true);
DO $$ DECLARE result_status text;
BEGIN
  SELECT evaluated.status INTO result_status
  FROM evaluate_unit_capacity_alert_episode('81000001-0000-4000-8000-000000000002','2026-09-11 12:00Z') evaluated;
  IF result_status<>'RESOLVED' THEN RAISE EXCEPTION 'CAPACITY_ALERT_CONCURRENT_DISABLE_INVALID'; END IF;
END$$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM unit_capacity_alert_episodes episode
    WHERE episode.tenant_id='81000000-0000-4000-8000-000000000001'
      AND episode.unit_id='81000001-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'CAPACITY_ALERT_ZERO_DEMAND_EPISODE_CREATED';
  END IF;
END$$;

ROLLBACK;
