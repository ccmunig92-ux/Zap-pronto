BEGIN;

CREATE FUNCTION admin_create_user_invitation(
  command_idempotency_key text,
  command_fingerprint bytea,
  requested_invitation_id uuid,
  provider_code text,
  normalized_email text,
  requested_display_name text,
  requested_expires_at timestamptz,
  invitation_token_digest bytea,
  requested_assignments jsonb
) RETURNS TABLE (
  id uuid,email text,display_name text,status user_invitation_status,expires_at timestamptz,
  oidc_provider_code text,assignments jsonb,replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$
DECLARE
  tenant_id_value uuid := public.current_app_tenant_id();
  actor_id_value uuid := public.current_app_actor_id();
  provider_id_value uuid;
  existing_command record;
  assignment_count integer;
  valid_assignment_count integer;
  expired_invitation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:user-invite:'||tenant_id_value::text,0));
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  IF command_idempotency_key IS NULL OR length(command_idempotency_key) NOT BETWEEN 8 AND 200
    OR command_fingerprint IS NULL OR octet_length(command_fingerprint)<>32 OR requested_invitation_id IS NULL
    OR provider_code IS NULL OR provider_code !~ '^[a-z][a-z0-9_-]{1,62}$'
    OR normalized_email IS NULL OR normalized_email<>lower(btrim(normalized_email))
    OR length(normalized_email) NOT BETWEEN 3 AND 320
    OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    OR requested_display_name IS NULL OR length(btrim(requested_display_name)) NOT BETWEEN 1 AND 160
    OR requested_expires_at IS NULL OR requested_expires_at<=clock_timestamp()
    OR requested_expires_at>clock_timestamp()+interval '30 days'
    OR invitation_token_digest IS NULL OR octet_length(invitation_token_digest)<>32
    OR requested_assignments IS NULL OR jsonb_typeof(requested_assignments)<>'array'
    OR jsonb_array_length(requested_assignments) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'INVALID_INVITATION_COMMAND' USING ERRCODE='22023';
  END IF;

  SELECT command.operation,command.request_fingerprint,command.result INTO existing_command
  FROM public.user_lifecycle_commands command
  WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=command_idempotency_key;
  IF FOUND THEN
    IF existing_command.operation<>'INVITE' OR existing_command.request_fingerprint<>command_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT invitation.id,invitation.email_normalized,invitation.display_name,invitation.status,
      invitation.expires_at,provider.code,
      COALESCE(jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,'unitName',unit.name,
        'role',assignment.role) ORDER BY unit.code,unit.id) FILTER (WHERE unit.id IS NOT NULL),'[]'::jsonb),true
    FROM public.user_invitations invitation
    JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id AND provider.id=invitation.oidc_provider_id
    LEFT JOIN public.user_invitation_units assignment ON assignment.tenant_id=invitation.tenant_id AND assignment.invitation_id=invitation.id
    LEFT JOIN public.units unit ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
    WHERE invitation.tenant_id=tenant_id_value
      AND invitation.id=(existing_command.result->>'invitationId')::uuid
    GROUP BY invitation.id,provider.code;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.users account
    WHERE account.tenant_id=tenant_id_value AND account.email_normalized=normalized_email) THEN
    RAISE EXCEPTION 'USER_ALREADY_EXISTS' USING ERRCODE='23505';
  END IF;
  UPDATE public.user_invitations invitation SET status='EXPIRED',expired_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE invitation.tenant_id=tenant_id_value AND invitation.email_normalized=normalized_email
    AND invitation.status='PENDING' AND invitation.expires_at<=clock_timestamp()
  RETURNING invitation.id INTO expired_invitation_id;
  IF expired_invitation_id IS NOT NULL THEN
    INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES (tenant_id_value,'USER',actor_id_value::text,'USER_INVITATION_EXPIRED','user_invitation',
      expired_invitation_id::text,jsonb_build_object(
        'correlationId',current_setting('app.correlation_id',true)));
    INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES (tenant_id_value,'user_invitation',expired_invitation_id,'user.invitation.expired',
      jsonb_build_object('invitationId',expired_invitation_id),
      'user-invitation-expired-'||expired_invitation_id::text);
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_invitations invitation
    WHERE invitation.tenant_id=tenant_id_value AND invitation.email_normalized=normalized_email
      AND invitation.status='PENDING') THEN
    RAISE EXCEPTION 'INVITATION_ALREADY_PENDING' USING ERRCODE='23505';
  END IF;

  SELECT provider.id INTO provider_id_value FROM public.oidc_providers provider
  WHERE provider.tenant_id=tenant_id_value AND provider.code=provider_code AND provider.status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'OIDC_PROVIDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT count(*) INTO assignment_count FROM jsonb_array_elements(requested_assignments) item;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(requested_assignments) item
    WHERE jsonb_typeof(item)<>'object' OR (item-'unitId'-'role')<>'{}'::jsonb
      OR NOT (item ? 'unitId' AND item ? 'role')
      OR jsonb_typeof(item->'unitId')<>'string' OR jsonb_typeof(item->'role')<>'string'
      OR item->>'role' NOT IN ('UNIT_MANAGER','SUPERVISOR','ATTENDANT','AUDITOR')) THEN
    RAISE EXCEPTION 'INVALID_INVITATION_ASSIGNMENTS' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT item->>'unitId') FROM jsonb_array_elements(requested_assignments) item)<>assignment_count THEN
    RAISE EXCEPTION 'DUPLICATE_INVITATION_UNIT' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO valid_assignment_count
  FROM jsonb_array_elements(requested_assignments) item
  JOIN public.units unit ON unit.tenant_id=tenant_id_value AND unit.id=(item->>'unitId')::uuid AND unit.active=true;
  IF valid_assignment_count<>assignment_count THEN RAISE EXCEPTION 'UNIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.user_invitations
    (id,tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
  VALUES (requested_invitation_id,tenant_id_value,provider_id_value,normalized_email,btrim(requested_display_name),
    invitation_token_digest,requested_expires_at,actor_id_value);
  INSERT INTO public.user_invitation_units (tenant_id,invitation_id,unit_id,role)
  SELECT tenant_id_value,requested_invitation_id,(item->>'unitId')::uuid,item->>'role'
  FROM jsonb_array_elements(requested_assignments) item;
  INSERT INTO public.user_lifecycle_commands
    (tenant_id,idempotency_key,operation,request_fingerprint,result)
  VALUES (tenant_id_value,command_idempotency_key,'INVITE',command_fingerprint,
    jsonb_build_object('invitationId',requested_invitation_id));
  INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES (tenant_id_value,'USER',actor_id_value::text,'USER_INVITATION_CREATED','user_invitation',requested_invitation_id::text,
    jsonb_build_object('providerCode',provider_code,'assignments',requested_assignments,
      'correlationId',current_setting('app.correlation_id',true)));
  INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES (tenant_id_value,'user_invitation',requested_invitation_id,'user.invitation.created',
    jsonb_build_object('invitationId',requested_invitation_id,'providerCode',provider_code,'expiresAt',requested_expires_at),
    'user-invitation-'||requested_invitation_id::text);

  RETURN QUERY SELECT invitation.id,invitation.email_normalized,invitation.display_name,invitation.status,
    invitation.expires_at,provider.code,
    jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,'unitName',unit.name,
      'role',assignment.role) ORDER BY unit.code,unit.id),false
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id AND provider.id=invitation.oidc_provider_id
  JOIN public.user_invitation_units assignment ON assignment.tenant_id=invitation.tenant_id AND assignment.invitation_id=invitation.id
  JOIN public.units unit ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
  WHERE invitation.tenant_id=tenant_id_value AND invitation.id=requested_invitation_id
  GROUP BY invitation.id,provider.code;
END $$;

REVOKE ALL ON FUNCTION admin_create_user_invitation(text,bytea,uuid,text,text,text,timestamptz,bytea,jsonb)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION admin_create_user_invitation(text,bytea,uuid,text,text,text,timestamptz,bytea,jsonb)
  TO zap_pronto_api;

COMMIT;
