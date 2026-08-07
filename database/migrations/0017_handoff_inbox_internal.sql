BEGIN;

ALTER TABLE human_handoffs ADD CONSTRAINT human_handoffs_tenant_id_unique UNIQUE (tenant_id,id);

CREATE TABLE handoff_claim_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  actor_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, handoff_id) REFERENCES human_handoffs(tenant_id, id)
);

ALTER TABLE handoff_claim_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_claim_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON handoff_claim_commands
  USING (tenant_id = current_app_tenant_id()) WITH CHECK (tenant_id = current_app_tenant_id());

ALTER TABLE human_handoffs ADD CONSTRAINT human_handoffs_priority_catalog
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')) NOT VALID;
ALTER TABLE human_handoffs VALIDATE CONSTRAINT human_handoffs_priority_catalog;

DROP INDEX handoffs_queue_idx;
CREATE INDEX handoffs_queue_idx
  ON human_handoffs (tenant_id, unit_id, status,
    (CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END), queued_at, id)
  WHERE status = 'QUEUED';

CREATE FUNCTION list_queued_handoffs(
  target_unit_id uuid,
  page_limit integer,
  cursor_priority text DEFAULT NULL,
  cursor_queued_at timestamptz DEFAULT NULL,
  cursor_id uuid DEFAULT NULL
) RETURNS TABLE (
  id uuid, conversation_id uuid, service_case_id uuid, unit_id uuid,
  priority text, queued_at timestamptz, sla_due_at timestamptz,
  status handoff_lifecycle_status, version integer, automation_status automation_status
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE tenant_value uuid := public.current_app_tenant_id();
BEGIN
  IF target_unit_id IS NULL OR page_limit NOT BETWEEN 1 AND 100
    OR (num_nulls(cursor_priority,cursor_queued_at,cursor_id) NOT IN (0,3))
    OR (cursor_priority IS NOT NULL AND cursor_priority NOT IN ('URGENT','HIGH','NORMAL','LOW')) THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_QUEUE_QUERY' USING ERRCODE = '22023';
  END IF;
  IF NOT public.current_actor_has_permission('handoff.read', target_unit_id) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT h.id, h.conversation_id, h.service_case_id, h.unit_id, h.priority, h.queued_at,
    h.sla_due_at, h.status, h.version, c.automation_status
  FROM public.human_handoffs h
  JOIN public.conversations c ON c.tenant_id=h.tenant_id AND c.id=h.conversation_id
  WHERE h.tenant_id=tenant_value AND h.unit_id=target_unit_id AND h.status='QUEUED'
    AND (cursor_priority IS NULL OR
      (CASE h.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,h.queued_at,h.id) >
      (CASE cursor_priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,cursor_queued_at,cursor_id))
  ORDER BY CASE h.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
    h.queued_at,h.id LIMIT page_limit;
END $$;

CREATE FUNCTION get_handoff_claim_replay(
  command_key text, target_handoff_id uuid, target_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE
  tenant_value uuid := public.current_app_tenant_id();
  actor_value uuid := public.current_app_actor_id();
  unit_value uuid;
  existing public.handoff_claim_commands%ROWTYPE;
  fingerprint bytea;
BEGIN
  IF command_key IS NULL OR length(command_key) NOT BETWEEN 8 AND 200
    OR target_handoff_id IS NULL OR target_expected_version IS NULL OR target_expected_version < 1 THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_CLAIM_COMMAND' USING ERRCODE='22023';
  END IF;
  SELECT h.unit_id INTO unit_value FROM public.human_handoffs h
    WHERE h.tenant_id=tenant_value AND h.id=target_handoff_id;
  IF unit_value IS NULL OR NOT public.current_actor_has_permission('handoff.claim',unit_value) THEN
    RAISE EXCEPTION 'HANDOFF_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  fingerprint := public.digest(convert_to(jsonb_build_array(target_handoff_id,target_expected_version,actor_value)::text,'UTF8'),'sha256');
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text||':handoff-claim:'||command_key,0));
  SELECT * INTO existing FROM public.handoff_claim_commands
    WHERE tenant_id=tenant_value AND idempotency_key=command_key;
  IF FOUND THEN
    IF existing.request_fingerprint<>fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505';
    END IF;
    RETURN existing.result;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION store_handoff_claim_result(
  command_key text, target_handoff_id uuid, target_expected_version integer, command_result jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE
  tenant_value uuid := public.current_app_tenant_id();
  actor_value uuid := public.current_app_actor_id();
  fingerprint bytea := public.digest(convert_to(jsonb_build_array(target_handoff_id,target_expected_version,actor_value)::text,'UTF8'),'sha256');
  claimed record;
BEGIN
  IF command_key IS NULL OR length(command_key) NOT BETWEEN 8 AND 200 OR target_expected_version<1
    OR command_result IS NULL OR command_result->>'id'<>target_handoff_id::text THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_CLAIM_RESULT' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text||':handoff-claim:'||command_key,0));
  SELECT h.conversation_id,h.service_case_id,h.status,h.version,h.assigned_user_id,h.unit_id
    INTO claimed FROM public.human_handoffs h
    WHERE h.tenant_id=tenant_value AND h.id=target_handoff_id;
  IF NOT FOUND OR claimed.status<>'ACTIVE' OR claimed.version<>target_expected_version+1
    OR claimed.assigned_user_id<>actor_value
    OR NOT public.current_actor_has_permission('handoff.claim',claimed.unit_id)
    OR command_result->>'conversationId'<>claimed.conversation_id::text
    OR command_result->>'serviceCaseId'<>claimed.service_case_id::text
    OR command_result->>'status'<>'ACTIVE'
    OR (command_result->>'version')::integer<>claimed.version THEN
    RAISE EXCEPTION 'INVALID_HANDOFF_CLAIM_RESULT' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.handoff_claim_commands
    (tenant_id,idempotency_key,actor_id,handoff_id,expected_version,request_fingerprint,result)
  VALUES (tenant_value,command_key,actor_value,target_handoff_id,target_expected_version,fingerprint,command_result);
END $$;

CREATE FUNCTION reject_hermes_during_human_takeover() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE current_automation public.automation_status;
BEGIN
  IF NEW.direction='OUTBOUND' AND NEW.actor='HERMES' THEN
    SELECT c.automation_status INTO current_automation FROM public.conversations c
      WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.conversation_id FOR SHARE;
    IF current_automation IS NULL OR current_automation<>'ACTIVE' THEN
      RAISE EXCEPTION 'HERMES_AUTOMATION_SUSPENDED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER messages_hermes_takeover_guard BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION reject_hermes_during_human_takeover();

REVOKE ALL ON handoff_claim_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
REVOKE ALL ON FUNCTION list_queued_handoffs(uuid,integer,text,timestamptz,uuid),
  get_handoff_claim_replay(text,uuid,integer),store_handoff_claim_result(text,uuid,integer,jsonb),
  reject_hermes_during_human_takeover()
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_queued_handoffs(uuid,integer,text,timestamptz,uuid),
  get_handoff_claim_replay(text,uuid,integer),store_handoff_claim_result(text,uuid,integer,jsonb)
  TO zap_pronto_api;

COMMIT;
