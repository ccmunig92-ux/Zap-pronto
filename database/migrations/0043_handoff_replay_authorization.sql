BEGIN;

ALTER TABLE handoff_resolve_commands ADD COLUMN unit_id uuid;
UPDATE handoff_resolve_commands command SET unit_id=handoff.unit_id
FROM human_handoffs handoff
WHERE handoff.tenant_id=command.tenant_id AND handoff.id=command.handoff_id;
ALTER TABLE handoff_resolve_commands
  ALTER COLUMN unit_id SET NOT NULL,
  ADD CONSTRAINT handoff_resolve_commands_unit_fk
    FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id);

ALTER TABLE handoff_requeue_commands ADD COLUMN unit_id uuid;
UPDATE handoff_requeue_commands command SET unit_id=handoff.unit_id
FROM human_handoffs handoff
WHERE handoff.tenant_id=command.tenant_id AND handoff.id=command.handoff_id;
ALTER TABLE handoff_requeue_commands
  ALTER COLUMN unit_id SET NOT NULL,
  ADD CONSTRAINT handoff_requeue_commands_unit_fk
    FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id);

CREATE FUNCTION set_handoff_command_unit_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF NEW.unit_id IS NULL THEN
    SELECT handoff.unit_id INTO NEW.unit_id FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=NEW.tenant_id AND handoff.id=NEW.handoff_id;
  END IF;
  IF NEW.unit_id IS NULL THEN
    RAISE EXCEPTION 'HANDOFF_COMMAND_UNIT_NOT_FOUND' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION set_handoff_command_unit_id()
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;
CREATE TRIGGER handoff_resolve_commands_set_unit
  BEFORE INSERT ON handoff_resolve_commands FOR EACH ROW EXECUTE FUNCTION set_handoff_command_unit_id();
CREATE TRIGGER handoff_requeue_commands_set_unit
  BEFORE INSERT ON handoff_requeue_commands FOR EACH ROW EXECUTE FUNCTION set_handoff_command_unit_id();

ALTER FUNCTION resolve_inbox_handoff(uuid,integer,text,text,text)
  RENAME TO resolve_inbox_handoff_disposition_v0042;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_disposition_v0042(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION resolve_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_disposition text,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,handoff_version integer,
  conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE command_unit_id uuid;command_found boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  SELECT command.unit_id INTO command_unit_id
  FROM public.handoff_resolve_commands command
  WHERE command.tenant_id=public.current_app_tenant_id()
    AND command.idempotency_key=requested_idempotency_key;
  command_found:=FOUND;
  IF command_found AND NOT public.current_actor_has_permission('handoff.resolve',command_unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_RESOLVE_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT result.handoff_id,result.conversation_id,result.service_case_id,
    result.handoff_version,result.conversation_version,result.replayed
  FROM public.resolve_inbox_handoff_disposition_v0042(requested_handoff_id,requested_expected_version,
    requested_disposition,requested_idempotency_key,requested_fingerprint) result;
END $$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff(uuid,integer,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff(uuid,integer,text,text,text) TO zap_pronto_api;

ALTER FUNCTION requeue_inbox_handoff(uuid,integer,text)
  RENAME TO requeue_inbox_handoff_v0030;
REVOKE ALL ON FUNCTION requeue_inbox_handoff_v0030(uuid,integer,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION requeue_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_idempotency_key text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,handoff_version integer,
  conversation_version integer,service_case_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE command_unit_id uuid;command_found boolean;
BEGIN
  PERFORM public.assert_app_context_authorized();
  SELECT command.unit_id INTO command_unit_id
  FROM public.handoff_requeue_commands command
  WHERE command.tenant_id=public.current_app_tenant_id()
    AND command.idempotency_key=pg_catalog.btrim(requested_idempotency_key);
  command_found:=FOUND;
  IF command_found AND NOT public.current_actor_has_permission('handoff.requeue',command_unit_id) THEN
    RAISE EXCEPTION 'HANDOFF_REQUEUE_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT result.handoff_id,result.conversation_id,result.service_case_id,
    result.handoff_version,result.conversation_version,result.service_case_version,result.replayed
  FROM public.requeue_inbox_handoff_v0030(requested_handoff_id,requested_expected_version,
    requested_idempotency_key) result;
END $$;
REVOKE ALL ON FUNCTION requeue_inbox_handoff(uuid,integer,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION requeue_inbox_handoff(uuid,integer,text) TO zap_pronto_api;

COMMIT;
