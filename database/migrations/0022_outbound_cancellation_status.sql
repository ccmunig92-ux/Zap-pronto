BEGIN;
ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'CANCELLED';
COMMIT;

BEGIN;
ALTER TABLE messages DROP CONSTRAINT messages_delivery_status_valid;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_valid
  CHECK(delivery_status IS NULL OR delivery_status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','CANCELLED'));

ALTER TABLE outbox_events ADD COLUMN cancelled_at timestamptz;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_terminal_state_consistency;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_terminal_state_consistency CHECK(
  (status='PUBLISHED' AND published_at IS NOT NULL AND dead_lettered_at IS NULL)
  OR (status='DEAD' AND dead_lettered_at IS NOT NULL AND published_at IS NULL)
  OR (status IN ('PENDING','PROCESSING','CANCELLED') AND published_at IS NULL AND dead_lettered_at IS NULL)
);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_cancelled_at_consistent CHECK(
  (status='CANCELLED' AND cancelled_at IS NOT NULL AND published_at IS NULL AND dead_lettered_at IS NULL)
  OR (status<>'CANCELLED' AND cancelled_at IS NULL)
);
COMMIT;
