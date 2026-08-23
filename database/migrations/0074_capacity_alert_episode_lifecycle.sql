BEGIN;

-- A capacity alert is an operational episode, not a transient projection.  The
-- episode belongs to the tenant and unit and is deliberately independent from
-- the Inbox handoff acknowledgement rows.
CREATE TABLE unit_capacity_alert_episodes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  policy_version integer NOT NULL CHECK(policy_version>0),
  fingerprint char(64) NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN('OPEN','ACKNOWLEDGED','ESCALATED','RESOLVED')),
  opened_at timestamptz NOT NULL,
  last_evaluated_at timestamptz NOT NULL,
  cooldown_until timestamptz NOT NULL,
  escalation_level integer NOT NULL DEFAULT 0 CHECK(escalation_level>=0),
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid,
  acknowledgement_reason text CHECK(acknowledgement_reason IS NULL OR length(btrim(acknowledgement_reason)) BETWEEN 3 AND 500),
  escalated_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
  FOREIGN KEY(tenant_id,acknowledged_by_user_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX unit_capacity_alert_one_open_episode
  ON unit_capacity_alert_episodes(tenant_id,unit_id,policy_version)
  WHERE status<>'RESOLVED';
CREATE UNIQUE INDEX unit_capacity_alert_active_fingerprint
  ON unit_capacity_alert_episodes(tenant_id,unit_id,policy_version,fingerprint)
  WHERE status<>'RESOLVED';
CREATE INDEX unit_capacity_alert_episode_history_idx
  ON unit_capacity_alert_episodes(tenant_id,unit_id,opened_at DESC);

CREATE TABLE unit_capacity_alert_episode_recipients(
  tenant_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  recipient_role text NOT NULL,
  notified_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  PRIMARY KEY(tenant_id,episode_id,recipient_user_id),
  FOREIGN KEY(tenant_id,episode_id) REFERENCES unit_capacity_alert_episodes(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,recipient_user_id) REFERENCES users(tenant_id,id)
);

CREATE TABLE unit_capacity_alert_episode_commands(
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  episode_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0),
  request_fingerprint char(64) NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  result_status text NOT NULL CHECK(result_status IN('ACKNOWLEDGED','ESCALATED')),
  result_version integer NOT NULL CHECK(result_version>0),
  result_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,episode_id) REFERENCES unit_capacity_alert_episodes(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);

ALTER TABLE unit_capacity_alert_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_episode_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_episode_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_episode_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_capacity_alert_episode_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_capacity_alert_episode_tenant ON unit_capacity_alert_episodes
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_capacity_alert_recipient_tenant ON unit_capacity_alert_episode_recipients
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
CREATE POLICY unit_capacity_alert_command_tenant ON unit_capacity_alert_episode_commands
  USING(tenant_id=current_app_tenant_id()) WITH CHECK(tenant_id=current_app_tenant_id());
REVOKE ALL ON unit_capacity_alert_episodes,unit_capacity_alert_episode_recipients,unit_capacity_alert_episode_commands
  FROM PUBLIC,zap_pronto_app,zap_pronto_api,zap_pronto_worker;

-- The worker is the only caller that creates/evaluates episodes.  The function
-- is deterministic at a supplied timestamp, serializes one unit, and returns
-- whether a notification/escalation is due.  No external transport is called.
CREATE FUNCTION evaluate_unit_capacity_alert_episode(requested_unit_id uuid,requested_as_of timestamptz,
  requested_cooldown interval DEFAULT interval '15 minutes')
