BEGIN;

CREATE TYPE conversation_lifecycle_status AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');
CREATE TYPE service_case_lifecycle_status AS ENUM (
  'COLLECTING', 'READY_FOR_HANDOFF', 'WAITING_HUMAN', 'IN_REVIEW',
  'RESOLVED', 'CANCELLED', 'FAILED'
);
CREATE TYPE handoff_lifecycle_status AS ENUM (
  'REQUESTED', 'QUEUED', 'ACTIVE', 'RESOLVED', 'FAILED', 'CANCELLED'
);
CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD');

ALTER TABLE conversations
  ADD COLUMN status conversation_lifecycle_status NOT NULL DEFAULT 'OPEN',
  ADD COLUMN state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT conversations_closed_state_consistency
    CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status <> 'OPEN' AND closed_at IS NOT NULL));

ALTER TABLE service_cases DROP CONSTRAINT service_cases_routed_before_handoff;
ALTER TABLE service_cases ALTER COLUMN status DROP DEFAULT;
ALTER TABLE service_cases
  ALTER COLUMN status TYPE service_case_lifecycle_status
  USING status::service_case_lifecycle_status;
ALTER TABLE service_cases ALTER COLUMN status SET DEFAULT 'COLLECTING';
ALTER TABLE service_cases
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN resolved_at timestamptz;
UPDATE service_cases SET resolved_at = now() WHERE status IN ('RESOLVED', 'CANCELLED');
ALTER TABLE service_cases
  ADD CONSTRAINT service_cases_routed_before_handoff
    CHECK (status = 'COLLECTING' OR unit_id IS NOT NULL),
  ADD CONSTRAINT service_cases_terminal_state_consistency
    CHECK ((status IN ('RESOLVED', 'CANCELLED') AND resolved_at IS NOT NULL)
      OR (status NOT IN ('RESOLVED', 'CANCELLED') AND resolved_at IS NULL));

UPDATE human_handoffs
SET status = CASE WHEN status = 'ASSIGNED' AND assigned_user_id IS NOT NULL THEN 'ACTIVE' ELSE 'QUEUED' END
WHERE status = 'ASSIGNED';
ALTER TABLE human_handoffs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE human_handoffs
  ALTER COLUMN status TYPE handoff_lifecycle_status
  USING status::handoff_lifecycle_status;
ALTER TABLE human_handoffs ALTER COLUMN status SET DEFAULT 'REQUESTED';
ALTER TABLE human_handoffs
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN first_human_response_at timestamptz,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sla_due_at timestamptz;
UPDATE human_handoffs SET
  queued_at = CASE WHEN status IN ('QUEUED', 'ACTIVE') THEN requested_at ELSE queued_at END,
  claimed_at = CASE WHEN status = 'ACTIVE' THEN requested_at ELSE claimed_at END,
  resolved_at = CASE WHEN status IN ('RESOLVED', 'FAILED', 'CANCELLED') THEN requested_at ELSE resolved_at END;
ALTER TABLE human_handoffs
  ADD CONSTRAINT human_handoffs_queued_state_consistency
    CHECK (status NOT IN ('QUEUED', 'ACTIVE') OR queued_at IS NOT NULL),
  ADD CONSTRAINT human_handoffs_active_state_consistency
    CHECK (status <> 'ACTIVE' OR (assigned_user_id IS NOT NULL AND claimed_at IS NOT NULL)),
  ADD CONSTRAINT human_handoffs_terminal_state_consistency
    CHECK ((status IN ('RESOLVED', 'FAILED', 'CANCELLED') AND resolved_at IS NOT NULL)
      OR (status NOT IN ('RESOLVED', 'FAILED', 'CANCELLED') AND resolved_at IS NULL));

CREATE UNIQUE INDEX human_handoffs_one_open_per_conversation
  ON human_handoffs (tenant_id, conversation_id)
  WHERE status IN ('REQUESTED', 'QUEUED', 'ACTIVE');
DROP INDEX handoffs_queue_idx;
CREATE INDEX handoffs_queue_idx
  ON human_handoffs (tenant_id, unit_id, priority, requested_at, id)
  WHERE status IN ('REQUESTED', 'QUEUED');

CREATE TABLE workflow_transitions (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('CONVERSATION', 'SERVICE_CASE', 'HANDOFF')),
  aggregate_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  actor_id uuid,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX workflow_transitions_timeline_idx
  ON workflow_transitions (tenant_id, aggregate_type, aggregate_id, occurred_at, id);

