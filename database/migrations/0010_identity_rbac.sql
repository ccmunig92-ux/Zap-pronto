BEGIN;

CREATE TABLE app_roles (
  code text PRIMARY KEY,
  CHECK (code IN ('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT','AUDITOR'))
);

CREATE TABLE app_permissions (
  code text PRIMARY KEY,
  CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE TABLE app_role_permissions (
  role_code text NOT NULL REFERENCES app_roles(code),
  permission_code text NOT NULL REFERENCES app_permissions(code),
  PRIMARY KEY (role_code, permission_code)
);

INSERT INTO app_roles (code) VALUES
  ('TENANT_ADMIN'), ('UNIT_MANAGER'), ('SUPERVISOR'), ('ATTENDANT'), ('AUDITOR');

INSERT INTO app_permissions (code) VALUES
  ('tenant.users.manage'), ('unit.members.manage'),
  ('handoff.read'), ('handoff.claim'),
  ('quote.read'), ('quote.review'), ('quote.publish'),
  ('medical_order.read'), ('medical_order.review');

INSERT INTO app_role_permissions (role_code, permission_code)
SELECT 'TENANT_ADMIN', code FROM app_permissions;

INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('UNIT_MANAGER','unit.members.manage'),
  ('UNIT_MANAGER','handoff.read'), ('UNIT_MANAGER','handoff.claim'),
  ('UNIT_MANAGER','quote.read'), ('UNIT_MANAGER','quote.review'), ('UNIT_MANAGER','quote.publish'),
  ('UNIT_MANAGER','medical_order.read'), ('UNIT_MANAGER','medical_order.review'),
  ('SUPERVISOR','handoff.read'), ('SUPERVISOR','handoff.claim'),
  ('SUPERVISOR','quote.read'), ('SUPERVISOR','quote.review'),
  ('SUPERVISOR','medical_order.read'), ('SUPERVISOR','medical_order.review'),
  ('ATTENDANT','handoff.read'), ('ATTENDANT','handoff.claim'),
  ('ATTENDANT','quote.read'), ('ATTENDANT','medical_order.read'),
  ('AUDITOR','handoff.read'), ('AUDITOR','quote.read'), ('AUDITOR','medical_order.read');

ALTER TABLE user_units
  ADD CONSTRAINT user_units_role_catalog_fk FOREIGN KEY (role) REFERENCES app_roles(code);

CREATE TABLE oidc_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{1,62}$'),
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$'),
  audience text NOT NULL CHECK (length(btrim(audience)) > 0),
  organization_claim text,
  organization_value text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  config_reference text NOT NULL CHECK (length(btrim(config_reference)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  CHECK ((organization_claim IS NULL) = (organization_value IS NULL)),
  CHECK (organization_claim IS NULL OR organization_claim ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,126}$'),
  CHECK (organization_value IS NULL OR length(btrim(organization_value)) > 0)
);

CREATE UNIQUE INDEX oidc_providers_resolution_key
  ON oidc_providers (
    issuer,
    audience,
    coalesce(organization_claim, ''),
    coalesce(organization_value, '')
  );

CREATE TABLE user_oidc_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  oidc_provider_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, oidc_provider_id, subject),
  UNIQUE (tenant_id, user_id, oidc_provider_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, oidc_provider_id) REFERENCES oidc_providers(tenant_id, id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

ALTER TABLE app_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON app_roles FOR SELECT USING (true);

ALTER TABLE app_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON app_permissions FOR SELECT USING (true);

ALTER TABLE app_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON app_role_permissions FOR SELECT USING (true);

ALTER TABLE oidc_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oidc_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oidc_providers FOR SELECT
  USING (tenant_id = current_app_tenant_id());

ALTER TABLE user_oidc_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_oidc_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_oidc_identities FOR SELECT
  USING (tenant_id = current_app_tenant_id());

CREATE FUNCTION resolve_oidc_principal(
  target_issuer text,
  target_audience text,
  target_subject text,
  target_organization_claim text DEFAULT NULL,
  target_organization_value text DEFAULT NULL
) RETURNS TABLE (
  tenant_id uuid,
  user_id uuid,
  oidc_provider_id uuid,
  identity_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  resolved_count integer;
BEGIN
  IF target_issuer IS NULL OR target_audience IS NULL OR target_subject IS NULL
     OR length(target_subject) = 0
     OR ((target_organization_claim IS NULL) <> (target_organization_value IS NULL)) THEN
    RAISE EXCEPTION 'AUTH_UNAUTHORIZED' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT identity.tenant_id, identity.user_id, provider.id, identity.id
  FROM public.oidc_providers provider
  JOIN public.user_oidc_identities identity
    ON identity.tenant_id = provider.tenant_id
   AND identity.oidc_provider_id = provider.id
  JOIN public.users account
    ON account.tenant_id = identity.tenant_id
   AND account.id = identity.user_id
  JOIN public.tenants tenant
    ON tenant.id = identity.tenant_id
  WHERE provider.issuer = target_issuer
    AND provider.audience = target_audience
    AND coalesce(provider.organization_claim, '') = coalesce(target_organization_claim, '')
    AND coalesce(provider.organization_value, '') = coalesce(target_organization_value, '')
    AND provider.status = 'ACTIVE'
    AND identity.subject = target_subject
    AND identity.status = 'ACTIVE'
    AND account.status = 'ACTIVE'
    AND tenant.status = 'ACTIVE';

  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  IF resolved_count <> 1 THEN
    RAISE EXCEPTION 'AUTH_UNAUTHORIZED' USING ERRCODE = '28000';
  END IF;
END
$$;

REVOKE ALL ON app_roles, app_permissions, app_role_permissions,
  oidc_providers, user_oidc_identities FROM PUBLIC, zap_pronto_app, zap_pronto_worker;
GRANT SELECT ON app_roles, app_permissions, app_role_permissions,
  oidc_providers, user_oidc_identities TO zap_pronto_api;

REVOKE ALL ON FUNCTION resolve_oidc_principal(text,text,text,text,text)
  FROM PUBLIC, zap_pronto_app, zap_pronto_worker;
GRANT EXECUTE ON FUNCTION resolve_oidc_principal(text,text,text,text,text) TO zap_pronto_api;

COMMIT;
