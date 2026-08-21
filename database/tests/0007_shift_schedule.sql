BEGIN;
INSERT INTO tenants(id,name)VALUES('97000000-0000-4000-8000-000000000001','Shift test');
INSERT INTO units(id,tenant_id,code,name)VALUES('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000001','SHIFT','Shift unit');
INSERT INTO users(id,tenant_id,email,display_name)VALUES
 ('97000000-0000-4000-8000-000000000003','97000000-0000-4000-8000-000000000001','shift-manager@test.local','Manager'),
 ('97000000-0000-4000-8000-000000000004','97000000-0000-4000-8000-000000000001','shift-attendant@test.local','Attendant'),
 ('97000000-0000-4000-8000-000000000005','97000000-0000-4000-8000-000000000001','shift-supervisor@test.local','Supervisor');
INSERT INTO user_units(tenant_id,user_id,unit_id,role)VALUES
 ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000003','97000000-0000-4000-8000-000000000002','UNIT_MANAGER'),
 ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000004','97000000-0000-4000-8000-000000000002','ATTENDANT'),
 ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000005','97000000-0000-4000-8000-000000000002','SUPERVISOR');
INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id)
 VALUES('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','America/Sao_Paulo',1,'97000000-0000-4000-8000-000000000003');
SELECT set_config('app.tenant_id','97000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','97000000-0000-4000-8000-000000000003',true),set_config('app.correlation_id','shift-test',true);
DO $$DECLARE effective date:=(transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;weekly jsonb:='[{"weekday":1,"start":"08:00","end":"12:00"},{"weekday":1,"start":"12:00","end":"17:00"}]';exceptions jsonb:='[]';fingerprint text;created record;replayed record;BEGIN
 fingerprint:=encode(digest(convert_to(format('{"unitId":"%s","userId":"%s","effectiveFrom":"%s","weeklySlots":%s,"exceptions":%s,"expectedVersion":0}',
  '97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,
  regexp_replace(weekly::text,'\s','','g'),regexp_replace(exceptions::text,'\s','','g')),'UTF8'),'sha256'),'hex');
 SELECT * INTO created FROM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,weekly,exceptions,0,'shift-key-0001',fingerprint);
 IF created.version<>1 OR created.time_zone<>'America/Sao_Paulo' OR created.replayed THEN RAISE EXCEPTION 'SHIFT_CREATE_INVALID';END IF;
 INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id)
  VALUES('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','UTC',2,'97000000-0000-4000-8000-000000000003');
 SELECT * INTO replayed FROM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,weekly,exceptions,0,'shift-key-0001',fingerprint);
 IF NOT replayed.replayed OR replayed.time_zone<>'America/Sao_Paulo' OR replayed.updated_at<>created.updated_at THEN RAISE EXCEPTION 'SHIFT_REPLAY_SNAPSHOT_INVALID';END IF;
 BEGIN PERFORM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,'[]',exceptions,0,'shift-key-0001',
  encode(digest(convert_to(format('{"unitId":"%s","userId":"%s","effectiveFrom":"%s","weeklySlots":[],"exceptions":[],"expectedVersion":0}',
    '97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective),'UTF8'),'sha256'),'hex'));
  RAISE EXCEPTION 'SHIFT_DIVERGENT_REPLAY_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'SHIFT_SCHEDULE_IDEMPOTENCY_CONFLICT' THEN RAISE;END IF;END;
 IF (SELECT count(*) FROM list_unit_shift_members('97000000-0000-4000-8000-000000000002'))<>3 THEN RAISE EXCEPTION 'SHIFT_MEMBER_CATALOG_INVALID';END IF;
 IF (SELECT count(*) FROM audit_events WHERE tenant_id='97000000-0000-4000-8000-000000000001' AND action='SHIFT_SCHEDULE_PUBLISHED')<>1 THEN RAISE EXCEPTION 'SHIFT_AUDIT_INVALID';END IF;
 BEGIN PERFORM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,
  '[{"weekday":1,"start":"08:00","end":"12:00"},{"weekday":1,"start":"11:00","end":"13:00"}]','[]',1,'shift-key-0002',repeat('0',64));RAISE EXCEPTION 'SHIFT_OVERLAP_ACCEPTED';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN PERFORM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,NULL,'[]',1,'shift-key-null',repeat('0',64));
  RAISE EXCEPTION 'SHIFT_NULL_ACCEPTED';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
END$$;
UPDATE user_units SET status='REVOKED',version=version+1,state_changed_at=clock_timestamp(),revoked_at=clock_timestamp(),
  revoked_by_user_id='97000000-0000-4000-8000-000000000003',revocation_reason='REPLAY_AUTHORIZATION_TEST'
WHERE tenant_id='97000000-0000-4000-8000-000000000001' AND unit_id='97000000-0000-4000-8000-000000000002' AND user_id='97000000-0000-4000-8000-000000000004';
DO $$DECLARE effective date:=(transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;weekly jsonb:='[{"weekday":1,"start":"08:00","end":"12:00"},{"weekday":1,"start":"12:00","end":"17:00"}]';fingerprint text;BEGIN
 fingerprint:=encode(digest(convert_to(format('{"unitId":"%s","userId":"%s","effectiveFrom":"%s","weeklySlots":%s,"exceptions":[],"expectedVersion":0}',
  '97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,regexp_replace(weekly::text,'\s','','g')),'UTF8'),'sha256'),'hex');
 BEGIN PERFORM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,weekly,'[]',0,'shift-key-0001',fingerprint);
  RAISE EXCEPTION 'SHIFT_REVOKED_REPLAY_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'SHIFT_SCHEDULE_NOT_FOUND' THEN RAISE;END IF;END;END$$;
UPDATE user_units SET status='ACTIVE',version=version+1,state_changed_at=clock_timestamp(),revoked_at=NULL,revoked_by_user_id=NULL,revocation_reason=NULL
WHERE tenant_id='97000000-0000-4000-8000-000000000001' AND unit_id='97000000-0000-4000-8000-000000000002' AND user_id='97000000-0000-4000-8000-000000000004';
SELECT set_config('app.actor_id','97000000-0000-4000-8000-000000000005',true);
DO $$DECLARE effective date:=(transaction_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;weekly jsonb:='[{"weekday":1,"start":"08:00","end":"12:00"},{"weekday":1,"start":"12:00","end":"17:00"}]';fingerprint text;BEGIN
 BEGIN PERFORM list_unit_shift_members('97000000-0000-4000-8000-000000000002');EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SUPERVISOR_READ_DENIED';END;
 fingerprint:=encode(digest(convert_to(format('{"unitId":"%s","userId":"%s","effectiveFrom":"%s","weeklySlots":%s,"exceptions":[],"expectedVersion":1}',
  '97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,
  regexp_replace(weekly::text,'\s','','g')),'UTF8'),'sha256'),'hex');
 BEGIN PERFORM set_unit_shift_schedule('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000004',effective,weekly,'[]',1,'shift-key-0003',fingerprint);
  RAISE EXCEPTION 'SUPERVISOR_MANAGE_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'SHIFT_SCHEDULE_NOT_FOUND' THEN RAISE;END IF;END;END$$;
ROLLBACK;
