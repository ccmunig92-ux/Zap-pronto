BEGIN;
INSERT INTO tenants(id,name)VALUES('99000000-0000-4000-8000-000000000001','Assignment enforcement test');
INSERT INTO units(id,tenant_id,code,name)VALUES('99000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000001','ASSIGN','Assignment unit');
INSERT INTO users(id,tenant_id,email,display_name)VALUES
 ('99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','manager-assignment@test.local','Manager'),
 ('99000000-0000-4000-8000-000000000004','99000000-0000-4000-8000-000000000001','attendant-assignment@test.local','Attendant'),
 ('99000000-0000-4000-8000-000000000005','99000000-0000-4000-8000-000000000001','supervisor-assignment@test.local','Supervisor');
INSERT INTO user_units(tenant_id,user_id,unit_id,role)VALUES
 ('99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000002','UNIT_MANAGER'),
 ('99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000004','99000000-0000-4000-8000-000000000002','ATTENDANT'),
 ('99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000005','99000000-0000-4000-8000-000000000002','SUPERVISOR');
SELECT set_config('app.tenant_id','99000000-0000-4000-8000-000000000001',true),
 set_config('app.actor_id','99000000-0000-4000-8000-000000000003',true),set_config('app.correlation_id','assignment-policy-test',true);

DO $$DECLARE policy record;readiness record;fp text;divergent_fp text;created record;replayed record;
BEGIN
 SELECT * INTO policy FROM get_unit_assignment_policy('99000000-0000-4000-8000-000000000002');
 IF policy.mode<>'OBSERVE' OR policy.version<>1 THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_DEFAULT_INVALID';END IF;
 SELECT * INTO readiness FROM get_unit_assignment_policy_readiness('99000000-0000-4000-8000-000000000002');
 IF readiness.operational_members<>3 OR readiness.effective_schedules<>0 OR readiness.missing_schedules<>3 OR readiness.timezone_configured OR readiness.ready
   THEN RAISE EXCEPTION 'ASSIGNMENT_READINESS_EMPTY_INVALID';END IF;
 fp:=encode(digest(convert_to('{"unitId":"99000000-0000-4000-8000-000000000002","mode":"OBSERVE","expectedVersion":1}','UTF8'),'sha256'),'hex');
 SELECT * INTO created FROM set_unit_assignment_policy('99000000-0000-4000-8000-000000000002','OBSERVE',1,'assignment-policy-key-1',fp);
 SELECT * INTO replayed FROM set_unit_assignment_policy('99000000-0000-4000-8000-000000000002','OBSERVE',1,'assignment-policy-key-1',fp);
 IF created.version<>2 OR created.replayed OR NOT replayed.replayed OR replayed.version<>created.version OR replayed.updated_at<>created.updated_at
   THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_REPLAY_INVALID';END IF;
 divergent_fp:=encode(digest(convert_to('{"unitId":"99000000-0000-4000-8000-000000000002","mode":"ENFORCE_NEW_ASSIGNMENTS","expectedVersion":1}','UTF8'),'sha256'),'hex');
 BEGIN PERFORM set_unit_assignment_policy('99000000-0000-4000-8000-000000000002','ENFORCE_NEW_ASSIGNMENTS',1,'assignment-policy-key-1',divergent_fp);
   RAISE EXCEPTION 'ASSIGNMENT_POLICY_DIVERGENT_REPLAY_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'ASSIGNMENT_POLICY_IDEMPOTENCY_CONFLICT' THEN RAISE;END IF;END;
 IF (SELECT count(*) FROM audit_events WHERE tenant_id='99000000-0000-4000-8000-000000000001' AND action='UNIT_ASSIGNMENT_POLICY_CHANGED')<>1
   THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_AUDIT_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events WHERE tenant_id='99000000-0000-4000-8000-000000000001'
   AND action='UNIT_ASSIGNMENT_POLICY_CHANGED' AND metadata->>'unitId'='99000000-0000-4000-8000-000000000002'
   AND metadata->>'mode'='OBSERVE' AND metadata->>'version'='2') THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_AUDIT_METADATA_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM outbox_events WHERE tenant_id='99000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_OUTBOX_CREATED';END IF;
END$$;

INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id)
 VALUES('99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002','UTC',1,'99000000-0000-4000-8000-000000000003');
INSERT INTO unit_shift_schedule_versions(tenant_id,unit_id,user_id,version,effective_from,time_zone,weekly_slots,exceptions,created_by_user_id)
SELECT '99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002',actor.id,1,
 (transaction_timestamp() AT TIME ZONE 'UTC')::date,'UTC',
 jsonb_build_array(jsonb_build_object('weekday',extract(isodow FROM transaction_timestamp() AT TIME ZONE 'UTC')::integer,'start','00:00','end','23:59')),
 '[]'::jsonb,'99000000-0000-4000-8000-000000000003'