CREATE FUNCTION enforce_operational_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      allowed := (OLD.status = 'OPEN' AND NEW.status = 'CLOSED')
        OR (OLD.status = 'CLOSED' AND NEW.status = 'ARCHIVED');
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW.automation_status IS DISTINCT FROM OLD.automation_status THEN
      allowed := (OLD.automation_status = 'ACTIVE' AND NEW.automation_status = 'HUMAN_REQUESTED')
        OR (OLD.automation_status = 'HUMAN_REQUESTED' AND NEW.automation_status = 'HUMAN_QUEUED')
        OR (OLD.automation_status = 'HUMAN_QUEUED' AND NEW.automation_status = 'HUMAN_ACTIVE')
        OR (OLD.automation_status IN ('HUMAN_REQUESTED', 'HUMAN_QUEUED', 'HUMAN_ACTIVE')
          AND NEW.automation_status = 'SUSPENDED');
      IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE = '23514'; END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'service_cases' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed := (OLD.status = 'COLLECTING' AND NEW.status IN ('READY_FOR_HANDOFF', 'WAITING_HUMAN', 'FAILED', 'CANCELLED'))
      OR (OLD.status = 'READY_FOR_HANDOFF' AND NEW.status IN ('WAITING_HUMAN', 'FAILED', 'CANCELLED'))
      OR (OLD.status = 'WAITING_HUMAN' AND NEW.status IN ('IN_REVIEW', 'RESOLVED', 'FAILED', 'CANCELLED'))
      OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('RESOLVED', 'FAILED', 'CANCELLED'));
  ELSIF TG_TABLE_NAME = 'human_handoffs' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    allowed := (OLD.status = 'REQUESTED' AND NEW.status IN ('QUEUED', 'FAILED', 'CANCELLED'))
      OR (OLD.status = 'QUEUED' AND NEW.status IN ('ACTIVE', 'FAILED', 'CANCELLED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('RESOLVED', 'FAILED', 'CANCELLED'));
  END IF;

  IF NOT allowed THEN RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION enforce_operational_transition() FROM PUBLIC;

CREATE TRIGGER conversations_transition_guard
  BEFORE UPDATE OF status, automation_status ON conversations
  FOR EACH ROW EXECUTE FUNCTION enforce_operational_transition();
CREATE TRIGGER service_cases_transition_guard
  BEFORE UPDATE OF status ON service_cases
  FOR EACH ROW EXECUTE FUNCTION enforce_operational_transition();
CREATE TRIGGER human_handoffs_transition_guard
  BEFORE UPDATE OF status ON human_handoffs
  FOR EACH ROW EXECUTE FUNCTION enforce_operational_transition();

ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_transitions
  USING (tenant_id = current_app_tenant_id())
  WITH CHECK (tenant_id = current_app_tenant_id());

ALTER TABLE outbox_events
  ADD COLUMN status outbox_status,
  ADD COLUMN available_at timestamptz,
  ADD COLUMN lease_token uuid,
  ADD COLUMN leased_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN max_attempts integer,
  ADD COLUMN last_error text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  ADD COLUMN updated_at timestamptz;

UPDATE outbox_events SET
  status = CASE WHEN published_at IS NULL THEN 'PENDING'::outbox_status ELSE 'PUBLISHED'::outbox_status END,
  available_at = COALESCE(occurred_at, now()),
  max_attempts = GREATEST(8, attempts),
  updated_at = COALESCE(published_at, occurred_at, now());

ALTER TABLE outbox_events
  ALTER COLUMN status SET DEFAULT 'PENDING',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN available_at SET DEFAULT now(),
  ALTER COLUMN available_at SET NOT NULL,
  ALTER COLUMN max_attempts SET DEFAULT 8,
  ALTER COLUMN max_attempts SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT outbox_max_attempts_valid CHECK (max_attempts > 0),
  ADD CONSTRAINT outbox_attempts_valid CHECK (attempts >= 0 AND attempts <= max_attempts),
  ADD CONSTRAINT outbox_lease_consistency CHECK (
    (status = 'PROCESSING' AND lease_token IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'PROCESSING' AND lease_token IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT outbox_terminal_state_consistency CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL AND dead_lettered_at IS NULL)
    OR (status = 'DEAD' AND dead_lettered_at IS NOT NULL AND published_at IS NULL)
    OR (status IN ('PENDING', 'PROCESSING') AND published_at IS NULL AND dead_lettered_at IS NULL)
  );
DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_claim_idx
  ON outbox_events (available_at, occurred_at, id)
  WHERE status = 'PENDING';

GRANT SELECT, INSERT ON workflow_transitions TO zap_pronto_api;
GRANT USAGE, SELECT ON SEQUENCE workflow_transitions_id_seq TO zap_pronto_api;

COMMIT;
