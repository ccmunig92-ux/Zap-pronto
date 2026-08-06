BEGIN;

CREATE INDEX user_invitations_tenant_created_page
  ON user_invitations (tenant_id,created_at DESC,id DESC);

ALTER TABLE user_lifecycle_commands DROP CONSTRAINT user_lifecycle_commands_operation_check;
ALTER TABLE user_lifecycle_commands DROP CONSTRAINT user_lifecycle_commands_check;
ALTER TABLE user_lifecycle_commands
  ADD CONSTRAINT user_lifecycle_commands_operation_check CHECK (operation IN (
    'INVITE','ACCEPT','REVOKE_INVITATION','REISSUE_INVITATION',
    'BLOCK','ACTIVATE','REVOKE_USER'
  )),
  ADD CONSTRAINT user_lifecycle_commands_target_check CHECK (
    (operation IN ('INVITE','ACCEPT','REVOKE_INVITATION','REISSUE_INVITATION') AND target_user_id IS NULL)
    OR (operation IN ('BLOCK','ACTIVATE','REVOKE_USER') AND target_user_id IS NOT NULL)
  );

DROP FUNCTION admin_change_user_status(uuid,integer,text,text);

CREATE FUNCTION admin_change_user_status(
  command_idempotency_key text,
  command_fingerprint bytea,
  target_user_id uuid,
  expected_version integer,
  target_status text,
  reason text
) RETURNS TABLE (user_id uuid,status text,version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE
  tenant_id_value uuid := public.current_app_tenant_id();
  actor_id_value uuid := public.current_app_actor_id();
  current_status text;
  current_version integer;
  remaining_admins integer;
  operation_value text;
  existing_command record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:user-lifecycle:'||tenant_id_value::text,0));
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  operation_value := CASE target_status WHEN 'BLOCKED' THEN 'BLOCK' WHEN 'ACTIVE' THEN 'ACTIVATE'
    WHEN 'REVOKED' THEN 'REVOKE_USER' ELSE NULL END;
  IF command_idempotency_key IS NULL OR length(command_idempotency_key) NOT BETWEEN 8 AND 200
    OR command_fingerprint IS NULL OR octet_length(command_fingerprint)<>32
    OR target_user_id IS NULL OR expected_version IS NULL OR operation_value IS NULL
    OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_USER_STATUS_COMMAND' USING ERRCODE='22023';
  END IF;

  SELECT command.operation,command.target_user_id,command.request_fingerprint,command.result
    INTO existing_command
  FROM public.user_lifecycle_commands command
  WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=command_idempotency_key;
  IF FOUND THEN
    IF existing_command.operation<>operation_value
      OR existing_command.target_user_id<>target_user_id
      OR existing_command.request_fingerprint<>command_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    user_id := (existing_command.result->>'userId')::uuid;
    status := existing_command.result->>'status';
    version := (existing_command.result->>'version')::integer;
    replayed := true;
    RETURN NEXT;
    RETURN;
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
  INSERT INTO public.user_lifecycle_commands
    (tenant_id,idempotency_key,operation,target_user_id,request_fingerprint,result)
  VALUES (tenant_id_value,command_idempotency_key,operation_value,target_user_id,command_fingerprint,
    jsonb_build_object('userId',user_id,'status',status,'version',version));
  INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES (tenant_id_value,'USER',actor_id_value::text,'USER_STATUS_CHANGED','user',target_user_id::text,
    jsonb_build_object('fromStatus',current_status,'toStatus',target_status,'reason',btrim(reason),
      'correlationId',current_setting('app.correlation_id',true),'version',version));
  INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES (tenant_id_value,'user',target_user_id,'user.status_changed',
    jsonb_build_object('userId',target_user_id,'status',target_status,'version',version),
    'user-status-'||target_user_id::text||'-'||version::text);
  replayed := false;
  RETURN NEXT;
END $$;

CREATE FUNCTION admin_list_user_invitations(
  requested_anchor_id uuid,requested_limit integer
) RETURNS TABLE (
  id uuid,email text,display_name text,status user_invitation_status,expires_at timestamptz,
  provider_code text,assignments jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE tenant_id_value uuid := public.current_app_tenant_id();
BEGIN
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'INVALID_PAGE_LIMIT' USING ERRCODE='22023';
  END IF;
  IF requested_anchor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_invitations anchor
    WHERE anchor.tenant_id=tenant_id_value AND anchor.id=requested_anchor_id
  ) THEN RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT invitation.id,invitation.email_normalized,invitation.display_name,invitation.status,
    invitation.expires_at,provider.code,
    COALESCE(jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,
      'unitName',unit.name,'role',assignment.role) ORDER BY unit.code,unit.id)
      FILTER (WHERE unit.id IS NOT NULL),'[]'::jsonb)
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id
    AND provider.id=invitation.oidc_provider_id
  LEFT JOIN public.user_invitation_units assignment ON assignment.tenant_id=invitation.tenant_id
    AND assignment.invitation_id=invitation.id
  LEFT JOIN public.units unit ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
  WHERE invitation.tenant_id=tenant_id_value AND (requested_anchor_id IS NULL OR
    (invitation.created_at,invitation.id)<(
      SELECT anchor.created_at,anchor.id FROM public.user_invitations anchor
      WHERE anchor.tenant_id=tenant_id_value AND anchor.id=requested_anchor_id
    ))
  GROUP BY invitation.id,provider.code
  ORDER BY invitation.created_at DESC,invitation.id DESC LIMIT requested_limit;