FROM (VALUES('99000000-0000-4000-8000-000000000003'::uuid),('99000000-0000-4000-8000-000000000004'::uuid),('99000000-0000-4000-8000-000000000005'::uuid))actor(id);

DO $$DECLARE readiness record;fp text;enforced record;
BEGIN
 SELECT * INTO readiness FROM get_unit_assignment_policy_readiness('99000000-0000-4000-8000-000000000002');
 IF readiness.operational_members<>3 OR readiness.effective_schedules<>3 OR readiness.missing_schedules<>0 OR NOT readiness.timezone_configured OR NOT readiness.ready
   THEN RAISE EXCEPTION 'ASSIGNMENT_READINESS_COMPLETE_INVALID';END IF;
 fp:=encode(digest(convert_to('{"unitId":"99000000-0000-4000-8000-000000000002","mode":"ENFORCE_NEW_ASSIGNMENTS","expectedVersion":2}','UTF8'),'sha256'),'hex');
 SELECT * INTO enforced FROM set_unit_assignment_policy('99000000-0000-4000-8000-000000000002','ENFORCE_NEW_ASSIGNMENTS',2,'assignment-policy-key-2',fp);
 IF enforced.mode<>'ENFORCE_NEW_ASSIGNMENTS' OR enforced.version<>3 OR enforced.replayed THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_ENFORCE_INVALID';END IF;
 BEGIN PERFORM assert_new_assignment_shift_internal('99000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000004');
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'ASSIGNMENT_IN_SHIFT_DENIED: %',SQLERRM;END;
 UPDATE unit_shift_schedule_versions SET exceptions=jsonb_build_array(jsonb_build_object('date',(transaction_timestamp() AT TIME ZONE 'UTC')::date::text,'type','CLOSED'))
  WHERE tenant_id='99000000-0000-4000-8000-000000000001' AND unit_id='99000000-0000-4000-8000-000000000002' AND user_id='99000000-0000-4000-8000-000000000004';
 BEGIN PERFORM assert_new_assignment_shift_internal('99000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000004');
   RAISE EXCEPTION 'ASSIGNMENT_OUTSIDE_SHIFT_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'ASSIGNEE_OUTSIDE_SHIFT' THEN RAISE;END IF;END;
END$$;

SELECT set_config('app.actor_id','99000000-0000-4000-8000-000000000005',true);
DO $$DECLARE fp text;BEGIN
 fp:=encode(digest(convert_to('{"unitId":"99000000-0000-4000-8000-000000000002","mode":"OBSERVE","expectedVersion":3}','UTF8'),'sha256'),'hex');
 BEGIN PERFORM set_unit_assignment_policy('99000000-0000-4000-8000-000000000002','OBSERVE',3,'assignment-policy-supervisor',fp);
  RAISE EXCEPTION 'SUPERVISOR_POLICY_MANAGE_ACCEPTED';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'INVALID_ASSIGNMENT_POLICY_REQUEST' AND SQLERRM<>'ASSIGNMENT_POLICY_NOT_FOUND' THEN RAISE;END IF;END;
END$$;

DO $$BEGIN
 IF has_table_privilege('zap_pronto_api','unit_assignment_policies','SELECT') OR has_table_privilege('zap_pronto_worker','unit_assignment_policies','SELECT')
   OR has_function_privilege('zap_pronto_api','evaluate_unit_staff_shift_internal(uuid,uuid,uuid,timestamptz)','EXECUTE')
   OR has_function_privilege('zap_pronto_api','assert_new_assignment_shift_internal(uuid,uuid)','EXECUTE')
   OR has_function_privilege('zap_pronto_worker','assert_actor_new_claim_shift(uuid)','EXECUTE')
   OR NOT has_function_privilege('zap_pronto_api','assert_actor_new_claim_shift(uuid)','EXECUTE')
   OR NOT has_function_privilege('zap_pronto_api','get_unit_assignment_policy(uuid)','EXECUTE')
   OR NOT has_function_privilege('zap_pronto_api','set_unit_assignment_policy(uuid,text,integer,text,text)','EXECUTE')
   THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_GRANTS_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class table_ref WHERE table_ref.oid='unit_assignment_policies'::regclass AND table_ref.relrowsecurity AND table_ref.relforcerowsecurity)
   THEN RAISE EXCEPTION 'ASSIGNMENT_POLICY_RLS_INVALID';END IF;
END$$;
ROLLBACK;
