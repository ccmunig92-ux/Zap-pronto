BEGIN;

CREATE TABLE invitation_acceptance_rate_limits (
  principal_key_hash bytea PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT invitation_acceptance_rate_limits_hash_length CHECK (octet_length(principal_key_hash) = 32),
  CONSTRAINT invitation_acceptance_rate_limits_attempts_positive CHECK (attempts > 0),
  CONSTRAINT invitation_acceptance_rate_limits_time_order CHECK (updated_at >= window_started_at)
);

CREATE INDEX invitation_acceptance_rate_limits_cleanup_idx
  ON invitation_acceptance_rate_limits (updated_at, principal_key_hash);

ALTER TABLE invitation_acceptance_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_acceptance_rate_limits FORCE ROW LEVEL SECURITY;

CREATE POLICY invitation_acceptance_rate_limits_deny_direct
  ON invitation_acceptance_rate_limits
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE invitation_acceptance_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE invitation_acceptance_rate_limits FROM zap_pronto_app, zap_pronto_api, zap_pronto_worker;

CREATE FUNCTION consume_invitation_acceptance_rate_limit(requested_principal_key_hash bytea)
RETURNS TABLE (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer,
  reset_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  limiter_now timestamptz := clock_timestamp();
  current_attempts integer;
  current_window_started_at timestamptz;
BEGIN
  IF requested_principal_key_hash IS NULL OR octet_length(requested_principal_key_hash) <> 32 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_PRINCIPAL_KEY_HASH' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invitation_acceptance_rate_limits AS rate_limit
    (principal_key_hash, window_started_at, attempts, updated_at)
  VALUES (requested_principal_key_hash, limiter_now, 1, limiter_now)
  ON CONFLICT (principal_key_hash) DO UPDATE
  SET window_started_at = CASE
        WHEN rate_limit.window_started_at + interval '15 minutes' <= limiter_now THEN limiter_now
        ELSE rate_limit.window_started_at
      END,
      attempts = CASE
        WHEN rate_limit.window_started_at + interval '15 minutes' <= limiter_now THEN 1
        ELSE rate_limit.attempts + 1
      END,
      updated_at = limiter_now
  RETURNING rate_limit.attempts, rate_limit.window_started_at
  INTO current_attempts, current_window_started_at;

  allowed := current_attempts <= 10;
  remaining := greatest(10 - current_attempts, 0);
  reset_at := current_window_started_at + interval '15 minutes';
  retry_after_seconds := CASE
    WHEN allowed THEN 0
    ELSE greatest(1, ceil(extract(epoch FROM reset_at - limiter_now))::integer)
  END;

  -- A small SKIP LOCKED batch keeps cleanup bounded and out of competing hot keys.
  WITH stale AS (
    SELECT candidate.principal_key_hash
    FROM public.invitation_acceptance_rate_limits AS candidate
    WHERE candidate.updated_at < limiter_now - interval '1 day'
      AND candidate.principal_key_hash <> requested_principal_key_hash
    ORDER BY candidate.updated_at, candidate.principal_key_hash
    LIMIT 25
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.invitation_acceptance_rate_limits AS candidate
  USING stale
  WHERE candidate.principal_key_hash = stale.principal_key_hash;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION consume_invitation_acceptance_rate_limit(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_invitation_acceptance_rate_limit(bytea) FROM zap_pronto_app, zap_pronto_worker;
GRANT EXECUTE ON FUNCTION consume_invitation_acceptance_rate_limit(bytea) TO zap_pronto_api;

COMMENT ON TABLE invitation_acceptance_rate_limits IS
  'Fixed-window distributed limiter for invitation acceptance. Stores only a versioned SHA-256 principal key hash.';
COMMENT ON FUNCTION consume_invitation_acceptance_rate_limit(bytea) IS
  'Atomically consumes one of 10 attempts in a fixed 15-minute window. Call and commit before starting invitation acceptance.';

COMMIT;