RETURNS TABLE(episode_id uuid,status text,should_notify boolean,escalation_level integer,
  cooldown_until timestamptz,version integer,recipient_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE tenant_id_value uuid:=public.current_app_tenant_id(); policy_record record;queued_count integer;
  sustained_count integer;capacity integer;oldest_queued timestamptz;active_episode public.unit_capacity_alert_episodes%ROWTYPE;
  episode_fingerprint text;next_status text;notify boolean:=false;level integer;next_cooldown timestamptz;
BEGIN
  IF requested_unit_id IS NULL OR requested_as_of IS NULL OR requested_cooldown<interval '1 minute'
    OR requested_cooldown>interval '24 hours' THEN RAISE EXCEPTION 'INVALID_CAPACITY_ALERT_EPISODE_REQUEST' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':capacity-alert-episode:'||requested_unit_id::text,0));
  SELECT policy.* INTO policy_record FROM public.unit_capacity_alert_policy_versions policy
    WHERE policy.tenant_id=tenant_id_value AND policy.unit_id=requested_unit_id
    ORDER BY policy.version DESC LIMIT 1;
  IF policy_record.id IS NULL THEN RAISE EXCEPTION 'CAPACITY_ALERT_POLICY_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT count(*)::integer,min(handoff.queued_at) INTO queued_count,oldest_queued
    FROM public.human_handoffs handoff WHERE handoff.tenant_id=tenant_id_value AND handoff.unit_id=requested_unit_id
      AND handoff.status='QUEUED' AND handoff.queued_at<=requested_as_of;
  SELECT count(*)::integer INTO sustained_count FROM public.human_handoffs handoff
    WHERE handoff.tenant_id=tenant_id_value AND handoff.unit_id=requested_unit_id AND handoff.status='QUEUED'
      AND handoff.queued_at<=requested_as_of-make_interval(mins=>policy_record.sustained_minutes);
  capacity:=public.get_unit_available_capacity_internal(tenant_id_value,requested_unit_id,requested_as_of);
  SELECT episode.* INTO active_episode FROM public.unit_capacity_alert_episodes episode
    WHERE episode.tenant_id=tenant_id_value AND episode.unit_id=requested_unit_id
      AND episode.policy_version=policy_record.version AND episode.status<>'RESOLVED' FOR UPDATE;
  IF NOT policy_record.enabled OR sustained_count<policy_record.minimum_queued OR capacity<=0 THEN
    IF active_episode.id IS NOT NULL THEN
      UPDATE public.unit_capacity_alert_episodes AS episode SET status='RESOLVED',closed_at=requested_as_of,
        last_evaluated_at=requested_as_of,version=episode.version+1 WHERE episode.tenant_id=tenant_id_value AND episode.id=active_episode.id;
    END IF;
    RETURN QUERY SELECT active_episode.id,'RESOLVED'::text,false,COALESCE(active_episode.escalation_level,0),
      active_episode.cooldown_until,COALESCE(active_episode.version,1),0; RETURN;
  END IF;
  episode_fingerprint:=encode(digest(convert_to(format('%s:%s:%s',requested_unit_id,policy_record.version,
    COALESCE(oldest_queued,requested_as_of)),'UTF8'),'sha256'),'hex');
  IF active_episode.id IS NULL THEN
    INSERT INTO public.unit_capacity_alert_episodes(tenant_id,unit_id,policy_version,fingerprint,status,opened_at,
      last_evaluated_at,cooldown_until) VALUES(tenant_id_value,requested_unit_id,policy_record.version,episode_fingerprint,
      'OPEN',requested_as_of,requested_as_of,requested_as_of+requested_cooldown) RETURNING * INTO active_episode;
    INSERT INTO public.unit_capacity_alert_episode_recipients(tenant_id,episode_id,recipient_user_id,recipient_role,notified_at)
      SELECT tenant_id_value,active_episode.id,membership.user_id,membership.role::text,requested_as_of
      FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id
        AND account.id=membership.user_id AND account.status='ACTIVE'
      WHERE membership.tenant_id=tenant_id_value AND membership.unit_id=requested_unit_id
        AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR');
    GET DIAGNOSTICS recipient_count=ROW_COUNT;
    notify:=true; level:=0; next_status:='OPEN'; next_cooldown:=active_episode.cooldown_until;
  ELSIF requested_as_of>=active_episode.cooldown_until THEN
    level:=active_episode.escalation_level+1; next_status:='ESCALATED'; notify:=true; next_cooldown:=requested_as_of+requested_cooldown;
    UPDATE public.unit_capacity_alert_episodes AS episode SET status=next_status,escalation_level=level,escalated_at=requested_as_of,
      last_evaluated_at=requested_as_of,cooldown_until=next_cooldown,version=episode.version+1 WHERE episode.tenant_id=tenant_id_value AND episode.id=active_episode.id
      RETURNING * INTO active_episode;
    INSERT INTO public.unit_capacity_alert_episode_recipients(tenant_id,episode_id,recipient_user_id,recipient_role,notified_at)
      SELECT tenant_id_value,active_episode.id,membership.user_id,membership.role::text,requested_as_of
      FROM public.user_units membership JOIN public.users account ON account.tenant_id=membership.tenant_id
        AND account.id=membership.user_id AND account.status='ACTIVE'
      WHERE membership.tenant_id=tenant_id_value AND membership.unit_id=requested_unit_id
        AND membership.status='ACTIVE' AND membership.role IN('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR')
      ON CONFLICT (tenant_id,episode_id,recipient_user_id) DO NOTHING;
    SELECT count(*)::integer INTO recipient_count FROM public.unit_capacity_alert_episode_recipients recipient
      WHERE recipient.tenant_id=tenant_id_value AND recipient.episode_id=active_episode.id;
  ELSE
    UPDATE public.unit_capacity_alert_episodes AS episode SET last_evaluated_at=requested_as_of,version=episode.version+1
      WHERE episode.tenant_id=tenant_id_value AND episode.id=active_episode.id RETURNING episode.* INTO active_episode;
    SELECT count(*)::integer INTO recipient_count FROM public.unit_capacity_alert_episode_recipients recipient
      WHERE recipient.tenant_id=tenant_id_value AND recipient.episode_id=active_episode.id;
    level:=active_episode.escalation_level;next_status:=active_episode.status;next_cooldown:=active_episode.cooldown_until;
  END IF;
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_id_value,'SYSTEM',NULL,CASE WHEN next_status='ESCALATED' THEN 'CAPACITY_ALERT_ESCALATED' ELSE 'CAPACITY_ALERT_OPENED' END,
      'unit_capacity_alert_episode',active_episode.id::text,jsonb_build_object('unitId',requested_unit_id,'policyVersion',policy_record.version,
      'escalationLevel',level,'shouldNotify',notify,'recipientCount',recipient_count));
  RETURN QUERY SELECT active_episode.id,next_status,notify,level,next_cooldown,active_episode.version,recipient_count;
