BEGIN;

CREATE TABLE attendant_unit_availability(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  unit_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN('OFFLINE','AVAILABLE','PAUSED')),
  max_active integer NOT NULL CHECK(max_active BETWEEN 1 AND 100),
  pause_reason text CHECK(pause_reason IN('BREAK','TRAINING','MEETING','OTHER_OPERATIONAL')),
  paused_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,user_id,unit_id),
  FOREIGN KEY(tenant_id,user_id,unit_id) REFERENCES user_units(tenant_id,user_id,unit_id),
  CHECK((status='PAUSED' AND pause_reason IS NOT NULL) OR
    (status<>'PAUSED' AND pause_reason IS NULL AND paused_until IS NULL))
);

INSERT INTO attendant_unit_availability(tenant_id,unit_id,user_id,status,max_active)
SELECT membership.tenant_id,membership.unit_id,membership.user_id,
  CASE WHEN EXISTS(SELECT 1 FROM human_handoffs handoff WHERE handoff.tenant_id=membership.tenant_id
    AND handoff.unit_id=membership.unit_id AND handoff.assigned_user_id=membership.user_id AND handoff.status='ACTIVE')
    THEN 'AVAILABLE' ELSE 'OFFLINE' END,100
FROM user_units membership WHERE membership.status='ACTIVE';

CREATE TABLE attendant_availability_commands(
  tenant_id uuid NOT NULL REFERENCES tenants(id), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  unit_id uuid NOT NULL,user_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),
  requested_status text NOT NULL,requested_max_active integer NOT NULL,requested_pause_reason text,requested_paused_until timestamptz,
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),result_active_count integer NOT NULL CHECK(result_active_count>=0),
  result_version integer NOT NULL,result_updated_at timestamptz NOT NULL,
  correlation_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,user_id,unit_id) REFERENCES attendant_unit_availability(tenant_id,user_id,unit_id)
);

