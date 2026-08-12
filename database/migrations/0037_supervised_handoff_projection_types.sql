BEGIN;
CREATE OR REPLACE FUNCTION list_inbox_supervised_handoffs(requested_unit_id uuid,requested_limit integer,
  anchor_claimed_at timestamptz DEFAULT NULL,anchor_id uuid DEFAULT NULL,requested_now timestamptz DEFAULT now())
RETURNS TABLE(id uuid,conversation_id uuid,service_case_id uuid,unit_id uuid,contact_name text,reason text,
  priority text,status text,assigned_user_id uuid,requested_at timestamptz,queued_at timestamptz,sla_due_at timestamptz,
  sla_status text,automation_status text,version integer,claimed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  PERFORM public.assert_app_context_authorized();
  IF requested_unit_id IS NULL OR requested_limit NOT BETWEEN 1 AND 101 OR (anchor_claimed_at IS NULL)<>(anchor_id IS NULL) OR requested_now IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUPERVISED_HANDOFF_LIST_REQUEST' USING ERRCODE='P0001'; END IF;
  IF NOT public.current_actor_has_permission('handoff.takeover',requested_unit_id) THEN
    RAISE EXCEPTION 'SUPERVISED_HANDOFF_LIST_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.human_handoffs handoff
    JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
    JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
    WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.id=anchor_id AND handoff.unit_id=requested_unit_id
      AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL AND handoff.claimed_at IS NOT NULL
      AND handoff.assigned_user_id<>public.current_app_actor_id() AND date_trunc('milliseconds',handoff.claimed_at)=anchor_claimed_at
      AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE'
      AND conversation.assigned_user_id=handoff.assigned_user_id AND conversation.unit_id=handoff.unit_id
      AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id AND service_case.conversation_id=handoff.conversation_id)
    THEN RAISE EXCEPTION 'INVALID_PAGE_CURSOR' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT handoff.id,handoff.conversation_id,handoff.service_case_id,handoff.unit_id,
    pg_catalog.left(contact.display_name,200),handoff.reason,handoff.priority::text,handoff.status::text,
    handoff.assigned_user_id,handoff.requested_at,handoff.queued_at,handoff.sla_due_at,
    (CASE WHEN handoff.sla_due_at IS NULL THEN NULL WHEN handoff.sla_due_at<=requested_now THEN 'OVERDUE'
      WHEN handoff.sla_due_at<=requested_now+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END)::text,
    conversation.automation_status::text,handoff.version,handoff.claimed_at
  FROM public.human_handoffs handoff
  JOIN public.conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id
  JOIN public.service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id
  JOIN public.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
  JOIN public.units unit ON unit.tenant_id=handoff.tenant_id AND unit.id=handoff.unit_id AND unit.active
  WHERE handoff.tenant_id=public.current_app_tenant_id() AND handoff.unit_id=requested_unit_id
    AND handoff.status='ACTIVE' AND handoff.assigned_user_id IS NOT NULL AND handoff.claimed_at IS NOT NULL
    AND handoff.assigned_user_id<>public.current_app_actor_id() AND conversation.status='OPEN'
    AND conversation.automation_status='HUMAN_ACTIVE' AND conversation.assigned_user_id=handoff.assigned_user_id
    AND conversation.unit_id=handoff.unit_id AND service_case.status='IN_REVIEW' AND service_case.unit_id=handoff.unit_id
    AND service_case.conversation_id=handoff.conversation_id
    AND (anchor_id IS NULL OR (date_trunc('milliseconds',handoff.claimed_at),handoff.id)<(anchor_claimed_at,anchor_id))
  ORDER BY date_trunc('milliseconds',handoff.claimed_at) DESC,handoff.id DESC LIMIT requested_limit;
END $$;
REVOKE ALL ON FUNCTION list_inbox_supervised_handoffs(uuid,integer,timestamptz,uuid,timestamptz) FROM PUBLIC,zap_pronto_app,zap_pronto_worker;
GRANT EXECUTE ON FUNCTION list_inbox_supervised_handoffs(uuid,integer,timestamptz,uuid,timestamptz) TO zap_pronto_api;
COMMIT;
