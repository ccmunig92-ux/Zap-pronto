BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY tenant_id, lower(btrim(email)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_NORMALIZED_USER_EMAIL' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE length(btrim(email)) NOT BETWEEN 3 AND 320) THEN
    RAISE EXCEPTION 'INVALID_LEGACY_USER_EMAIL' USING ERRCODE = '22023';
  END IF;
END $$;

UPDATE users SET email=btrim(email) WHERE email IS DISTINCT FROM btrim(email);

ALTER TABLE users
  ADD COLUMN email_normalized text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT users_status_catalog CHECK (status IN ('ACTIVE','BLOCKED','REVOKED')),
  ADD CONSTRAINT users_email_valid CHECK (email=btrim(email) AND length(email) BETWEEN 3 AND 320),
  ADD CONSTRAINT users_status_timestamps CHECK (
    (status='ACTIVE' AND blocked_at IS NULL AND revoked_at IS NULL)
    OR (status='BLOCKED' AND blocked_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='REVOKED' AND blocked_at IS NULL AND revoked_at IS NOT NULL)
  );

CREATE UNIQUE INDEX users_tenant_normalized_email_unique
  ON users (tenant_id, email_normalized);

CREATE TYPE user_invitation_status AS ENUM ('PENDING','ACCEPTED','REVOKED','EXPIRED');

CREATE TABLE user_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  oidc_provider_id uuid NOT NULL,
  email_normalized text NOT NULL CHECK (email_normalized=lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  status user_invitation_status NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  accepted_user_id uuid,
  revoked_by_user_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,oidc_provider_id) REFERENCES oidc_providers(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,accepted_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,revoked_by_user_id) REFERENCES users(tenant_id,id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (
    (status='PENDING' AND accepted_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
    OR (status='ACCEPTED' AND accepted_user_id IS NOT NULL AND accepted_at BETWEEN created_at AND expires_at AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
    OR (status='REVOKED' AND accepted_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NOT NULL AND revoked_at >= created_at AND expired_at IS NULL)
    OR (status='EXPIRED' AND accepted_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at >= expires_at)
  )
);

CREATE UNIQUE INDEX user_invitations_one_pending_email
  ON user_invitations (tenant_id,email_normalized) WHERE status='PENDING';
CREATE INDEX user_invitations_pending_expiry
  ON user_invitations (expires_at,id) WHERE status='PENDING';

CREATE TABLE user_invitation_units (
  tenant_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  role text NOT NULL REFERENCES app_roles(code),
  PRIMARY KEY (tenant_id,invitation_id,unit_id),
  FOREIGN KEY (tenant_id,invitation_id) REFERENCES user_invitations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,unit_id) REFERENCES units(tenant_id,id)
);

CREATE TABLE user_lifecycle_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  operation text NOT NULL CHECK (operation IN ('INVITE','ACCEPT','BLOCK','ACTIVATE','REVOKE_USER')),
  target_user_id uuid,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint)=32),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,target_user_id) REFERENCES users(tenant_id,id)
  ,CHECK (
    (operation IN ('INVITE','ACCEPT') AND target_user_id IS NULL)
    OR (operation IN ('BLOCK','ACTIVATE','REVOKE_USER') AND target_user_id IS NOT NULL)
  )
);

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_invitations
  USING (tenant_id=current_app_tenant_id()) WITH CHECK (tenant_id=current_app_tenant_id());

ALTER TABLE user_invitation_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitation_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_invitation_units
  USING (tenant_id=current_app_tenant_id()) WITH CHECK (tenant_id=current_app_tenant_id());

ALTER TABLE user_lifecycle_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_lifecycle_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_lifecycle_commands
  USING (tenant_id=current_app_tenant_id()) WITH CHECK (tenant_id=current_app_tenant_id());

REVOKE ALL ON user_invitations,user_invitation_units,user_lifecycle_commands
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
REVOKE INSERT,UPDATE,DELETE ON users FROM zap_pronto_api;
REVOKE INSERT,UPDATE,DELETE ON user_units FROM zap_pronto_api;

CREATE FUNCTION admin_change_user_status(
  target_user_id uuid,
  expected_version integer,
  target_status text,
  reason text
) RETURNS TABLE (user_id uuid,status text,version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  tenant_id_value uuid := public.current_app_tenant_id();
  actor_id_value uuid := public.current_app_actor_id();
  current_status text;
  current_version integer;
  remaining_admins integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:user-lifecycle:'||tenant_id_value::text,0));
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  IF target_user_id IS NULL OR expected_version IS NULL OR target_status NOT IN ('ACTIVE','BLOCKED','REVOKED')
    OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_USER_STATUS_COMMAND' USING ERRCODE='22023';
  END IF;
  IF target_user_id=actor_id_value AND target_status<>'ACTIVE' THEN
    RAISE EXCEPTION 'SELF_ACCESS_REMOVAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT account.status,account.version INTO current_status,current_version
  FROM public.users account
  WHERE account.tenant_id=tenant_id_value AND account.id=target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF current_version<>expected_version THEN RAISE EXCEPTION 'USER_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT ((current_status='ACTIVE' AND target_status IN ('BLOCKED','REVOKED'))
    OR (current_status='BLOCKED' AND target_status IN ('ACTIVE','REVOKED'))) THEN
    RAISE EXCEPTION 'INVALID_USER_STATUS_TRANSITION' USING ERRCODE='22023';
  END IF;

  IF target_status IN ('BLOCKED','REVOKED') AND EXISTS (
    SELECT 1 FROM public.user_units membership JOIN public.units unit
      ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active=true
    WHERE membership.tenant_id=tenant_id_value AND membership.user_id=target_user_id
      AND membership.role='TENANT_ADMIN'
  ) THEN
    SELECT count(DISTINCT account.id) INTO remaining_admins
    FROM public.users account JOIN public.user_units membership
      ON membership.tenant_id=account.tenant_id AND membership.user_id=account.id
    JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active=true
    WHERE account.tenant_id=tenant_id_value AND account.status='ACTIVE'
      AND membership.role='TENANT_ADMIN' AND account.id<>target_user_id;
    IF remaining_admins=0 THEN RAISE EXCEPTION 'LAST_TENANT_ADMIN_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;

  UPDATE public.users account SET status=target_status,version=account.version+1,status_changed_at=now(),
    blocked_at=CASE WHEN target_status='BLOCKED' THEN now() ELSE NULL END,
    revoked_at=CASE WHEN target_status='REVOKED' THEN now() ELSE NULL END
  WHERE account.tenant_id=tenant_id_value AND account.id=target_user_id
  RETURNING account.id,account.status,account.version INTO user_id,status,version;

  IF target_status='REVOKED' THEN
    UPDATE public.user_oidc_identities identity SET status='REVOKED',revoked_at=now()
    WHERE identity.tenant_id=tenant_id_value AND identity.user_id=target_user_id AND identity.status='ACTIVE';
  END IF;

  INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES (tenant_id_value,'USER',actor_id_value::text,'USER_STATUS_CHANGED','user',target_user_id::text,
    jsonb_build_object('fromStatus',current_status,'toStatus',target_status,'reason',btrim(reason),
      'correlationId',current_setting('app.correlation_id',true),'version',version));
  INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES (tenant_id_value,'user',target_user_id,'user.status_changed',
    jsonb_build_object('userId',target_user_id,'status',target_status,'version',version),
    'user-status-'||target_user_id::text||'-'||version::text);
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION admin_change_user_status(uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION admin_change_user_status(uuid,integer,text,text) TO zap_pronto_api;

COMMIT;
