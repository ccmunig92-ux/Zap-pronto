BEGIN;

ALTER TABLE public.human_handoffs
  ADD COLUMN request_fingerprint char(64),
  ADD CONSTRAINT human_handoffs_request_fingerprint_format
    CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$');

COMMENT ON COLUMN public.human_handoffs.request_fingerprint IS
  'SHA-256 canonico de serviceCaseId, reason, priority e slaDueAt normalizados. NULL identifica registros legados, cujo replay compara os campos persistidos.';

COMMIT;
