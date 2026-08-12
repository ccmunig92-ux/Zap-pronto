BEGIN;
CREATE INDEX handoffs_inbox_sla_queue_idx ON human_handoffs(
  tenant_id,unit_id,
  (CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END),
  ((sla_due_at IS NULL)),sla_due_at,queued_at,id
) WHERE status='QUEUED';
COMMIT;
