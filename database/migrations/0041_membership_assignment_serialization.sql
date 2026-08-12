BEGIN;

/*
 * Assignment and membership lifecycle share one tenant-scoped serialization
 * boundary.  Without it, a lifecycle transaction could observe no active work
 * while a concurrent claim/transfer/takeover assigned the same membership.
 */
CREATE OR REPLACE FUNCTION enforce_active_human_assignee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':membership-lifecycle',0));
    IF NEW.unit_id IS NULL THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001';
    END IF;
    PERFORM 1 FROM public.user_units membership
      WHERE membership.tenant_id=NEW.tenant_id AND membership.user_id=NEW.assigned_user_id
        AND membership.unit_id=NEW.unit_id
      FOR KEY SHARE OF membership;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_units membership
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=NEW.tenant_id AND membership.user_id=NEW.assigned_user_id
        AND membership.unit_id=NEW.unit_id AND membership.status='ACTIVE'
        AND account.status='ACTIVE' AND unit.active
    ) THEN RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_active_human_assignee() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

/* A modern request cannot silently replay a pre-reason command. */
ALTER FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text)
  RENAME TO transfer_inbox_handoff_reason_v0040;
REVOKE ALL ON FUNCTION transfer_inbox_handoff_reason_v0040(uuid,integer,uuid,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION transfer_inbox_handoff(requested_handoff_id uuid,requested_expected_version integer,
  requested_target_user_id uuid,requested_reason text,requested_key text,requested_fingerprint text)
RETURNS TABLE(handoff_id uuid,conversation_id uuid,service_case_id uuid,target_user_id uuid,
  handoff_version integer,conversation_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF EXISTS (SELECT 1 FROM public.handoff_transfer_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.reason='LEGACY_UNSPECIFIED') THEN
    RAISE EXCEPTION 'HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT result.handoff_id,result.conversation_id,result.service_case_id,result.target_user_id,
    result.handoff_version,result.conversation_version,result.replayed
  FROM public.transfer_inbox_handoff_reason_v0040(requested_handoff_id,requested_expected_version,
    requested_target_user_id,requested_reason,requested_key,requested_fingerprint) result;
END $$;
REVOKE ALL ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION transfer_inbox_handoff(uuid,integer,uuid,text,text,text) TO zap_pronto_api;

/*
 * Keep the canonical implementation in 0040 unchanged except for fencing
 * legacy command rows before they can be returned as a modern replay.
 */
CREATE OR REPLACE FUNCTION resolve_inbox_handoff_transfer_unit(requested_handoff_id uuid,requested_expected_version integer,
  requested_target_user_id uuid,requested_reason text,requested_key text,requested_fingerprint text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT unit_id FROM (
    SELECT handoff.unit_id,1 AS precedence FROM public.human_handoffs handoff
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
      AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
      AND service_case.status='IN_REVIEW' AND conversation.status='OPEN'
      AND conversation.automation_status='HUMAN_ACTIVE' AND conversation.assigned_user_id=public.current_app_actor_id()
      AND service_case.unit_id=handoff.unit_id AND service_case.conversation_id=handoff.conversation_id
      AND conversation.unit_id=handoff.unit_id
    UNION ALL
    SELECT command.unit_id,2 FROM public.handoff_transfer_commands command
    WHERE command.tenant_id=public.current_app_tenant_id() AND command.idempotency_key=btrim(requested_key)
      AND command.handoff_id=requested_handoff_id AND command.expected_version=requested_expected_version
      AND command.target_user_id=requested_target_user_id AND command.actor_id=public.current_app_actor_id()
      AND command.reason<>'LEGACY_UNSPECIFIED' AND command.reason=btrim(requested_reason)
      AND command.request_fingerprint=requested_fingerprint
  ) authorized ORDER BY precedence LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbox_handoff_transfer_unit(uuid,integer,uuid,text,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_inbox_handoff_transfer_unit(uuid,integer,uuid,text,text,text) TO zap_pronto_api;

COMMIT;
