BEGIN;
INSERT INTO tenants(id,name)VALUES('50000000-0000-4000-8000-000000000001','Availability test');
INSERT INTO units(id,tenant_id,code,name)VALUES('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','AV1','Availability unit');
INSERT INTO users(id,tenant_id,email,display_name)VALUES('52000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','availability@test.local','Actor');
INSERT INTO user_units(tenant_id,user_id,unit_id,role)VALUES('50000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','ATTENDANT');
SELECT set_config('app.tenant_id','50000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','52000000-0000-4000-8000-000000000001',true),set_config('app.correlation_id','availability-test',true);
DO $$ DECLARE first_result record;replay_result record;BEGIN
  SELECT * INTO first_result FROM set_actor_unit_availability('51000000-0000-4000-8000-000000000001','AVAILABLE',2,NULL,NULL,1,
    'availability-key-1','c11dabf108758016a6e58b9003d50f40950876684b4aac66978bcc2b9c681c28');
  IF first_result.status<>'AVAILABLE' OR first_result.max_active<>2 OR first_result.version<>2 OR first_result.active_count<>0 OR first_result.replayed THEN
    RAISE EXCEPTION 'AVAILABILITY_COMMAND_RESULT_INVALID'; END IF;
  SELECT * INTO replay_result FROM set_actor_unit_availability('51000000-0000-4000-8000-000000000001','AVAILABLE',2,NULL,NULL,1,
    'availability-key-1','c11dabf108758016a6e58b9003d50f40950876684b4aac66978bcc2b9c681c28');
  IF NOT replay_result.replayed OR replay_result.version<>first_result.version OR replay_result.updated_at<>first_result.updated_at THEN
    RAISE EXCEPTION 'AVAILABILITY_REPLAY_INVALID'; END IF;
  BEGIN
    PERFORM set_actor_unit_availability('51000000-0000-4000-8000-000000000001','AVAILABLE',2,NULL,NULL,1,
      'availability-key-2','c11dabf108758016a6e58b9003d50f40950876684b4aac66978bcc2b9c681c28');
    RAISE EXCEPTION 'STALE_VERSION_ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'AVAILABILITY_CONFLICT' THEN RAISE; END IF; END;
END$$;
ROLLBACK;
