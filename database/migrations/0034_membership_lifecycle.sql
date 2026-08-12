BEGIN;

ALTER TABLE user_units
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_user_id uuid,
  ADD COLUMN revocation_reason text,
  ADD CONSTRAINT user_units_status_check CHECK (status IN ('ACTIVE','REVOKED')),
  ADD CONSTRAINT user_units_version_check CHECK (version > 0),
  ADD CONSTRAINT user_units_lifecycle_check CHECK (
    (status='ACTIVE' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND length(btrim(revocation_reason)) BETWEEN 3 AND 500)
  ),
  ADD CONSTRAINT user_units_revoked_by_fk FOREIGN KEY (tenant_id,revoked_by_user_id)
    REFERENCES users(tenant_id,id);

CREATE TABLE membership_lifecycle_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  user_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  operation text NOT NULL CHECK (operation IN ('REVOKE','REACTIVATE')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint)=32),
  actor_id uuid NOT NULL,
  result_status text NOT NULL CHECK (result_status IN ('ACTIVE','REVOKED')),
  result_version integer NOT NULL CHECK (result_version > 0),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,user_id,unit_id) REFERENCES user_units(tenant_id,user_id,unit_id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE membership_lifecycle_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_lifecycle_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_lifecycle_commands_tenant ON membership_lifecycle_commands
  USING (tenant_id=current_app_tenant_id()) WITH CHECK (tenant_id=current_app_tenant_id());
REVOKE ALL ON membership_lifecycle_commands FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE OR REPLACE FUNCTION current_actor_has_permission(target_permission text,target_unit_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT CASE
    WHEN target_permission IS NULL OR btrim(target_permission)='' THEN false
    WHEN NOT EXISTS (SELECT 1 FROM public.users account JOIN public.tenants tenant ON tenant.id=account.tenant_id
      WHERE account.tenant_id=public.current_app_tenant_id() AND account.id=public.current_app_actor_id()
        AND account.status='ACTIVE' AND tenant.status='ACTIVE') THEN false
    WHEN target_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units unit
      WHERE unit.tenant_id=public.current_app_tenant_id() AND unit.id=target_unit_id AND unit.active) THEN false
    ELSE EXISTS (SELECT 1 FROM public.user_units membership
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active
      JOIN public.app_role_permissions permission ON permission.role_code=membership.role
      WHERE membership.tenant_id=public.current_app_tenant_id()
        AND membership.user_id=public.current_app_actor_id() AND membership.status='ACTIVE'
        AND permission.permission_code=target_permission
        AND (membership.role='TENANT_ADMIN' OR (target_unit_id IS NOT NULL AND membership.unit_id=target_unit_id)))
  END
$$;

CREATE FUNCTION admin_change_unit_membership(command_key text,command_fingerprint bytea,
  target_user_id uuid,target_unit_id uuid,requested_expected_version integer,
  requested_operation text,requested_reason text)
RETURNS TABLE(user_id uuid,unit_id uuid,status text,version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE tenant_id_value uuid:=public.current_app_tenant_id(); actor_id_value uuid:=public.current_app_actor_id();
  normalized_key text:=btrim(command_key); normalized_reason text:=btrim(requested_reason);
  existing_command public.membership_lifecycle_commands%ROWTYPE; membership_record public.user_units%ROWTYPE;
  next_status text; next_version integer; now_at timestamptz:=clock_timestamp(); expected_fingerprint bytea;
BEGIN
  IF length(normalized_key) NOT BETWEEN 8 AND 200 OR command_fingerprint IS NULL
    OR octet_length(command_fingerprint)<>32 OR target_user_id IS NULL OR target_unit_id IS NULL
    OR requested_expected_version IS NULL OR requested_expected_version<1
    OR requested_operation NOT IN ('REVOKE','REACTIVATE')
    OR length(normalized_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'INVALID_MEMBERSHIP_LIFECYCLE_REQUEST' USING ERRCODE='22023';
  END IF;
  IF target_user_id=actor_id_value THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  expected_fingerprint:=digest(convert_to(jsonb_build_object(
    'expectedVersion',requested_expected_version,
    'operation',requested_operation,
    'reason',normalized_reason,
    'unitId',lower(target_unit_id::text),
    'userId',lower(target_user_id::text)
  )::text,'UTF8'),'sha256');
  IF command_fingerprint<>expected_fingerprint THEN
    RAISE EXCEPTION 'INVALID_MEMBERSHIP_LIFECYCLE_REQUEST' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':membership:'||normalized_key,0));
  -- Lifecycle changes for one tenant serialize the authorization check and
  -- the last-admin invariant even when callers use different keys/targets.
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':membership-lifecycle',0));
  IF NOT public.current_actor_has_permission('unit.members.manage',target_unit_id) THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  SELECT command.* INTO existing_command FROM public.membership_lifecycle_commands command
  WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF existing_command.user_id<>target_user_id OR existing_command.unit_id<>target_unit_id
      OR existing_command.expected_version<>requested_expected_version
      OR existing_command.operation<>requested_operation
      OR existing_command.reason<>normalized_reason
      OR existing_command.request_fingerprint<>command_fingerprint
      OR existing_command.actor_id<>actor_id_value THEN
      RAISE EXCEPTION 'MEMBERSHIP_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing_command.user_id,existing_command.unit_id,
      existing_command.result_status,existing_command.result_version,true;
    RETURN;
  END IF;
  SELECT membership.* INTO membership_record FROM public.user_units membership
  JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
  JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
  WHERE membership.tenant_id=tenant_id_value AND membership.user_id=target_user_id
    AND membership.unit_id=target_unit_id AND account.status='ACTIVE' AND unit.active
  FOR UPDATE OF membership;
  IF NOT FOUND OR membership_record.version<>requested_expected_version THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  IF membership_record.role='TENANT_ADMIN'
    AND NOT public.current_actor_has_permission('tenant.users.manage',NULL) THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0001';
  END IF;
  next_status:=CASE requested_operation WHEN 'REVOKE' THEN 'REVOKED' ELSE 'ACTIVE' END;
  IF membership_record.status=next_status THEN
    RAISE EXCEPTION 'MEMBERSHIP_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF requested_operation='REVOKE' AND EXISTS (
    SELECT 1 FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=tenant_id_value AND handoff.unit_id=target_unit_id
      AND handoff.assigned_user_id=target_user_id AND handoff.status='ACTIVE'
    UNION ALL
    SELECT 1 FROM public.conversations conversation
    WHERE conversation.tenant_id=tenant_id_value AND conversation.unit_id=target_unit_id
      AND conversation.assigned_user_id=target_user_id AND conversation.automation_status='HUMAN_ACTIVE'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_HAS_ACTIVE_WORK' USING ERRCODE='P0001';
  END IF;
  IF requested_operation='REVOKE' AND membership_record.role='TENANT_ADMIN'
    AND NOT EXISTS (SELECT 1 FROM public.user_units other
      JOIN public.users account ON account.tenant_id=other.tenant_id AND account.id=other.user_id AND account.status='ACTIVE'
      JOIN public.units unit ON unit.tenant_id=other.tenant_id AND unit.id=other.unit_id AND unit.active
      WHERE other.tenant_id=tenant_id_value AND other.role='TENANT_ADMIN' AND other.status='ACTIVE'
        AND (other.user_id,other.unit_id)<>(target_user_id,target_unit_id)) THEN
    RAISE EXCEPTION 'LAST_TENANT_ADMIN' USING ERRCODE='P0001';
  END IF;
  UPDATE public.user_units membership SET status=next_status,version=membership.version+1,state_changed_at=now_at,
    revoked_at=CASE WHEN next_status='REVOKED' THEN now_at END,
    revoked_by_user_id=CASE WHEN next_status='REVOKED' THEN actor_id_value END,
    revocation_reason=CASE WHEN next_status='REVOKED' THEN normalized_reason END
  WHERE membership.tenant_id=tenant_id_value AND membership.user_id=target_user_id
    AND membership.unit_id=target_unit_id
  RETURNING membership.version INTO next_version;
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  VALUES(tenant_id_value,'USER',actor_id_value::text,'UNIT_MEMBERSHIP_'||requested_operation,
    'user_unit',target_user_id::text,jsonb_build_object('userId',target_user_id,'unitId',target_unit_id,
      'role',membership_record.role,'version',next_version,'reason',normalized_reason));
  INSERT INTO public.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(tenant_id_value,'user_membership',target_user_id,
    CASE requested_operation WHEN 'REVOKE' THEN 'user.membership.revoked' ELSE 'user.membership.reactivated' END,
    jsonb_build_object('userId',target_user_id,'unitId',target_unit_id,'role',membership_record.role,
      'status',next_status,'version',next_version),
    'user-membership:'||target_user_id::text||':'||target_unit_id::text||':'||next_version::text);
  INSERT INTO public.membership_lifecycle_commands(tenant_id,idempotency_key,user_id,unit_id,
    expected_version,operation,reason,request_fingerprint,actor_id,result_status,result_version,correlation_id)
  VALUES(tenant_id_value,normalized_key,target_user_id,target_unit_id,requested_expected_version,
    requested_operation,normalized_reason,command_fingerprint,actor_id_value,next_status,next_version,
    current_setting('app.correlation_id'));
  RETURN QUERY SELECT target_user_id,target_unit_id,next_status,next_version,false;