ALTER TABLE attendant_unit_availability ENABLE ROW LEVEL SECURITY; ALTER TABLE attendant_unit_availability FORCE ROW LEVEL SECURITY;
ALTER TABLE attendant_availability_commands ENABLE ROW LEVEL SECURITY; ALTER TABLE attendant_availability_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY attendant_unit_availability_tenant ON attendant_unit_availability USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY attendant_availability_commands_tenant ON attendant_availability_commands USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON attendant_unit_availability,attendant_availability_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION get_actor_unit_availability(requested_unit_id uuid)
RETURNS TABLE(unit_id uuid,user_id uuid,status text,max_active integer,pause_reason text,paused_until timestamptz,
  active_count integer,version integer,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT availability.unit_id,availability.user_id,availability.status,availability.max_active,availability.pause_reason,
    availability.paused_until,count(handoff.id)::integer,availability.version,availability.updated_at
  FROM public.attendant_unit_availability availability
  LEFT JOIN public.human_handoffs handoff ON handoff.tenant_id=availability.tenant_id AND handoff.unit_id=availability.unit_id
    AND handoff.assigned_user_id=availability.user_id AND handoff.status='ACTIVE'
  WHERE availability.tenant_id=public.current_app_tenant_id() AND availability.unit_id=requested_unit_id
    AND availability.user_id=public.current_app_actor_id()
    AND EXISTS(SELECT 1 FROM public.user_units membership WHERE membership.tenant_id=availability.tenant_id
      AND membership.unit_id=availability.unit_id AND membership.user_id=availability.user_id AND membership.status='ACTIVE')
  GROUP BY availability.tenant_id,availability.unit_id,availability.user_id
$$;
REVOKE ALL ON FUNCTION get_actor_unit_availability(uuid) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION get_actor_unit_availability(uuid) TO zap_pronto_api;

CREATE FUNCTION set_actor_unit_availability(requested_unit_id uuid,requested_status text,requested_max_active integer,
  requested_pause_reason text,requested_paused_until timestamptz,requested_expected_version integer,requested_key text,requested_fingerprint text)
RETURNS TABLE(unit_id uuid,user_id uuid,status text,max_active integer,pause_reason text,paused_until timestamptz,
  active_count integer,version integer,updated_at timestamptz,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE a public.attendant_unit_availability%ROWTYPE;c public.attendant_availability_commands%ROWTYPE;
  normalized_key text:=btrim(requested_key);normalized_status text:=btrim(requested_status);normalized_reason text:=nullif(btrim(requested_pause_reason),'');
  computed text;active_total integer;next_version integer;changed_at timestamptz:=now();
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR normalized_status NOT IN('OFFLINE','AVAILABLE','PAUSED') OR requested_max_active NOT BETWEEN 1 AND 100
    OR requested_expected_version IS NULL OR requested_expected_version<1 OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR (normalized_status='PAUSED' AND (normalized_reason NOT IN('BREAK','TRAINING','MEETING','OTHER_OPERATIONAL')
      OR (requested_paused_until IS NOT NULL AND requested_paused_until<=changed_at)))
    OR (normalized_status<>'PAUSED' AND (normalized_reason IS NOT NULL OR requested_paused_until IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVALID_AVAILABILITY_REQUEST' USING ERRCODE='P0001'; END IF;
  computed:=encode(digest(convert_to(format('{"expectedVersion":%s,"maxActive":%s,"pauseReason":%s,"pausedUntil":%s,"status":"%s","unitId":"%s"}',
    requested_expected_version,requested_max_active,CASE WHEN normalized_reason IS NULL THEN 'null' ELSE to_json(normalized_reason)::text END,
    CASE WHEN requested_paused_until IS NULL THEN 'null' ELSE to_json(to_char(requested_paused_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text END,
    normalized_status,lower(requested_unit_id::text)),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed THEN RAISE EXCEPTION 'INVALID_AVAILABILITY_REQUEST' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(public.current_app_tenant_id()::text||':availability:'||normalized_key,0));
  SELECT command.* INTO c FROM public.attendant_availability_commands command WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF c.unit_id<>requested_unit_id OR c.user_id<>public.current_app_actor_id() OR c.expected_version<>requested_expected_version OR c.request_fingerprint<>computed
      THEN RAISE EXCEPTION 'AVAILABILITY_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    RETURN QUERY SELECT c.unit_id,c.user_id,c.requested_status,c.requested_max_active,c.requested_pause_reason,c.requested_paused_until,
      c.result_active_count,c.result_version,c.result_updated_at,true; RETURN;
  END IF;
  SELECT av.* INTO a FROM public.attendant_unit_availability av WHERE av.tenant_id=public.current_app_tenant_id()
    AND av.unit_id=requested_unit_id AND av.user_id=public.current_app_actor_id() FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
    JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id WHERE membership.tenant_id=a.tenant_id
    AND membership.unit_id=a.unit_id AND membership.user_id=a.user_id AND membership.status='ACTIVE' AND account.status='ACTIVE' AND unit.active)
    THEN RAISE EXCEPTION 'AVAILABILITY_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF a.version<>requested_expected_version THEN RAISE EXCEPTION 'AVAILABILITY_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT count(*)::integer INTO active_total FROM public.human_handoffs h WHERE h.tenant_id=a.tenant_id AND h.unit_id=a.unit_id AND h.assigned_user_id=a.user_id AND h.status='ACTIVE';
  IF active_total>0 AND (normalized_status<>'AVAILABLE' OR requested_max_active<active_total) THEN RAISE EXCEPTION 'AVAILABILITY_ACTIVE_WORK_CONFLICT' USING ERRCODE='P0001'; END IF;
  UPDATE public.attendant_unit_availability av SET status=normalized_status,max_active=requested_max_active,pause_reason=normalized_reason,
    paused_until=requested_paused_until,version=av.version+1,updated_at=changed_at WHERE av.tenant_id=a.tenant_id AND av.unit_id=a.unit_id AND av.user_id=a.user_id RETURNING av.version INTO next_version;
  INSERT INTO public.attendant_availability_commands(tenant_id,idempotency_key,unit_id,user_id,expected_version,requested_status,requested_max_active,
    requested_pause_reason,requested_paused_until,request_fingerprint,result_active_count,result_version,result_updated_at,correlation_id) VALUES(a.tenant_id,normalized_key,a.unit_id,a.user_id,
    requested_expected_version,normalized_status,requested_max_active,normalized_reason,requested_paused_until,computed,active_total,next_version,changed_at,current_setting('app.correlation_id'));
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES(a.tenant_id,'USER',a.user_id,
    'ATTENDANT_AVAILABILITY_CHANGED','attendant_availability',a.unit_id::text,jsonb_build_object('status',normalized_status,'maxActive',requested_max_active,'version',next_version));
  RETURN QUERY SELECT av.unit_id,av.user_id,av.status,av.max_active,av.pause_reason,av.paused_until,active_total,av.version,av.updated_at,false
    FROM public.attendant_unit_availability av WHERE av.tenant_id=a.tenant_id AND av.unit_id=a.unit_id AND av.user_id=a.user_id;
END$$;
REVOKE ALL ON FUNCTION set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION set_actor_unit_availability(uuid,text,integer,text,timestamptz,integer,text,text) TO zap_pronto_api;

CREATE FUNCTION ensure_membership_availability() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF NEW.status='ACTIVE' THEN INSERT INTO public.attendant_unit_availability(tenant_id,user_id,unit_id,status,max_active)
    VALUES(NEW.tenant_id,NEW.user_id,NEW.unit_id,'OFFLINE',100) ON CONFLICT(tenant_id,user_id,unit_id) DO NOTHING; END IF;
  RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION ensure_membership_availability() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE TRIGGER user_units_ensure_availability AFTER INSERT OR UPDATE OF status ON user_units FOR EACH ROW EXECUTE FUNCTION ensure_membership_availability();

CREATE OR REPLACE FUNCTION list_inbox_handoff_transfer_candidates(requested_handoff_id uuid)
RETURNS TABLE(id uuid,display_name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT candidate.id,pg_catalog.left(candidate.display_name,160) FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.user_units membership ON membership.tenant_id=handoff.tenant_id AND membership.unit_id=handoff.unit_id AND membership.status='ACTIVE'
  JOIN public.users candidate ON candidate.tenant_id=membership.tenant_id AND candidate.id=membership.user_id AND candidate.status='ACTIVE'
  JOIN public.attendant_unit_availability availability ON availability.tenant_id=membership.tenant_id AND availability.unit_id=membership.unit_id
    AND availability.user_id=membership.user_id AND availability.status='AVAILABLE'
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id AND handoff.status='ACTIVE'
    AND handoff.assigned_user_id=public.current_app_actor_id() AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id() AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id)
    AND candidate.id<>public.current_app_actor_id() AND (SELECT count(*) FROM public.human_handoffs active WHERE active.tenant_id=availability.tenant_id
      AND active.unit_id=availability.unit_id AND active.assigned_user_id=availability.user_id AND active.status='ACTIVE')<availability.max_active
  ORDER BY candidate.display_name,candidate.id
$$;

CREATE OR REPLACE FUNCTION enforce_active_human_assignee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE availability public.attendant_unit_availability%ROWTYPE;active_total integer;
BEGIN
  IF NEW.assigned_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':membership-lifecycle',0));
    IF NEW.unit_id IS NULL THEN RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001'; END IF;
    PERFORM 1 FROM public.user_units membership WHERE membership.tenant_id=NEW.tenant_id AND membership.user_id=NEW.assigned_user_id
      AND membership.unit_id=NEW.unit_id FOR KEY SHARE OF membership;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id WHERE membership.tenant_id=NEW.tenant_id
      AND membership.user_id=NEW.assigned_user_id AND membership.unit_id=NEW.unit_id AND membership.status='ACTIVE' AND account.status='ACTIVE' AND unit.active)
      THEN RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001'; END IF;
    IF TG_TABLE_NAME='human_handoffs' THEN
      IF NEW.status='ACTIVE' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'ACTIVE' OR OLD.assigned_user_id IS DISTINCT FROM NEW.assigned_user_id) THEN
        SELECT av.* INTO availability FROM public.attendant_unit_availability av WHERE av.tenant_id=NEW.tenant_id AND av.unit_id=NEW.unit_id AND av.user_id=NEW.assigned_user_id FOR UPDATE;
        SELECT count(*)::integer INTO active_total FROM public.human_handoffs h WHERE h.tenant_id=NEW.tenant_id AND h.unit_id=NEW.unit_id AND h.assigned_user_id=NEW.assigned_user_id AND h.status='ACTIVE' AND h.id<>NEW.id;
        IF availability.user_id IS NULL OR availability.status<>'AVAILABLE' OR active_total>=availability.max_active THEN RAISE EXCEPTION 'ASSIGNEE_NOT_AVAILABLE' USING ERRCODE='P0001'; END IF;
      END IF;
    END IF;
  END IF; RETURN NEW;
END$$;

COMMIT;
