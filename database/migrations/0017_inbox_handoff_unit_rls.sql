BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON human_handoffs;
DROP POLICY IF EXISTS tenant_unit_isolation ON human_handoffs;
DROP POLICY IF EXISTS handoff_read ON human_handoffs;
DROP POLICY IF EXISTS handoff_insert ON human_handoffs;
DROP POLICY IF EXISTS handoff_update ON human_handoffs;
CREATE POLICY handoff_read ON human_handoffs FOR SELECT
USING (tenant_id=current_app_tenant_id() AND current_actor_has_permission('handoff.read',unit_id));
CREATE POLICY handoff_insert ON human_handoffs FOR INSERT
WITH CHECK (tenant_id=current_app_tenant_id() AND current_actor_has_permission('handoff.claim',unit_id));
CREATE POLICY handoff_update ON human_handoffs FOR UPDATE
USING (tenant_id=current_app_tenant_id() AND current_actor_has_permission('handoff.claim',unit_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND current_actor_has_permission('handoff.claim',unit_id));

CREATE INDEX IF NOT EXISTS handoffs_inbox_queue_idx
  ON human_handoffs (
    tenant_id, unit_id,
    (CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END),
    queued_at, id
  )
  WHERE status='QUEUED';

CREATE TABLE handoff_claim_commands (
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  handoff_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  actor_id uuid NOT NULL,
  result_version integer NOT NULL CHECK (result_version > expected_version),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,idempotency_key),
  FOREIGN KEY (handoff_id) REFERENCES human_handoffs(id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
ALTER TABLE handoff_claim_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_claim_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handoff_claim_commands_unit_isolation ON handoff_claim_commands;
DROP POLICY IF EXISTS handoff_claim_commands_claim ON handoff_claim_commands;
CREATE POLICY handoff_claim_commands_claim ON handoff_claim_commands
USING (tenant_id=current_app_tenant_id() AND EXISTS (
  SELECT 1 FROM human_handoffs handoff
  WHERE handoff.tenant_id=handoff_claim_commands.tenant_id
    AND handoff.id=handoff_claim_commands.handoff_id
    AND current_actor_has_permission('handoff.claim',handoff.unit_id)
))
WITH CHECK (tenant_id=current_app_tenant_id() AND actor_id=current_app_actor_id() AND EXISTS (
  SELECT 1 FROM human_handoffs handoff
  WHERE handoff.tenant_id=handoff_claim_commands.tenant_id
    AND handoff.id=handoff_claim_commands.handoff_id
    AND current_actor_has_permission('handoff.claim',handoff.unit_id)
));

REVOKE ALL ON handoff_claim_commands FROM PUBLIC;
GRANT SELECT,INSERT ON handoff_claim_commands TO zap_pronto_api;
REVOKE SELECT ON human_handoffs FROM zap_pronto_worker;

COMMIT;