END $$;
REVOKE ALL ON FUNCTION admin_change_unit_membership(text,bytea,uuid,uuid,integer,text,text)
  FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION admin_change_unit_membership(text,bytea,uuid,uuid,integer,text,text) TO zap_pronto_api;

CREATE OR REPLACE FUNCTION list_inbox_handoff_transfer_candidates(requested_handoff_id uuid)
RETURNS TABLE(id uuid,display_name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT candidate.id,pg_catalog.left(candidate.display_name,160)
  FROM public.human_handoffs handoff
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  JOIN public.user_units membership ON membership.tenant_id=handoff.tenant_id AND membership.unit_id=handoff.unit_id
    AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT')
  JOIN public.users candidate ON candidate.tenant_id=membership.tenant_id AND candidate.id=membership.user_id AND candidate.status='ACTIVE'
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=requested_handoff_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id=public.current_app_actor_id()
    AND service_case.status='IN_REVIEW' AND conversation.automation_status='HUMAN_ACTIVE'
    AND conversation.assigned_user_id=public.current_app_actor_id()
    AND public.current_actor_has_permission('handoff.transfer',handoff.unit_id)
    AND candidate.id<>public.current_app_actor_id()
  ORDER BY candidate.display_name,candidate.id
$$;

/*
 * Assignment is an authorization boundary, not only a UI catalog concern.
 * This invariant also closes stale or concurrent transfer/claim paths which
 * selected a membership before it was revoked.
 */
CREATE FUNCTION enforce_active_human_assignee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL THEN
    IF NEW.unit_id IS NULL THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001';
    END IF;
    -- Preserve the existing composite FK error for a missing membership while
    -- fencing lifecycle UPDATEs whenever the membership row does exist.
    PERFORM 1 FROM public.user_units membership
      WHERE membership.tenant_id=NEW.tenant_id AND membership.user_id=NEW.assigned_user_id
        AND membership.unit_id=NEW.unit_id
      FOR KEY SHARE OF membership;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_units membership
      JOIN public.users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id
      JOIN public.units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=NEW.tenant_id AND membership.user_id=NEW.assigned_user_id
        AND membership.unit_id=NEW.unit_id AND membership.status='ACTIVE'
        AND account.status='ACTIVE' AND unit.active
    ) THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_active_human_assignee() FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

CREATE TRIGGER conversations_active_assignee
BEFORE INSERT OR UPDATE OF assigned_user_id,unit_id ON conversations
FOR EACH ROW WHEN (NEW.assigned_user_id IS NOT NULL)
EXECUTE FUNCTION enforce_active_human_assignee();

CREATE TRIGGER human_handoffs_active_assignee
BEFORE INSERT OR UPDATE OF assigned_user_id,unit_id ON human_handoffs
FOR EACH ROW WHEN (NEW.assigned_user_id IS NOT NULL)
EXECUTE FUNCTION enforce_active_human_assignee();

COMMIT;
