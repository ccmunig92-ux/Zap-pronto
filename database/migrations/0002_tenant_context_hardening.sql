BEGIN;

CREATE OR REPLACE FUNCTION current_app_tenant_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  value text;
BEGIN
  value := current_setting('app.tenant_id', true);
  IF value IS NULL OR value = '' THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    RETURN value::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = 'P0001';
  END;
END
$$;

REVOKE ALL ON FUNCTION current_app_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_tenant_id() TO zap_pronto_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zap_pronto_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO zap_pronto_app;

COMMIT;
