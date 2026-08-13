BEGIN;
INSERT INTO tenants(id,name)VALUES('96000000-0000-4000-8000-000000000001','Timezone test');
INSERT INTO units(id,tenant_id,code,name)VALUES
 ('96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000001','TZ-A','Timezone A'),
 ('96000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000001','TZ-B','Timezone B');
INSERT INTO users(id,tenant_id,email,display_name)VALUES
 ('96000000-0000-4000-8000-000000000004','96000000-0000-4000-8000-000000000001','timezone-manager@test.local','Timezone manager'),
 ('96000000-0000-4000-8000-000000000005','96000000-0000-4000-8000-000000000001','timezone-supervisor@test.local','Timezone supervisor');
INSERT INTO user_units(tenant_id,user_id,unit_id,role)VALUES
 ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000004','96000000-0000-4000-8000-000000000002','UNIT_MANAGER'),
 ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000004','96000000-0000-4000-8000-000000000003','UNIT_MANAGER'),
 ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000005','96000000-0000-4000-8000-000000000002','SUPERVISOR');
SELECT set_config('app.tenant_id','96000000-0000-4000-8000-000000000001',true),
 set_config('app.actor_id','96000000-0000-4000-8000-000000000004',true),set_config('app.correlation_id','timezone-test',true);
DO $$DECLARE created record;replayed record;fingerprint text:=encode(digest(convert_to(
  '{"unitId":"96000000-0000-4000-8000-000000000002","timeZone":"America/Sao_Paulo","expectedVersion":0}','UTF8'),'sha256'),'hex');
BEGIN
  IF EXISTS(SELECT 1 FROM get_unit_operational_timezone('96000000-0000-4000-8000-000000000002')) THEN
    RAISE EXCEPTION 'TIMEZONE_DEFAULT_OR_BACKFILL_FOUND';END IF;
  SELECT * INTO created FROM set_unit_operational_timezone('96000000-0000-4000-8000-000000000002','America/Sao_Paulo',0,
    'timezone-key-0001',fingerprint);
  IF created.version<>1 OR created.time_zone<>'America/Sao_Paulo' OR created.replayed THEN RAISE EXCEPTION 'TIMEZONE_CREATE_INVALID';END IF;
  SELECT * INTO replayed FROM set_unit_operational_timezone('96000000-0000-4000-8000-000000000002','America/Sao_Paulo',0,
    'timezone-key-0001',fingerprint);
  IF NOT replayed.replayed OR replayed.version<>created.version OR replayed.updated_at<>created.updated_at THEN RAISE EXCEPTION 'TIMEZONE_REPLAY_INVALID';END IF;
  BEGIN PERFORM set_unit_operational_timezone('96000000-0000-4000-8000-000000000003','America/Sao_Paulo',0,
    'timezone-key-0001',encode(digest(convert_to('{"unitId":"96000000-0000-4000-8000-000000000003","timeZone":"America/Sao_Paulo","expectedVersion":0}','UTF8'),'sha256'),'hex'));
    RAISE EXCEPTION 'DIVERGENT_KEY_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM<>'UNIT_OPERATIONAL_TIMEZONE_IDEMPOTENCY_CONFLICT' THEN RAISE;END IF;END;
  BEGIN PERFORM set_unit_operational_timezone('96000000-0000-4000-8000-000000000003','Invalid/Timezone',0,
    'timezone-key-0002',repeat('0',64));RAISE EXCEPTION 'INVALID_TIMEZONE_ACCEPTED';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
  IF (SELECT count(*) FROM audit_events WHERE tenant_id='96000000-0000-4000-8000-000000000001'
      AND action='UNIT_OPERATIONAL_TIMEZONE_CONFIGURED')<>1 THEN RAISE EXCEPTION 'TIMEZONE_AUDIT_NOT_UNIQUE';END IF;
END$$;
UPDATE user_units SET status='REVOKED',version=version+1,state_changed_at=clock_timestamp(),
  revoked_at=clock_timestamp(),revoked_by_user_id='96000000-0000-4000-8000-000000000004',
  revocation_reason='Timezone replay authorization test'
  WHERE tenant_id='96000000-0000-4000-8000-000000000001'
  AND user_id='96000000-0000-4000-8000-000000000004' AND unit_id='96000000-0000-4000-8000-000000000002';
DO $$DECLARE fingerprint text:=encode(digest(convert_to(
  '{"unitId":"96000000-0000-4000-8000-000000000002","timeZone":"America/Sao_Paulo","expectedVersion":0}','UTF8'),'sha256'),'hex');BEGIN
  BEGIN PERFORM set_unit_operational_timezone('96000000-0000-4000-8000-000000000002','America/Sao_Paulo',0,
    'timezone-key-0001',fingerprint);RAISE EXCEPTION 'REVOKED_REPLAY_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM<>'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' THEN RAISE;END IF;END;
END$$;
SELECT set_config('app.actor_id','96000000-0000-4000-8000-000000000005',true);
DO $$BEGIN
  BEGIN PERFORM get_unit_operational_timezone('96000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'CROSS_UNIT_READ_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM<>'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' THEN RAISE;END IF;END;
  BEGIN PERFORM set_unit_operational_timezone('96000000-0000-4000-8000-000000000002','America/Sao_Paulo',1,
    'timezone-key-0003',encode(digest(convert_to('{"unitId":"96000000-0000-4000-8000-000000000002","timeZone":"America/Sao_Paulo","expectedVersion":1}','UTF8'),'sha256'),'hex'));
    RAISE EXCEPTION 'SUPERVISOR_MANAGE_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM<>'UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND' THEN RAISE;END IF;END;
END$$;
ROLLBACK;
