BEGIN;

CREATE FUNCTION accept_user_invitation_oidc(
  command_idempotency_key text,
  command_fingerprint bytea,
  invitation_token_digest bytea,
  requested_user_id uuid,
  verified_issuer text,
  verified_audience text,
  verified_subject text,
  verified_organization_claim text,
  verified_organization_value text,
  verified_email text,
  verified_email_is_verified boolean,
  request_correlation_id text
) RETURNS TABLE (
  tenant_id uuid,user_id uuid,invitation_id uuid,email text,display_name text,
  memberships jsonb,replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE
  invitation_record record;
  existing_command record;
  existing_identity record;
  normalized_verified_email text;
  resolved_user_id uuid;
  was_replayed boolean := false;
BEGIN
  IF command_idempotency_key IS NULL OR length(command_idempotency_key) NOT BETWEEN 8 AND 200
    OR command_fingerprint IS NULL OR octet_length(command_fingerprint)<>32
    OR invitation_token_digest IS NULL OR octet_length(invitation_token_digest)<>32
    OR requested_user_id IS NULL
    OR verified_issuer IS NULL OR verified_issuer !~ '^https://[^[:space:]]+$'
    OR verified_audience IS NULL OR length(btrim(verified_audience))=0
    OR verified_subject IS NULL OR length(verified_subject) NOT BETWEEN 1 AND 512
    OR ((verified_organization_claim IS NULL)<>(verified_organization_value IS NULL))
    OR (verified_organization_claim IS NOT NULL
      AND verified_organization_claim !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,126}$')
    OR (verified_organization_value IS NOT NULL AND length(btrim(verified_organization_value))=0)
    OR verified_email IS NULL OR verified_email_is_verified IS DISTINCT FROM true
    OR request_correlation_id IS NULL OR length(request_correlation_id) NOT BETWEEN 8 AND 128
    OR request_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN
    RAISE EXCEPTION 'INVALID_INVITATION_ACCEPTANCE' USING ERRCODE='22023';
  END IF;
  normalized_verified_email := lower(btrim(verified_email));
  IF length(normalized_verified_email) NOT BETWEEN 3 AND 320
    OR normalized_verified_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'INVALID_INVITATION_ACCEPTANCE' USING ERRCODE='22023';
  END IF;

  /*
   * PostgreSQL does not guarantee a constant-time bytea comparator. The lookup
   * uses a UNIQUE SHA-256 digest of a 256-bit random token: no token prefix or
   * raw credential reaches SQL, and comparison timing cannot reveal usable
   * token material. Rate limiting remains mandatory at the HTTP boundary.
   */
  SELECT invitation.*,provider.code AS provider_code,provider.issuer,provider.audience,
    provider.organization_claim,provider.organization_value,provider.status AS provider_status
  INTO invitation_record
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id
    AND provider.id=invitation.oidc_provider_id
  WHERE invitation.token_digest=invitation_token_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'zap-pronto:user-invite:'||invitation_record.tenant_id::text,0));
  /* Releia sob lock na mesma ordem usada por create/revoke/reissue. */
  SELECT invitation.*,provider.code AS provider_code,provider.issuer,provider.audience,
    provider.organization_claim,provider.organization_value,provider.status AS provider_status
  INTO invitation_record
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id
    AND provider.id=invitation.oidc_provider_id
  WHERE invitation.token_digest=invitation_token_digest
  FOR UPDATE OF invitation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
  END IF;
  IF invitation_record.provider_status<>'ACTIVE'
    OR invitation_record.issuer<>verified_issuer
    OR invitation_record.audience<>verified_audience
    OR coalesce(invitation_record.organization_claim,'')<>coalesce(verified_organization_claim,'')
    OR coalesce(invitation_record.organization_value,'')<>coalesce(verified_organization_value,'')
    OR invitation_record.email_normalized<>normalized_verified_email THEN
    RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
  END IF;

  SELECT command.operation,command.request_fingerprint,command.result INTO existing_command
  FROM public.user_lifecycle_commands command
  WHERE command.tenant_id=invitation_record.tenant_id
    AND command.idempotency_key=command_idempotency_key;
  IF FOUND THEN
    IF existing_command.operation<>'ACCEPT'
      OR existing_command.request_fingerprint<>command_fingerprint
      OR existing_command.result->>'invitationId'<>invitation_record.id::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    resolved_user_id := (existing_command.result->>'userId')::uuid;
    SELECT identity.user_id INTO existing_identity
    FROM public.user_oidc_identities identity JOIN public.users account
      ON account.tenant_id=identity.tenant_id AND account.id=identity.user_id
    WHERE identity.tenant_id=invitation_record.tenant_id
      AND identity.oidc_provider_id=invitation_record.oidc_provider_id
      AND identity.subject=verified_subject AND identity.status='ACTIVE'
      AND identity.user_id=resolved_user_id AND account.status='ACTIVE'
      AND account.email_normalized=normalized_verified_email;
    IF NOT FOUND OR invitation_record.status<>'ACCEPTED'
      OR invitation_record.accepted_user_id<>resolved_user_id THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;
    was_replayed := true;
  ELSE
    IF invitation_record.status<>'PENDING' OR invitation_record.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users account
      WHERE account.tenant_id=invitation_record.tenant_id
        AND account.email_normalized=normalized_verified_email) THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.user_oidc_identities identity
      WHERE identity.tenant_id=invitation_record.tenant_id
        AND identity.oidc_provider_id=invitation_record.oidc_provider_id
        AND identity.subject=verified_subject) THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users account WHERE account.id=requested_user_id) THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_invitation_units assignment JOIN public.units unit
      ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id AND unit.active=true
      WHERE assignment.tenant_id=invitation_record.tenant_id
        AND assignment.invitation_id=invitation_record.id)
      OR EXISTS (SELECT 1 FROM public.user_invitation_units assignment JOIN public.units unit
        ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
        WHERE assignment.tenant_id=invitation_record.tenant_id
          AND assignment.invitation_id=invitation_record.id AND unit.active=false) THEN
      RAISE EXCEPTION 'INVITATION_ACCEPTANCE_DENIED' USING ERRCODE='28000';
    END IF;

    INSERT INTO public.users (id,tenant_id,email,display_name)
    VALUES (requested_user_id,invitation_record.tenant_id,normalized_verified_email,
      invitation_record.display_name);
    INSERT INTO public.user_units (tenant_id,user_id,unit_id,role)
    SELECT invitation_record.tenant_id,requested_user_id,assignment.unit_id,assignment.role
    FROM public.user_invitation_units assignment
    WHERE assignment.tenant_id=invitation_record.tenant_id
      AND assignment.invitation_id=invitation_record.id;
    INSERT INTO public.user_oidc_identities
      (tenant_id,user_id,oidc_provider_id,subject)
    VALUES (invitation_record.tenant_id,requested_user_id,
      invitation_record.oidc_provider_id,verified_subject);
    UPDATE public.user_invitations invitation SET status='ACCEPTED',accepted_user_id=requested_user_id,
      accepted_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE invitation.tenant_id=invitation_record.tenant_id AND invitation.id=invitation_record.id;
    INSERT INTO public.user_lifecycle_commands
      (tenant_id,idempotency_key,operation,request_fingerprint,result)
    VALUES (invitation_record.tenant_id,command_idempotency_key,'ACCEPT',command_fingerprint,
      jsonb_build_object('invitationId',invitation_record.id,'userId',requested_user_id));
    INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES (invitation_record.tenant_id,'USER',requested_user_id::text,'USER_INVITATION_ACCEPTED',
      'user_invitation',invitation_record.id::text,jsonb_build_object(
        'userId',requested_user_id,'correlationId',request_correlation_id));
    INSERT INTO public.outbox_events
      (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES (invitation_record.tenant_id,'user_invitation',invitation_record.id,
      'user.invitation.accepted',jsonb_build_object(
        'invitationId',invitation_record.id,'userId',requested_user_id),
      'user-invitation-accepted-'||invitation_record.id::text);
    resolved_user_id := requested_user_id;
  END IF;

  PERFORM set_config('app.tenant_id',invitation_record.tenant_id::text,true),
    set_config('app.actor_id',resolved_user_id::text,true),
    set_config('app.correlation_id',request_correlation_id,true);
  PERFORM public.assert_app_context_authorized();
  RETURN QUERY SELECT invitation_record.tenant_id,resolved_user_id,invitation_record.id,
    normalized_verified_email,invitation_record.display_name,
    COALESCE(jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,
      'unitName',unit.name,'role',membership.role) ORDER BY unit.code,unit.id),'[]'::jsonb),
    was_replayed
  FROM public.user_units membership JOIN public.units unit
    ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active=true
  WHERE membership.tenant_id=invitation_record.tenant_id AND membership.user_id=resolved_user_id;
END $$;

REVOKE ALL ON FUNCTION accept_user_invitation_oidc(
  text,bytea,bytea,uuid,text,text,text,text,text,text,boolean,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION accept_user_invitation_oidc(
  text,bytea,bytea,uuid,text,text,text,text,text,text,boolean,text)
  TO zap_pronto_api;

COMMIT;
