BEGIN;

CREATE TABLE initial_tenant_bootstrap_commands (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint)=32),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  unit_id uuid NOT NULL,
  admin_user_id uuid NOT NULL,
  oidc_provider_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY (tenant_id,admin_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,oidc_provider_id) REFERENCES oidc_providers(tenant_id,id)
);

ALTER TABLE initial_tenant_bootstrap_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE initial_tenant_bootstrap_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY initial_tenant_bootstrap_no_application_access
  ON initial_tenant_bootstrap_commands
  USING (current_user=pg_get_userbyid((SELECT object.relowner FROM pg_catalog.pg_class object
    WHERE object.oid='public.initial_tenant_bootstrap_commands'::regclass)))
  WITH CHECK (current_user=pg_get_userbyid((SELECT object.relowner FROM pg_catalog.pg_class object
    WHERE object.oid='public.initial_tenant_bootstrap_commands'::regclass)));

REVOKE ALL ON initial_tenant_bootstrap_commands
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE FUNCTION bootstrap_initial_tenant(
  requested_tenant_id uuid,
  requested_tenant_name text,
  requested_unit_id uuid,
  requested_unit_code text,
  requested_unit_name text,
  requested_admin_user_id uuid,
  requested_admin_email text,
  requested_admin_display_name text,
  requested_oidc_provider_id uuid,
  requested_oidc_provider_code text,
  requested_oidc_issuer text,
  requested_oidc_audience text,
  requested_oidc_organization_claim text,
  requested_oidc_organization_value text,
  requested_oidc_config_reference text,
  requested_oidc_subject text
) RETURNS TABLE (
  tenant_id uuid,
  unit_id uuid,
  admin_user_id uuid,
  oidc_provider_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  normalized_tenant_name text:=btrim(requested_tenant_name);
  normalized_unit_code text:=btrim(requested_unit_code);
  normalized_unit_name text:=btrim(requested_unit_name);
  normalized_admin_email text:=lower(btrim(requested_admin_email));
  normalized_admin_display_name text:=btrim(requested_admin_display_name);
  normalized_provider_code text:=btrim(requested_oidc_provider_code);
  normalized_issuer text:=btrim(requested_oidc_issuer);
  normalized_audience text:=btrim(requested_oidc_audience);
  normalized_claim text:=NULLIF(btrim(requested_oidc_organization_claim),'');
  normalized_value text:=NULLIF(btrim(requested_oidc_organization_value),'');
  normalized_config_reference text:=btrim(requested_oidc_config_reference);
  normalized_subject text:=requested_oidc_subject;
  computed_fingerprint bytea;
  existing_command public.initial_tenant_bootstrap_commands%ROWTYPE;
  resolved record;
BEGIN
  IF requested_tenant_id IS NULL OR requested_unit_id IS NULL
    OR requested_admin_user_id IS NULL OR requested_oidc_provider_id IS NULL
    OR requested_tenant_name IS NULL OR requested_unit_code IS NULL OR requested_unit_name IS NULL
    OR requested_admin_email IS NULL OR requested_admin_display_name IS NULL
    OR requested_oidc_provider_code IS NULL OR requested_oidc_issuer IS NULL
    OR requested_oidc_audience IS NULL OR requested_oidc_config_reference IS NULL
    OR requested_oidc_subject IS NULL
    OR cardinality(ARRAY[
      requested_tenant_id,requested_unit_id,requested_admin_user_id,requested_oidc_provider_id
    ])<>cardinality(ARRAY(
      SELECT DISTINCT value FROM unnest(ARRAY[
        requested_tenant_id,requested_unit_id,requested_admin_user_id,requested_oidc_provider_id
      ]) value
    ))
    OR length(normalized_tenant_name) NOT BETWEEN 1 AND 160
    OR normalized_unit_code !~ '^[A-Z][A-Z0-9_-]{1,31}$'
    OR length(normalized_unit_name) NOT BETWEEN 1 AND 160
    OR length(normalized_admin_email) NOT BETWEEN 3 AND 320
    OR normalized_admin_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    OR length(normalized_admin_display_name) NOT BETWEEN 1 AND 160
    OR normalized_provider_code !~ '^[a-z][a-z0-9_-]{1,62}$'
    OR normalized_issuer !~ '^https://[^[:space:]?#]+/?$'
    OR length(normalized_audience) NOT BETWEEN 1 AND 512 OR normalized_audience~'[[:space:]]'
    OR ((normalized_claim IS NULL)<>(normalized_value IS NULL))
    OR (requested_oidc_organization_claim IS NOT NULL AND btrim(requested_oidc_organization_claim)='')
    OR (requested_oidc_organization_value IS NOT NULL AND btrim(requested_oidc_organization_value)='')
    OR (normalized_claim IS NOT NULL AND normalized_claim !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,126}$')
    OR (normalized_value IS NOT NULL AND length(normalized_value)>512)
    OR length(normalized_config_reference) NOT BETWEEN 1 AND 512
    OR normalized_config_reference<>requested_oidc_config_reference
    OR normalized_config_reference !~ '^[a-z][a-z0-9+.-]{1,31}://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
    OR normalized_config_reference~'[@?#[:cntrl:][:space:]]'
    OR normalized_subject<>btrim(normalized_subject)
    OR length(normalized_subject) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_INITIAL_TENANT_BOOTSTRAP' USING ERRCODE='22023';
  END IF;

  computed_fingerprint:=digest(convert_to(jsonb_build_object(
    'adminDisplayName',normalized_admin_display_name,
    'adminEmail',normalized_admin_email,
    'adminUserId',lower(requested_admin_user_id::text),
    'oidcAudience',normalized_audience,
    'oidcConfigReference',normalized_config_reference,
    'oidcIssuer',normalized_issuer,
    'oidcOrganizationClaim',normalized_claim,
    'oidcOrganizationValue',normalized_value,
    'oidcProviderCode',normalized_provider_code,
    'oidcProviderId',lower(requested_oidc_provider_id::text),
    'oidcSubject',normalized_subject,
    'tenantId',lower(requested_tenant_id::text),
    'tenantName',normalized_tenant_name,
    'unitCode',normalized_unit_code,
    'unitId',lower(requested_unit_id::text),
    'unitName',normalized_unit_name
  )::text,'UTF8'),'sha256');

  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:initial-tenant-bootstrap',0));
  SELECT command.* INTO existing_command
  FROM public.initial_tenant_bootstrap_commands command
  WHERE command.singleton=true
  FOR UPDATE;
  IF FOUND THEN
    IF existing_command.request_fingerprint<>computed_fingerprint THEN
      RAISE EXCEPTION 'INITIAL_TENANT_BOOTSTRAP_CONFLICT' USING ERRCODE='23505';
    END IF;
    BEGIN
      SELECT principal.* INTO resolved FROM public.resolve_oidc_principal(
        normalized_issuer,normalized_audience,normalized_subject,normalized_claim,normalized_value
      ) principal;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INITIAL_TENANT_BOOTSTRAP_DRIFT' USING ERRCODE='23514';
    END;
    IF existing_command.tenant_id<>requested_tenant_id
      OR existing_command.unit_id<>requested_unit_id
      OR existing_command.admin_user_id<>requested_admin_user_id
      OR existing_command.oidc_provider_id<>requested_oidc_provider_id
      OR NOT EXISTS (SELECT 1 FROM public.tenants tenant
        WHERE tenant.id=requested_tenant_id AND tenant.name=normalized_tenant_name
          AND tenant.status='ACTIVE')
      OR NOT EXISTS (SELECT 1 FROM public.units unit
        WHERE unit.id=requested_unit_id AND unit.tenant_id=requested_tenant_id
          AND unit.code=normalized_unit_code AND unit.name=normalized_unit_name AND unit.active=true)
      OR NOT EXISTS (SELECT 1 FROM public.users admin_user
        WHERE admin_user.id=requested_admin_user_id AND admin_user.tenant_id=requested_tenant_id
          AND admin_user.email=normalized_admin_email
          AND admin_user.display_name=normalized_admin_display_name AND admin_user.status='ACTIVE')
      OR NOT EXISTS (SELECT 1 FROM public.user_units membership
        WHERE membership.tenant_id=requested_tenant_id AND membership.user_id=requested_admin_user_id
          AND membership.unit_id=requested_unit_id AND membership.role='TENANT_ADMIN'
          AND membership.status='ACTIVE')
      OR NOT EXISTS (SELECT 1 FROM public.oidc_providers provider
        WHERE provider.id=requested_oidc_provider_id AND provider.tenant_id=requested_tenant_id
          AND provider.code=normalized_provider_code AND provider.issuer=normalized_issuer
          AND provider.audience=normalized_audience
          AND provider.organization_claim IS NOT DISTINCT FROM normalized_claim
          AND provider.organization_value IS NOT DISTINCT FROM normalized_value
          AND provider.config_reference=normalized_config_reference AND provider.status='ACTIVE')
      OR NOT EXISTS (SELECT 1 FROM public.user_oidc_identities identity
        WHERE identity.tenant_id=requested_tenant_id AND identity.user_id=requested_admin_user_id
          AND identity.oidc_provider_id=requested_oidc_provider_id
          AND identity.id=resolved.identity_id
          AND identity.subject=normalized_subject AND identity.status='ACTIVE'
          AND identity.revoked_at IS NULL)
      OR resolved.tenant_id IS DISTINCT FROM requested_tenant_id
      OR resolved.user_id IS DISTINCT FROM requested_admin_user_id
      OR resolved.oidc_provider_id IS DISTINCT FROM requested_oidc_provider_id
      OR NOT EXISTS (SELECT 1 FROM public.user_units membership
        JOIN public.app_role_permissions permission ON permission.role_code=membership.role
        WHERE membership.tenant_id=requested_tenant_id AND membership.user_id=requested_admin_user_id
          AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE'
          AND membership.role='TENANT_ADMIN' AND permission.permission_code='tenant.users.manage')
      OR NOT EXISTS (SELECT 1 FROM public.attendant_unit_availability availability
        WHERE availability.tenant_id=requested_tenant_id AND availability.unit_id=requested_unit_id
          AND availability.user_id=requested_admin_user_id AND availability.status='OFFLINE'
          AND availability.max_active=100 AND availability.pause_reason IS NULL
          AND availability.paused_until IS NULL AND availability.version=1)
      OR NOT EXISTS (SELECT 1 FROM public.unit_assignment_policies policy
        WHERE policy.tenant_id=requested_tenant_id AND policy.unit_id=requested_unit_id
          AND policy.mode='OBSERVE' AND policy.version=1 AND policy.updated_by_user_id IS NULL) THEN
      RAISE EXCEPTION 'INITIAL_TENANT_BOOTSTRAP_DRIFT' USING ERRCODE='23514';
    END IF;
    RETURN QUERY SELECT existing_command.tenant_id,existing_command.unit_id,
      existing_command.admin_user_id,existing_command.oidc_provider_id,true;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants) THEN
    RAISE EXCEPTION 'INITIAL_TENANT_BOOTSTRAP_REQUIRES_EMPTY_DATABASE' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.tenants(id,name,status)
    VALUES(requested_tenant_id,normalized_tenant_name,'ACTIVE');
  INSERT INTO public.units(id,tenant_id,code,name,active)
    VALUES(requested_unit_id,requested_tenant_id,normalized_unit_code,normalized_unit_name,true);
  INSERT INTO public.users(id,tenant_id,email,display_name,status)
    VALUES(requested_admin_user_id,requested_tenant_id,normalized_admin_email,
      normalized_admin_display_name,'ACTIVE');
  INSERT INTO public.user_units(tenant_id,user_id,unit_id,role,status)
    VALUES(requested_tenant_id,requested_admin_user_id,requested_unit_id,'TENANT_ADMIN','ACTIVE');
  INSERT INTO public.oidc_providers(id,tenant_id,code,issuer,audience,organization_claim,
    organization_value,status,config_reference)
    VALUES(requested_oidc_provider_id,requested_tenant_id,normalized_provider_code,
      normalized_issuer,normalized_audience,normalized_claim,normalized_value,'ACTIVE',
      normalized_config_reference);
  INSERT INTO public.user_oidc_identities(tenant_id,user_id,oidc_provider_id,subject,status)
    VALUES(requested_tenant_id,requested_admin_user_id,requested_oidc_provider_id,
      normalized_subject,'ACTIVE');

  SELECT principal.* INTO resolved FROM public.resolve_oidc_principal(
    normalized_issuer,normalized_audience,normalized_subject,normalized_claim,normalized_value
  ) principal;
  IF resolved.tenant_id IS DISTINCT FROM requested_tenant_id
    OR resolved.user_id IS DISTINCT FROM requested_admin_user_id
    OR resolved.oidc_provider_id IS DISTINCT FROM requested_oidc_provider_id
    OR NOT EXISTS (SELECT 1 FROM public.user_units membership
      JOIN public.app_role_permissions permission ON permission.role_code=membership.role
      WHERE membership.tenant_id=requested_tenant_id AND membership.user_id=requested_admin_user_id
        AND membership.unit_id=requested_unit_id AND membership.status='ACTIVE'
        AND membership.role='TENANT_ADMIN' AND permission.permission_code='tenant.users.manage')
    OR NOT EXISTS (SELECT 1 FROM public.attendant_unit_availability availability
      WHERE availability.tenant_id=requested_tenant_id AND availability.unit_id=requested_unit_id
        AND availability.user_id=requested_admin_user_id AND availability.status='OFFLINE'
        AND availability.max_active=100 AND availability.pause_reason IS NULL
        AND availability.paused_until IS NULL AND availability.version=1)
    OR NOT EXISTS (SELECT 1 FROM public.unit_assignment_policies policy
      WHERE policy.tenant_id=requested_tenant_id AND policy.unit_id=requested_unit_id
        AND policy.mode='OBSERVE' AND policy.version=1 AND policy.updated_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'INITIAL_TENANT_BOOTSTRAP_VERIFICATION_FAILED' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.initial_tenant_bootstrap_commands(singleton,request_fingerprint,
    tenant_id,unit_id,admin_user_id,oidc_provider_id)
    VALUES(true,computed_fingerprint,requested_tenant_id,requested_unit_id,
      requested_admin_user_id,requested_oidc_provider_id);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(requested_tenant_id,'SYSTEM',NULL,
      'INITIAL_TENANT_BOOTSTRAPPED','tenant',requested_tenant_id::text,
      jsonb_build_object('adminUserId',requested_admin_user_id,'unitId',requested_unit_id,
        'oidcProviderId',requested_oidc_provider_id,
        'requestFingerprint',encode(computed_fingerprint,'hex')));

  RETURN QUERY SELECT requested_tenant_id,requested_unit_id,requested_admin_user_id,
    requested_oidc_provider_id,false;
END $$;

REVOKE ALL ON FUNCTION bootstrap_initial_tenant(
  uuid,text,uuid,text,text,uuid,text,text,uuid,text,text,text,text,text,text,text
) FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

COMMIT;