END $$;
REVOKE ALL ON FUNCTION evaluate_unit_capacity_alert_episode(uuid,timestamptz,interval) FROM PUBLIC,zap_pronto_app,zap_pronto_api;
GRANT EXECUTE ON FUNCTION evaluate_unit_capacity_alert_episode(uuid,timestamptz,interval) TO zap_pronto_worker;

CREATE FUNCTION acknowledge_capacity_alert_episode(requested_episode_id uuid,requested_expected_version integer,
  requested_reason text,requested_idempotency_key text,requested_fingerprint text)
RETURNS TABLE(episode_id uuid,status text,acknowledged_at timestamptz,acknowledged_by_user_id uuid,version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE tenant_id_value uuid:=public.current_app_tenant_id(); normalized_key text:=btrim(requested_idempotency_key);
  normalized_reason text:=btrim(requested_reason); computed text; command_record public.unit_capacity_alert_episode_commands%ROWTYPE;
  episode_record public.unit_capacity_alert_episodes%ROWTYPE;now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_episode_id IS NULL OR requested_expected_version<1 OR length(normalized_key) NOT BETWEEN 8 AND 200
    OR length(normalized_reason) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT' USING ERRCODE='22023'; END IF;
  computed:=encode(digest(convert_to(format('{"expectedVersion":%s,"episodeId":"%s","reason":"%s"}',requested_expected_version,
    lower(requested_episode_id::text),replace(normalized_reason,'"','\\"')),'UTF8'),'sha256'),'hex');
  IF requested_fingerprint IS DISTINCT FROM computed THEN RAISE EXCEPTION 'INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id_value::text||':capacity-alert-episode-command:'||normalized_key,0));
  SELECT command.* INTO command_record FROM public.unit_capacity_alert_episode_commands command
    WHERE command.tenant_id=tenant_id_value AND command.idempotency_key=normalized_key;
  IF FOUND THEN
    IF command_record.episode_id<>requested_episode_id OR command_record.expected_version<>requested_expected_version
      OR command_record.actor_id<>public.current_app_actor_id() OR command_record.request_fingerprint<>computed
      OR command_record.result_status<>'ACKNOWLEDGED' THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001'; END IF;
    RETURN QUERY SELECT command_record.episode_id,command_record.result_status,command_record.result_at,command_record.actor_id,command_record.result_version,true; RETURN;
  END IF;
  SELECT episode.* INTO episode_record FROM public.unit_capacity_alert_episodes episode
    WHERE episode.tenant_id=tenant_id_value AND episode.id=requested_episode_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_actor_has_permission('sla_alert.acknowledge',episode_record.unit_id)
    OR episode_record.status='RESOLVED' THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF episode_record.version<>requested_expected_version THEN RAISE EXCEPTION 'CAPACITY_ALERT_EPISODE_CONFLICT' USING ERRCODE='P0001'; END IF;
  UPDATE public.unit_capacity_alert_episodes AS episode SET status='ACKNOWLEDGED',acknowledged_at=now_at,
    acknowledged_by_user_id=public.current_app_actor_id(),acknowledgement_reason=normalized_reason,version=episode.version+1
    WHERE episode.tenant_id=tenant_id_value AND episode.id=episode_record.id RETURNING episode.* INTO episode_record;
  UPDATE public.unit_capacity_alert_episode_recipients SET acknowledged_at=now_at
    WHERE tenant_id=tenant_id_value AND episode_id=episode_record.id AND recipient_user_id=public.current_app_actor_id();
  INSERT INTO public.unit_capacity_alert_episode_commands(tenant_id,idempotency_key,episode_id,expected_version,request_fingerprint,actor_id,result_status,result_version,result_at)
    VALUES(tenant_id_value,normalized_key,episode_record.id,requested_expected_version,computed,public.current_app_actor_id(),'ACKNOWLEDGED',episode_record.version,now_at);
  INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES(tenant_id_value,'USER',public.current_app_actor_id(),'CAPACITY_ALERT_ACKNOWLEDGED','unit_capacity_alert_episode',episode_record.id::text,
      jsonb_build_object('unitId',episode_record.unit_id,'reason',normalized_reason,'version',episode_record.version));
  RETURN QUERY SELECT episode_record.id,episode_record.status,episode_record.acknowledged_at,episode_record.acknowledged_by_user_id,episode_record.version,false;
END $$;
REVOKE ALL ON FUNCTION acknowledge_capacity_alert_episode(uuid,integer,text,text,text) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION acknowledge_capacity_alert_episode(uuid,integer,text,text,text) TO zap_pronto_api;

COMMIT;
