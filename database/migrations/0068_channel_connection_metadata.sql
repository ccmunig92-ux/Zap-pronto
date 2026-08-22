BEGIN;

-- Metadados não secretos para a tela de administração de canais. O token Meta
-- continua fora do banco; secret_reference é apenas um apontador para o
-- secret manager/arquivo de secret do ambiente.
ALTER TABLE channel_connections
  ADD COLUMN IF NOT EXISTS waba_id text,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_waba_id_nonblank
  CHECK (waba_id IS NULL OR length(btrim(waba_id)) BETWEEN 1 AND 128);

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_display_name_nonblank
  CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 160);

INSERT INTO app_permissions (code) VALUES
  ('channel_connections.read'), ('channel_connections.manage')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app_role_permissions (role_code, permission_code)
VALUES ('TENANT_ADMIN','channel_connections.read'), ('TENANT_ADMIN','channel_connections.manage')
ON CONFLICT DO NOTHING;

COMMIT;
