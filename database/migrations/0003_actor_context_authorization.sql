BEGIN;

CREATE FUNCTION current_app_actor_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  value text;
BEGIN
  value := current_setting('app.actor_id', true);
  IF value IS NULL OR value = '' THEN
    RAISE EXCEPTION 'ACTOR_CONTEXT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    RETURN value::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ACTOR_CONTEXT_INVALID' USING ERRCODE = 'P0001';
  END;
END
$$;

CREATE FUNCTION assert_app_context_authorized() RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE tenant_id = public.current_app_tenant_id()
      AND id = public.current_app_actor_id()
      AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'APP_CONTEXT_UNAUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION current_app_actor_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_app_context_authorized() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_actor_id() TO zap_pronto_app;
GRANT EXECUTE ON FUNCTION assert_app_context_authorized() TO zap_pronto_app;

COMMIT;
