BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zap_pronto_outbox_executor') THEN
    CREATE ROLE zap_pronto_outbox_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE zap_pronto_outbox_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
DO $$
DECLARE
  related_role text;
BEGIN
  FOR related_role IN
    SELECT parent.rolname FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid
    WHERE member.rolname = 'zap_pronto_outbox_executor'
  LOOP
    EXECUTE format('REVOKE %I FROM zap_pronto_outbox_executor', related_role);
  END LOOP;
  FOR related_role IN
    SELECT member.rolname FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid
    WHERE parent.rolname = 'zap_pronto_outbox_executor'
  LOOP
    EXECUTE format('REVOKE zap_pronto_outbox_executor FROM %I', related_role);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA public TO zap_pronto_outbox_executor;
GRANT SELECT, UPDATE ON outbox_events TO zap_pronto_outbox_executor;
GRANT INSERT ON audit_events TO zap_pronto_outbox_executor;
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO zap_pronto_outbox_executor;
GRANT EXECUTE ON FUNCTION current_app_tenant_id() TO zap_pronto_outbox_executor;
GRANT EXECUTE ON FUNCTION current_app_actor_id() TO zap_pronto_outbox_executor;
GRANT EXECUTE ON FUNCTION assert_app_context_authorized() TO zap_pronto_outbox_executor;

DROP INDEX outbox_claim_idx;
CREATE INDEX outbox_claim_idx
  ON outbox_events (tenant_id, available_at, occurred_at, id)
  WHERE status = 'PENDING';
CREATE INDEX outbox_expired_lease_idx
  ON outbox_events (tenant_id, lease_expires_at, occurred_at, id)
  WHERE status = 'PROCESSING';

CREATE FUNCTION claim_outbox_events(batch_size integer, lease_seconds integer)
RETURNS TABLE (
  id uuid,
  aggregate_type text,
  aggregate_id uuid,
  event_type text,
  payload jsonb,
  payload_version integer,
  occurred_at timestamptz,
  attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 100 THEN
    RAISE EXCEPTION 'INVALID_OUTBOX_BATCH_SIZE' USING ERRCODE = '22023';
  END IF;
  IF lease_seconds IS NULL OR lease_seconds < 5 OR lease_seconds > 900 THEN
    RAISE EXCEPTION 'INVALID_OUTBOX_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  WITH exhausted AS (
    UPDATE public.outbox_events event
    SET status = 'DEAD', lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
        last_error = COALESCE(event.last_error, 'LEASE_EXPIRED_AT_MAX_ATTEMPTS'),
        dead_lettered_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE event.tenant_id = public.current_app_tenant_id()
      AND event.status = 'PROCESSING'
      AND event.lease_expires_at <= clock_timestamp()
      AND event.attempts >= event.max_attempts
    RETURNING event.id
  )
  INSERT INTO public.audit_events
    (tenant_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  SELECT public.current_app_tenant_id(), 'SYSTEM', public.current_app_actor_id()::text,
    'OUTBOX_DEAD_LETTERED', 'outbox_event', exhausted.id::text,
    jsonb_build_object('reason', 'LEASE_EXPIRED_AT_MAX_ATTEMPTS')
  FROM exhausted;

  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM public.outbox_events event
    WHERE event.tenant_id = public.current_app_tenant_id()
      AND event.attempts < event.max_attempts
      AND (
        (event.status = 'PENDING' AND event.available_at <= clock_timestamp())
        OR (event.status = 'PROCESSING' AND event.lease_expires_at <= clock_timestamp())
      )
    ORDER BY
      CASE WHEN event.status = 'PROCESSING' THEN event.lease_expires_at ELSE event.available_at END,
      event.occurred_at,
      event.id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_size
  )
  UPDATE public.outbox_events event
  SET status = 'PROCESSING',
      attempts = event.attempts + 1,
      lease_token = gen_random_uuid(),
      leased_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
      updated_at = clock_timestamp()
  FROM candidates
  WHERE event.id = candidates.id
    AND event.tenant_id = public.current_app_tenant_id()
  RETURNING event.id, event.aggregate_type, event.aggregate_id, event.event_type,
    event.payload, event.payload_version, event.occurred_at, event.attempts,
    event.lease_token, event.lease_expires_at;
END
$$;

CREATE FUNCTION acknowledge_outbox_event(event_id uuid, expected_lease_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
BEGIN
  PERFORM public.assert_app_context_authorized();
  UPDATE public.outbox_events event
  SET status = 'PUBLISHED',
      published_at = clock_timestamp(),
      lease_token = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = clock_timestamp()
  WHERE tenant_id = public.current_app_tenant_id()
    AND id = event_id
    AND status = 'PROCESSING'
    AND lease_token = expected_lease_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$$;

CREATE FUNCTION fail_outbox_event(
  event_id uuid,
  expected_lease_token uuid,
  error_message text,
  base_backoff_seconds integer DEFAULT 30
)
RETURNS outbox_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_status outbox_status;
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF error_message IS NULL OR length(btrim(error_message)) = 0 OR length(error_message) > 2000 THEN
    RAISE EXCEPTION 'INVALID_OUTBOX_ERROR' USING ERRCODE = '22023';
  END IF;
  IF base_backoff_seconds IS NULL OR base_backoff_seconds < 1 OR base_backoff_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_OUTBOX_BACKOFF' USING ERRCODE = '22023';
  END IF;

  UPDATE public.outbox_events event
  SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD'::outbox_status ELSE 'PENDING'::outbox_status END,
      available_at = CASE
        WHEN attempts >= max_attempts THEN available_at
        ELSE clock_timestamp() + make_interval(
          secs => LEAST(3600::double precision, base_backoff_seconds * power(2::double precision, attempts - 1))
        )
      END,
      lease_token = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error = left(error_message, 2000),
      dead_lettered_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE tenant_id = public.current_app_tenant_id()
    AND id = event_id
    AND status = 'PROCESSING'
    AND lease_token = expected_lease_token
  RETURNING event.status INTO next_status;

  IF next_status = 'DEAD' THEN
    INSERT INTO public.audit_events
      (tenant_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      public.current_app_tenant_id(), 'SYSTEM', public.current_app_actor_id()::text,
      'OUTBOX_DEAD_LETTERED', 'outbox_event', event_id::text,
      jsonb_build_object('error', left(error_message, 500))
    );
  END IF;
  RETURN next_status;
END
$$;

ALTER FUNCTION claim_outbox_events(integer, integer) OWNER TO zap_pronto_outbox_executor;
ALTER FUNCTION acknowledge_outbox_event(uuid, uuid) OWNER TO zap_pronto_outbox_executor;
ALTER FUNCTION fail_outbox_event(uuid, uuid, text, integer) OWNER TO zap_pronto_outbox_executor;

REVOKE UPDATE ON outbox_events FROM zap_pronto_worker;
REVOKE INSERT ON outbox_events FROM zap_pronto_api;
GRANT INSERT (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, occurred_at, payload_version)
  ON outbox_events TO zap_pronto_api;
REVOKE ALL ON FUNCTION claim_outbox_events(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION acknowledge_outbox_event(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_outbox_event(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_events(integer, integer) TO zap_pronto_worker;
GRANT EXECUTE ON FUNCTION acknowledge_outbox_event(uuid, uuid) TO zap_pronto_worker;
GRANT EXECUTE ON FUNCTION fail_outbox_event(uuid, uuid, text, integer) TO zap_pronto_worker;

COMMIT;
