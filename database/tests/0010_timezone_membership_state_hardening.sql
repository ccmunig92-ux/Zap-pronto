BEGIN;

INSERT INTO tenants(id,name) VALUES('9a000000-0000-4000-8000-000000000001','State hardening test');
INSERT INTO units(id,tenant_id,code,name) VALUES
 ('9a000000-0000-4000-8000-000000000002','9a000000-0000-4000-8000-000000000001','HARDEN','Hardening unit');
INSERT INTO users(id,tenant_id,email,display_name) VALUES
 ('9a000000-0000-4000-8000-000000000003','9a000000-0000-4000-8000-000000000001','manager-hardening@test.local','Manager'),
 ('9a000000-0000-4000-8000-000000000004','9a000000-0000-4000-8000-000000000001','attendant-hardening@test.local','Attendant');
INSERT INTO user_units(tenant_id,user_id,unit_id,role) VALUES
 ('9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000003','9a000000-0000-4000-8000-000000000002','UNIT_MANAGER'),
 ('9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000004','9a000000-0000-4000-8000-000000000002','ATTENDANT');
SELECT set_config('app.tenant_id','9a000000-0000-4000-8000-000000000001',true),
 set_config('app.actor_id','9a000000-0000-4000-8000-000000000003',true),
 set_config('app.correlation_id','state-hardening-test',true);

INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id) VALUES
 ('9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000002','UTC',1,'9a000000-0000-4000-8000-000000000003');
INSERT INTO unit_shift_schedule_versions(tenant_id,unit_id,user_id,version,effective_from,time_zone,weekly_slots,exceptions,created_by_user_id)
SELECT '9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000002',member.id,1,
 (transaction_timestamp() AT TIME ZONE 'UTC')::date,'UTC',
 jsonb_build_array(jsonb_build_object('weekday',extract(isodow FROM transaction_timestamp() AT TIME ZONE 'UTC')::integer,'start','00:00','end','23:59')),
 '[]'::jsonb,'9a000000-0000-4000-8000-000000000003'
FROM (VALUES('9a000000-0000-4000-8000-000000000003'::uuid),('9a000000-0000-4000-8000-000000000004'::uuid)) member(id);

DO $$DECLARE readiness record;evaluation record;BEGIN
  SELECT * INTO readiness FROM get_unit_assignment_policy_readiness('9a000000-0000-4000-8000-000000000002');
  IF NOT readiness.ready OR readiness.effective_schedules<>2 THEN RAISE EXCEPTION 'INITIAL_TIMEZONE_READINESS_INVALID';END IF;
  INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id) VALUES
   ('9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000002','America/Manaus',2,'9a000000-0000-4000-8000-000000000003');
  SELECT * INTO readiness FROM get_unit_assignment_policy_readiness('9a000000-0000-4000-8000-000000000002');
  IF readiness.ready OR readiness.effective_schedules<>0 OR readiness.missing_schedules<>2 OR NOT readiness.timezone_configured
    THEN RAISE EXCEPTION 'TIMEZONE_DRIFT_READINESS_ACCEPTED';END IF;
  SELECT * INTO evaluation FROM evaluate_unit_staff_shift_internal('9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000002','9a000000-0000-4000-8000-000000000004',transaction_timestamp());
  IF evaluation.state<>'UNCONFIGURED' OR evaluation.schedule_version IS NOT NULL OR evaluation.time_zone IS NOT NULL
    THEN RAISE EXCEPTION 'TIMEZONE_DRIFT_EVALUATION_ACCEPTED';END IF;
  INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id) VALUES
   ('9a000000-0000-4000-8000-000000000001','9a000000-0000-4000-8000-000000000002','UTC',3,'9a000000-0000-4000-8000-000000000003');
  SELECT * INTO readiness FROM get_unit_assignment_policy_readiness('9a000000-0000-4000-8000-000000000002');
  IF readiness.ready OR readiness.effective_schedules<>0 OR readiness.missing_schedules<>2
    THEN RAISE EXCEPTION 'TIMEZONE_ABA_RESURRECTED_OLD_SCHEDULE';END IF;
  SELECT * INTO evaluation FROM evaluate_unit_staff_shift_internal('9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000002','9a000000-0000-4000-8000-000000000004',transaction_timestamp());
  IF evaluation.state<>'UNCONFIGURED' OR evaluation.schedule_version IS NOT NULL
    THEN RAISE EXCEPTION 'TIMEZONE_ABA_EVALUATION_RESURRECTED_OLD_SCHEDULE';END IF;
  UPDATE unit_assignment_policies SET mode='ENFORCE_NEW_ASSIGNMENTS',version=version+1
    WHERE tenant_id='9a000000-0000-4000-8000-000000000001' AND unit_id='9a000000-0000-4000-8000-000000000002';
  BEGIN PERFORM assert_new_assignment_shift_internal('9a000000-0000-4000-8000-000000000002','9a000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'TIMEZONE_DRIFT_ASSIGNMENT_ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'ASSIGNEE_OUTSIDE_SHIFT' THEN RAISE;END IF;END;
END$$;

UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=7,version=2
WHERE tenant_id='9a000000-0000-4000-8000-000000000001' AND unit_id='9a000000-0000-4000-8000-000000000002'
  AND user_id='9a000000-0000-4000-8000-000000000004';
UPDATE user_units SET status='REVOKED',version=version+1,state_changed_at=clock_timestamp(),revoked_at=clock_timestamp(),
 revoked_by_user_id='9a000000-0000-4000-8000-000000000003',revocation_reason='Hardening lifecycle test'
WHERE tenant_id='9a000000-0000-4000-8000-000000000001' AND unit_id='9a000000-0000-4000-8000-000000000002'
  AND user_id='9a000000-0000-4000-8000-000000000004';
UPDATE user_units SET status='ACTIVE',version=version+1,state_changed_at=clock_timestamp(),revoked_at=NULL,
 revoked_by_user_id=NULL,revocation_reason=NULL
WHERE tenant_id='9a000000-0000-4000-8000-000000000001' AND unit_id='9a000000-0000-4000-8000-000000000002'
  AND user_id='9a000000-0000-4000-8000-000000000004';

DO $$DECLARE availability record;BEGIN
  SELECT * INTO availability FROM attendant_unit_availability
  WHERE tenant_id='9a000000-0000-4000-8000-000000000001' AND unit_id='9a000000-0000-4000-8000-000000000002'
    AND user_id='9a000000-0000-4000-8000-000000000004';
  IF availability.status<>'OFFLINE' OR availability.max_active<>100 OR availability.pause_reason IS NOT NULL
    OR availability.paused_until IS NOT NULL OR availability.version<>3 THEN
    RAISE EXCEPTION 'REACTIVATED_AVAILABILITY_NOT_RESET';END IF;
END$$;

ROLLBACK;