END $$;

CREATE FUNCTION admin_revoke_user_invitation(
  command_idempotency_key text,command_fingerprint bytea,target_invitation_id uuid,reason text
) RETURNS TABLE (
  id uuid,email text,display_name text,status user_invitation_status,expires_at timestamptz,
  oidc_provider_code text,assignments jsonb,replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE
  tenant_id_value uuid := public.current_app_tenant_id();
  actor_id_value uuid := public.current_app_actor_id();
  existing_command record;
  current_invitation record;
  was_replayed boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:user-invite:'||tenant_id_value::text,0));
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  IF command_idempotency_key IS NULL OR length(command_idempotency_key) NOT BETWEEN 8 AND 200
    OR command_fingerprint IS NULL OR octet_length(command_fingerprint)<>32
    OR target_invitation_id IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_INVITATION_REVOCATION' USING ERRCODE='22023';
  END IF;
  SELECT command.operation,command.request_fingerprint,command.result INTO existing_command
  FROM public.user_lifecycle_commands command
  WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=command_idempotency_key;
  IF FOUND THEN
    IF existing_command.operation<>'REVOKE_INVITATION'
      OR existing_command.request_fingerprint<>command_fingerprint
      OR existing_command.result->>'invitationId'<>target_invitation_id::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    was_replayed := true;
  ELSE
    SELECT invitation.status INTO current_invitation FROM public.user_invitations invitation
    WHERE invitation.tenant_id=tenant_id_value AND invitation.id=target_invitation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF current_invitation.status<>'PENDING' THEN
      RAISE EXCEPTION 'INVITATION_NOT_PENDING' USING ERRCODE='23505';
    END IF;
    UPDATE public.user_invitations invitation SET status='REVOKED',revoked_by_user_id=actor_id_value,
      revoked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE invitation.tenant_id=tenant_id_value AND invitation.id=target_invitation_id;
    INSERT INTO public.user_lifecycle_commands
      (tenant_id,idempotency_key,operation,request_fingerprint,result)
    VALUES (tenant_id_value,command_idempotency_key,'REVOKE_INVITATION',command_fingerprint,
      jsonb_build_object('invitationId',target_invitation_id));
    INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES (tenant_id_value,'USER',actor_id_value::text,'USER_INVITATION_REVOKED','user_invitation',
      target_invitation_id::text,jsonb_build_object('reason',btrim(reason),
        'correlationId',current_setting('app.correlation_id',true)));
    INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES (tenant_id_value,'user_invitation',target_invitation_id,'user.invitation.revoked',
      jsonb_build_object('invitationId',target_invitation_id),
      'user-invitation-revoked-'||target_invitation_id::text);
  END IF;
  RETURN QUERY SELECT invitation.id,invitation.email_normalized,invitation.display_name,invitation.status,
    invitation.expires_at,provider.code,
    COALESCE(jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,'unitName',unit.name,
      'role',assignment.role) ORDER BY unit.code,unit.id) FILTER (WHERE unit.id IS NOT NULL),'[]'::jsonb),was_replayed
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id AND provider.id=invitation.oidc_provider_id
  LEFT JOIN public.user_invitation_units assignment ON assignment.tenant_id=invitation.tenant_id AND assignment.invitation_id=invitation.id
  LEFT JOIN public.units unit ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
  WHERE invitation.tenant_id=tenant_id_value AND invitation.id=target_invitation_id
  GROUP BY invitation.id,provider.code;
