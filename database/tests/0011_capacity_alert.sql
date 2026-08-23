BEGIN;
INSERT INTO tenants(id,name) VALUES('a1000000-0000-4000-8000-000000000001','Capacity alert test'),('b1000000-0000-4000-8000-000000000001','Foreign tenant');
INSERT INTO units(id,tenant_id,code,name) VALUES('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','CAPACITY','Capacity unit'),('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','FOREIGN','Foreign unit');
INSERT INTO users(id,tenant_id,email,display_name) VALUES
 ('a3000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','capacity@test.local','Capacity manager'),
 ('a3000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','capacity-attendant@test.local','Attendant'),
 ('b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','foreign@test.local','Foreign manager');
INSERT INTO user_units(tenant_id,user_id,unit_id,role) VALUES
 ('a1000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','UNIT_MANAGER'),
 ('a1000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','ATTENDANT'),
 ('b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','UNIT_MANAGER');
SELECT set_config('app.tenant_id','a1000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','a3000000-0000-4000-8000-000000000001',true),set_config('app.correlation_id','capacity-alert-fixture',true);
UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=3 WHERE tenant_id='a1000000-0000-4000-8000-000000000001' AND unit_id='a2000000-0000-4000-8000-000000000001' AND user_id='a3000000-0000-4000-8000-000000000001';
INSERT INTO channel_connections(id,tenant_id,type,scope,external_account_id,status) VALUES('a4000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','WHATSAPP','SINGLE_UNIT','capacity-account','ACTIVE');
INSERT INTO channel_connection_units(tenant_id,channel_connection_id,unit_id) VALUES('a1000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001');
INSERT INTO contacts(id,tenant_id,display_name) SELECT ('a5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a1000000-0000-4000-8000-000000000001','Demand '||n FROM generate_series(1,5)n;
INSERT INTO contact_identities(id,tenant_id,contact_id,channel_connection_id,external_user_id) SELECT ('a6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a1000000-0000-4000-8000-000000000001',('a5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a4000000-0000-4000-8000-000000000001','capacity-'||n FROM generate_series(1,5)n;
INSERT INTO conversations(id,tenant_id,channel_connection_id,contact_id,contact_identity_id,unit_id,status,automation_status,assigned_user_id) SELECT
 ('a7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a1000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001',('a5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('a6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a2000000-0000-4000-8000-000000000001','OPEN',(CASE WHEN n=5 THEN 'HUMAN_ACTIVE' ELSE 'HUMAN_QUEUED' END)::automation_status,CASE WHEN n=5 THEN 'a3000000-0000-4000-8000-000000000001'::uuid ELSE NULL END FROM generate_series(1,5)n;
INSERT INTO service_cases(id,tenant_id,conversation_id,unit_id,kind,status) SELECT ('a8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a1000000-0000-4000-8000-000000000001',('a7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a2000000-0000-4000-8000-000000000001','SCHEDULING',(CASE WHEN n=5 THEN 'IN_REVIEW' ELSE 'WAITING_HUMAN' END)::service_case_lifecycle_status FROM generate_series(1,5)n;
INSERT INTO human_handoffs(id,tenant_id,conversation_id,service_case_id,unit_id,reason,priority,status,idempotency_key,queued_at,assigned_user_id,claimed_at) SELECT
 ('a9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a1000000-0000-4000-8000-000000000001',('a7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('a8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a2000000-0000-4000-8000-000000000001','CAPACITY_TEST','NORMAL',(CASE WHEN n=5 THEN 'ACTIVE' ELSE 'QUEUED' END)::handoff_lifecycle_status,'capacity-handoff-'||n,CASE WHEN n<=3 THEN '2026-01-01 09:30Z'::timestamptz WHEN n=4 THEN '2026-01-01 09:55Z'::timestamptz ELSE '2026-01-01 09:35Z'::timestamptz END,CASE WHEN n=5 THEN 'a3000000-0000-4000-8000-000000000001'::uuid ELSE NULL END,CASE WHEN n=5 THEN '2026-01-01 09:35Z'::timestamptz ELSE NULL END FROM generate_series(1,5)n;
SELECT set_config('app.tenant_id','a1000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','a3000000-0000-4000-8000-000000000001',true),set_config('app.correlation_id','capacity-alert-test',true);
INSERT INTO unit_operational_timezone_versions(tenant_id,unit_id,time_zone,version,created_by_user_id) VALUES('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','UTC',1,'a3000000-0000-4000-8000-000000000001');
INSERT INTO unit_shift_schedule_versions(tenant_id,unit_id,user_id,version,effective_from,time_zone,weekly_slots,exceptions,created_by_user_id) VALUES('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001',1,'2026-01-01','UTC','[{"weekday":4,"start":"09:00","end":"11:00"}]','[]','a3000000-0000-4000-8000-000000000001');
UPDATE attendant_unit_availability SET status='AVAILABLE',max_active=3 WHERE tenant_id='a1000000-0000-4000-8000-000000000001' AND unit_id='a2000000-0000-4000-8000-000000000001' AND user_id='a3000000-0000-4000-8000-000000000001';
DO $$ DECLARE missing record;published record;replayed record;snapshot record;blocked boolean;body text;BEGIN
 SELECT * INTO missing FROM get_unit_capacity_alert_policy('a2000000-0000-4000-8000-000000000001');
 IF missing.enabled OR missing.version<>0 OR missing.minimum_queued IS NOT NULL OR missing.sustained_minutes IS NOT NULL THEN RAISE EXCEPTION 'CAPACITY_ALERT_IMPLICIT_DEFAULT_FORBIDDEN';END IF;
 SELECT * INTO published FROM set_unit_capacity_alert_policy('a2000000-0000-4000-8000-000000000001',true,3,15,0,'capacity-alert-key-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 SELECT * INTO replayed FROM set_unit_capacity_alert_policy('a2000000-0000-4000-8000-000000000001',true,3,15,0,'capacity-alert-key-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 IF published.version<>1 OR published.replayed OR NOT replayed.replayed OR replayed.version<>1 THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_REPLAY_INVALID';END IF;
 blocked:=false;BEGIN PERFORM set_unit_capacity_alert_policy('a2000000-0000-4000-8000-000000000001',true,4,15,0,'capacity-alert-key-1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=SQLERRM='CAPACITY_ALERT_POLICY_IDEMPOTENCY_CONFLICT';END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAPACITY_ALERT_DIVERGENT_REPLAY_ACCEPTED';END IF;
 SELECT * INTO snapshot FROM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');
 IF snapshot.state<>'ACTIVE' OR snapshot.queued_count<>4 OR snapshot.sustained_queued_count<>3 OR snapshot.available_capacity<>2 OR snapshot.oldest_queued_at<>'2026-01-01 09:30Z'::timestamptz THEN RAISE EXCEPTION 'CAPACITY_ALERT_ACTIVE_INVALID';END IF;
 -- Episode lifecycle is durable and deduplicated: the first evaluation opens
 -- one episode, repeated evaluations stay inside cooldown, acknowledgement
 -- persists a reason, and the next eligible evaluation escalates it.
 <<episode_lifecycle>>
 DECLARE episode record;repeat_episode record;ack record;escalated record;episode_key text:='capacity-episode-ack-1';episode_fp text;
 BEGIN
   SELECT * INTO episode FROM evaluate_unit_capacity_alert_episode('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');
   IF episode.status<>'OPEN' OR NOT episode.should_notify OR episode.escalation_level<>0 OR episode.recipient_count<>1 THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_OPEN_INVALID';END IF;
   SELECT * INTO repeat_episode FROM evaluate_unit_capacity_alert_episode('a2000000-0000-4000-8000-000000000001','2026-01-01 10:05Z');
   IF repeat_episode.episode_id<>episode.episode_id OR repeat_episode.should_notify OR repeat_episode.version<>episode.version+1 THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_COOLDOWN_INVALID';END IF;
   episode_fp:=encode(digest(convert_to(format('{"expectedVersion":%s,"episodeId":"%s","reason":"%s"}',repeat_episode.version,
     lower(repeat_episode.episode_id::text),'Supervisor reviewed queue'),'UTF8'),'sha256'),'hex');
   SELECT * INTO ack FROM acknowledge_capacity_alert_episode(repeat_episode.episode_id,repeat_episode.version,'Supervisor reviewed queue',episode_key,episode_fp);
   IF ack.status<>'ACKNOWLEDGED' OR ack.replayed OR ack.version<>repeat_episode.version+1 THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_ACK_INVALID';END IF;
   SELECT * INTO escalated FROM evaluate_unit_capacity_alert_episode('a2000000-0000-4000-8000-000000000001','2026-01-01 10:16Z');
   IF escalated.episode_id<>episode.episode_id OR escalated.status<>'ESCALATED' OR NOT escalated.should_notify OR escalated.escalation_level<>1 THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_ESCALATION_INVALID';END IF;
   IF (SELECT count(*) FROM unit_capacity_alert_episode_recipients WHERE tenant_id='a1000000-0000-4000-8000-000000000001' AND episode_id=episode.episode_id)<>1
     OR (SELECT acknowledgement_reason FROM unit_capacity_alert_episodes WHERE id=episode.episode_id)<>'Supervisor reviewed queue' THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_RECIPIENT_OR_REASON_INVALID';END IF;
 END episode_lifecycle;
 UPDATE human_handoffs SET status='RESOLVED',resolved_at='2026-01-01 09:50Z' WHERE id='a9000000-0000-4000-8000-000000000005';
 SELECT * INTO snapshot FROM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');
 IF snapshot.available_capacity<>3 OR snapshot.state<>'ACTIVE' THEN RAISE EXCEPTION 'CAPACITY_ALERT_ACTIVE_LOAD_NOT_COUNTED_ONCE';END IF;
 UPDATE unit_shift_schedule_versions SET exceptions='[{"date":"2026-01-01","type":"CLOSED"}]' WHERE unit_id='a2000000-0000-4000-8000-000000000001';
 SELECT * INTO snapshot FROM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');IF snapshot.available_capacity<>0 OR snapshot.state<>'CLEAR' THEN RAISE EXCEPTION 'CAPACITY_ALERT_CLOSED_NOT_CLEAR';END IF;
 UPDATE unit_shift_schedule_versions SET exceptions='[]' WHERE unit_id='a2000000-0000-4000-8000-000000000001';UPDATE attendant_unit_availability SET status='PAUSED',pause_reason='BREAK' WHERE unit_id='a2000000-0000-4000-8000-000000000001';
 SELECT * INTO snapshot FROM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');IF snapshot.available_capacity<>0 OR snapshot.state<>'CLEAR' THEN RAISE EXCEPTION 'CAPACITY_ALERT_PAUSED_NOT_CLEAR';END IF;
 SELECT pg_get_functiondef('list_inbox_sla_alerts(uuid,integer,text,text,timestamptz,integer,integer,timestamptz,timestamptz,uuid)'::regprocedure) INTO body;
 IF body NOT LIKE '%WITH capacity AS MATERIALIZED%' OR (length(body)-length(replace(body,'get_unit_available_capacity_internal','')))/length('get_unit_available_capacity_internal')<>1 THEN RAISE EXCEPTION 'CAPACITY_HELPER_NOT_SINGLE_MATERIALIZED_USE';END IF;
 IF (SELECT count(*) FROM audit_events WHERE action='CAPACITY_ALERT_POLICY_PUBLISHED')<>1 OR EXISTS(SELECT 1 FROM outbox_events WHERE aggregate_type='unit_capacity_alert_policy') THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_SIDE_EFFECT_INVALID';END IF;
END$$;
SELECT set_config('app.actor_id','a3000000-0000-4000-8000-000000000002',true);
DO $$ DECLARE blocked boolean:=false;BEGIN BEGIN PERFORM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=SQLERRM='CAPACITY_ALERT_POLICY_NOT_FOUND';END;IF NOT blocked THEN RAISE EXCEPTION 'CAPACITY_ALERT_UNAUTHORIZED_READ';END IF;END$$;
SELECT set_config('app.tenant_id','b1000000-0000-4000-8000-000000000001',true),set_config('app.actor_id','b3000000-0000-4000-8000-000000000001',true);
DO $$ DECLARE blocked boolean:=false;BEGIN BEGIN PERFORM get_unit_capacity_alert_snapshot('a2000000-0000-4000-8000-000000000001','2026-01-01 10:00Z');EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=SQLERRM='CAPACITY_ALERT_POLICY_NOT_FOUND';END;IF NOT blocked THEN RAISE EXCEPTION 'CAPACITY_ALERT_CROSS_TENANT_READ';END IF;END$$;
DO $$ BEGIN IF has_table_privilege('zap_pronto_api','unit_capacity_alert_policy_versions','SELECT') OR has_function_privilege('zap_pronto_worker','get_unit_capacity_alert_snapshot(uuid,timestamptz)','EXECUTE') OR NOT has_function_privilege('zap_pronto_api','get_unit_capacity_alert_snapshot(uuid,timestamptz)','EXECUTE') OR NOT has_function_privilege('zap_pronto_api','list_unit_capacity_alert_episodes(uuid,text,integer)','EXECUTE') OR NOT has_function_privilege('zap_pronto_api','resolve_unit_capacity_alert_episode(uuid)','EXECUTE') OR NOT has_function_privilege('zap_pronto_api','acknowledge_capacity_alert_episode(uuid,integer,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'CAPACITY_ALERT_PRIVILEGE_INVALID';END IF;IF NOT(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='unit_capacity_alert_policy_versions'::regclass) OR NOT(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='unit_capacity_alert_episodes'::regclass)THEN RAISE EXCEPTION 'CAPACITY_ALERT_RLS_NOT_FORCED';END IF;END$$;
ROLLBACK;