END $$;

CREATE FUNCTION admin_reissue_user_invitation(
  command_idempotency_key text,command_fingerprint bytea,target_invitation_id uuid,
  replacement_invitation_id uuid,requested_expires_at timestamptz,replacement_token_digest bytea,reason text
) RETURNS TABLE (
  id uuid,email text,display_name text,status user_invitation_status,expires_at timestamptz,
  oidc_provider_code text,assignments jsonb,replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off
AS $$
DECLARE
  tenant_id_value uuid := public.current_app_tenant_id();
  actor_id_value uuid := public.current_app_actor_id();
  existing_command record;
  previous_invitation record;
  assignment_count integer;
  active_assignment_count integer;
  was_replayed boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('zap-pronto:user-invite:'||tenant_id_value::text,0));
  IF NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'AUTHORIZATION_DENIED' USING ERRCODE='42501';
  END IF;
  IF command_idempotency_key IS NULL OR length(command_idempotency_key) NOT BETWEEN 8 AND 200
    OR command_fingerprint IS NULL OR octet_length(command_fingerprint)<>32
    OR target_invitation_id IS NULL OR replacement_invitation_id IS NULL
    OR target_invitation_id=replacement_invitation_id OR requested_expires_at IS NULL
    OR requested_expires_at<=clock_timestamp() OR requested_expires_at>clock_timestamp()+interval '30 days'
    OR replacement_token_digest IS NULL OR octet_length(replacement_token_digest)<>32
    OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_INVITATION_REISSUE' USING ERRCODE='22023';
  END IF;
  SELECT command.operation,command.request_fingerprint,command.result INTO existing_command
  FROM public.user_lifecycle_commands command
  WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=command_idempotency_key;
  IF FOUND THEN
    IF existing_command.operation<>'REISSUE_INVITATION'
      OR existing_command.request_fingerprint<>command_fingerprint
      OR existing_command.result->>'previousInvitationId'<>target_invitation_id::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    replacement_invitation_id := (existing_command.result->>'invitationId')::uuid;
    was_replayed := true;
  ELSE
    SELECT invitation.* INTO previous_invitation FROM public.user_invitations invitation
    WHERE invitation.tenant_id=tenant_id_value AND invitation.id=target_invitation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF previous_invitation.status<>'PENDING' THEN
      RAISE EXCEPTION 'INVITATION_NOT_PENDING' USING ERRCODE='23505';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users account WHERE account.tenant_id=tenant_id_value
      AND account.email_normalized=previous_invitation.email_normalized) THEN
      RAISE EXCEPTION 'USER_ALREADY_EXISTS' USING ERRCODE='23505';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.oidc_providers provider
      WHERE provider.tenant_id=tenant_id_value AND provider.id=previous_invitation.oidc_provider_id
        AND provider.status='ACTIVE') THEN
      RAISE EXCEPTION 'OIDC_PROVIDER_NOT_FOUND' USING ERRCODE='P0002';
    END IF;
    SELECT count(*),count(*) FILTER (WHERE unit.active=true) INTO assignment_count,active_assignment_count
    FROM public.user_invitation_units assignment JOIN public.units unit
      ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
    WHERE assignment.tenant_id=tenant_id_value AND assignment.invitation_id=target_invitation_id;
    IF assignment_count=0 OR active_assignment_count<>assignment_count THEN
      RAISE EXCEPTION 'UNIT_NOT_FOUND' USING ERRCODE='P0002';
    END IF;
    UPDATE public.user_invitations invitation SET status='REVOKED',revoked_by_user_id=actor_id_value,
      revoked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE invitation.tenant_id=tenant_id_value AND invitation.id=target_invitation_id;
    INSERT INTO public.user_invitations
      (id,tenant_id,oidc_provider_id,email_normalized,display_name,token_digest,expires_at,created_by_user_id)
    VALUES (replacement_invitation_id,tenant_id_value,previous_invitation.oidc_provider_id,
      previous_invitation.email_normalized,previous_invitation.display_name,replacement_token_digest,
      requested_expires_at,actor_id_value);
    INSERT INTO public.user_invitation_units (tenant_id,invitation_id,unit_id,role)
    SELECT tenant_id_value,replacement_invitation_id,assignment.unit_id,assignment.role
    FROM public.user_invitation_units assignment
    WHERE assignment.tenant_id=tenant_id_value AND assignment.invitation_id=target_invitation_id;
    INSERT INTO public.user_lifecycle_commands
      (tenant_id,idempotency_key,operation,request_fingerprint,result)
    VALUES (tenant_id_value,command_idempotency_key,'REISSUE_INVITATION',command_fingerprint,
      jsonb_build_object('invitationId',replacement_invitation_id,'previousInvitationId',target_invitation_id));
    INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES
      (tenant_id_value,'USER',actor_id_value::text,'USER_INVITATION_REISSUED','user_invitation',target_invitation_id::text,
        jsonb_build_object('replacementInvitationId',replacement_invitation_id,'reason',btrim(reason),
          'correlationId',current_setting('app.correlation_id',true))),
      (tenant_id_value,'USER',actor_id_value::text,'USER_INVITATION_CREATED','user_invitation',replacement_invitation_id::text,
        jsonb_build_object('previousInvitationId',target_invitation_id,
          'correlationId',current_setting('app.correlation_id',true)));
    INSERT INTO public.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key) VALUES
      (tenant_id_value,'user_invitation',target_invitation_id,'user.invitation.reissued',
        jsonb_build_object('invitationId',target_invitation_id,'replacementInvitationId',replacement_invitation_id),
        'user-invitation-reissued-'||target_invitation_id::text),
      (tenant_id_value,'user_invitation',replacement_invitation_id,'user.invitation.created',
        jsonb_build_object('invitationId',replacement_invitation_id,'previousInvitationId',target_invitation_id,
          'expiresAt',requested_expires_at),'user-invitation-'||replacement_invitation_id::text);
  END IF;
  RETURN QUERY SELECT invitation.id,invitation.email_normalized,invitation.display_name,invitation.status,
    invitation.expires_at,provider.code,
    jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,'unitName',unit.name,
      'role',assignment.role) ORDER BY unit.code,unit.id),was_replayed
  FROM public.user_invitations invitation
  JOIN public.oidc_providers provider ON provider.tenant_id=invitation.tenant_id AND provider.id=invitation.oidc_provider_id
  JOIN public.user_invitation_units assignment ON assignment.tenant_id=invitation.tenant_id AND assignment.invitation_id=invitation.id
  JOIN public.units unit ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.unit_id
  WHERE invitation.tenant_id=tenant_id_value AND invitation.id=replacement_invitation_id
  GROUP BY invitation.id,provider.code;
END $$;

REVOKE ALL ON FUNCTION admin_change_user_status(text,bytea,uuid,integer,text,text),
  admin_list_user_invitations(uuid,integer),
  admin_revoke_user_invitation(text,bytea,uuid,text),
  admin_reissue_user_invitation(text,bytea,uuid,uuid,timestamptz,bytea,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION admin_change_user_status(text,bytea,uuid,integer,text,text),
  admin_list_user_invitations(uuid,integer),
  admin_revoke_user_invitation(text,bytea,uuid,text),
  admin_reissue_user_invitation(text,bytea,uuid,uuid,timestamptz,bytea,text)
  TO zap_pronto_api;

COMMIT;
