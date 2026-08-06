BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE channel_type AS ENUM ('WHATSAPP','INSTAGRAM','FACEBOOK_MESSENGER');
CREATE TYPE automation_status AS ENUM ('ACTIVE','HUMAN_REQUESTED','HUMAN_QUEUED','HUMAN_ACTIVE','SUSPENDED');
CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE units (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), code text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(tenant_id,code), UNIQUE(tenant_id,id));
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), email text NOT NULL, display_name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE', UNIQUE(tenant_id,email), UNIQUE(tenant_id,id));
CREATE TABLE user_units (tenant_id uuid NOT NULL, user_id uuid NOT NULL, unit_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('TENANT_ADMIN','UNIT_MANAGER','SUPERVISOR','ATTENDANT','AUDITOR')), PRIMARY KEY(tenant_id,user_id,unit_id), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id));
CREATE TABLE channel_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), type channel_type NOT NULL, scope text NOT NULL CHECK(scope IN ('CORPORATE','SINGLE_UNIT','SELECTED_UNITS')), external_account_id text NOT NULL, status text NOT NULL DEFAULT 'DISCONNECTED', secret_reference text, UNIQUE(tenant_id,type,external_account_id), UNIQUE(tenant_id,id));
CREATE TABLE channel_connection_units (tenant_id uuid NOT NULL, channel_connection_id uuid NOT NULL, unit_id uuid NOT NULL, PRIMARY KEY(tenant_id,channel_connection_id,unit_id), FOREIGN KEY(tenant_id,channel_connection_id) REFERENCES channel_connections(tenant_id,id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id));
CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), display_name text, phone_e164 text, UNIQUE(tenant_id,id));
CREATE TABLE contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_connection_id) REFERENCES channel_connections (tenant_id, id),
  UNIQUE (tenant_id, channel_connection_id, external_user_id),
  UNIQUE (tenant_id, id, contact_id, channel_connection_id),
  UNIQUE (tenant_id, id)
);
CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, channel_connection_id uuid NOT NULL, contact_id uuid NOT NULL, contact_identity_id uuid NOT NULL, unit_id uuid, automation_status automation_status NOT NULL DEFAULT 'ACTIVE', assigned_user_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,unit_id), FOREIGN KEY(tenant_id,channel_connection_id) REFERENCES channel_connections(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id), FOREIGN KEY(tenant_id,contact_identity_id,contact_id,channel_connection_id) REFERENCES contact_identities(tenant_id,id,contact_id,channel_connection_id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id), FOREIGN KEY(tenant_id,assigned_user_id) REFERENCES users(tenant_id,id), CHECK(automation_status<>'HUMAN_ACTIVE' OR assigned_user_id IS NOT NULL), CHECK(automation_status='ACTIVE' OR unit_id IS NOT NULL));
CREATE TABLE service_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, conversation_id uuid NOT NULL, unit_id uuid, kind text NOT NULL, status text NOT NULL DEFAULT 'COLLECTING', collected_data jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id));
CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, conversation_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')), actor text NOT NULL CHECK(actor IN ('CUSTOMER','HERMES','HUMAN','SYSTEM')), external_message_id text, body text, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,conversation_id,external_message_id), FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id));
CREATE TABLE message_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, message_id uuid NOT NULL, media_type text NOT NULL CHECK(media_type IN ('AUDIO','IMAGE','DOCUMENT','VIDEO','OTHER')), storage_key text NOT NULL, mime_type text NOT NULL, sha256 text NOT NULL, transcription text, extraction jsonb, UNIQUE(tenant_id,storage_key), FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id));
CREATE TABLE human_handoffs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, conversation_id uuid NOT NULL, service_case_id uuid NOT NULL, unit_id uuid, reason text NOT NULL, priority text NOT NULL DEFAULT 'NORMAL', status text NOT NULL DEFAULT 'REQUESTED', assigned_user_id uuid, idempotency_key text NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id), FOREIGN KEY(tenant_id,service_case_id) REFERENCES service_cases(tenant_id,id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id), FOREIGN KEY(tenant_id,assigned_user_id) REFERENCES users(tenant_id,id), UNIQUE(tenant_id,idempotency_key));
CREATE TABLE catalog_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), code text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(tenant_id,code), UNIQUE(tenant_id,id));
CREATE TABLE price_lists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), unit_id uuid NOT NULL, name text NOT NULL, UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id));
CREATE TABLE price_list_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, price_list_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), status text NOT NULL, effective_at timestamptz NOT NULL, UNIQUE(tenant_id,price_list_id,version), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id));
CREATE TABLE prices (tenant_id uuid NOT NULL, price_list_version_id uuid NOT NULL, catalog_item_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), currency char(3) NOT NULL DEFAULT 'BRL' CHECK(currency='BRL'), PRIMARY KEY(tenant_id,price_list_version_id,catalog_item_id), FOREIGN KEY(tenant_id,price_list_version_id) REFERENCES price_list_versions(tenant_id,id), FOREIGN KEY(tenant_id,catalog_item_id) REFERENCES catalog_items(tenant_id,id));
CREATE TABLE outbox_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL, idempotency_key text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, attempts integer NOT NULL DEFAULT 0, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE audit_events (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor_type text NOT NULL, actor_id text, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX conversations_queue_idx ON conversations(tenant_id,unit_id,automation_status,updated_at);
CREATE INDEX messages_timeline_idx ON messages(tenant_id,conversation_id,created_at);
CREATE INDEX handoffs_queue_idx ON human_handoffs(tenant_id,unit_id,status,priority,requested_at);
CREATE INDEX outbox_pending_idx ON outbox_events(occurred_at) WHERE published_at IS NULL;

-- Integridade semântica: o handoff deve pertencer à mesma conversa do caso.
ALTER TABLE service_cases
  ADD CONSTRAINT service_cases_tenant_id_id_conversation_id_unique
  UNIQUE (tenant_id, id, conversation_id),
  ADD CONSTRAINT service_cases_tenant_case_conversation_unit_unique
  UNIQUE (tenant_id, id, conversation_id, unit_id),
  ADD CONSTRAINT service_cases_conversation_unit_fk
  FOREIGN KEY (tenant_id, conversation_id, unit_id)
  REFERENCES conversations (tenant_id, id, unit_id),
  ADD CONSTRAINT service_cases_routed_before_handoff
  CHECK (status = 'COLLECTING' OR unit_id IS NOT NULL);
ALTER TABLE human_handoffs
  ADD CONSTRAINT human_handoffs_case_conversation_fk
  FOREIGN KEY (tenant_id, service_case_id, conversation_id)
  REFERENCES service_cases (tenant_id, id, conversation_id),
  ALTER COLUMN unit_id SET NOT NULL,
  ADD CONSTRAINT human_handoffs_case_conversation_unit_fk
  FOREIGN KEY (tenant_id, service_case_id, conversation_id, unit_id)
  REFERENCES service_cases (tenant_id, id, conversation_id, unit_id);

-- Um atendente só pode assumir uma conversa de uma unidade à qual pertence.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_assignment_requires_unit
  CHECK (assigned_user_id IS NULL OR unit_id IS NOT NULL),
  ADD CONSTRAINT conversations_assignee_unit_fk
  FOREIGN KEY (tenant_id, assigned_user_id, unit_id)
  REFERENCES user_units (tenant_id, user_id, unit_id);
ALTER TABLE human_handoffs
  ADD CONSTRAINT handoffs_assignment_requires_unit
  CHECK (assigned_user_id IS NULL OR unit_id IS NOT NULL),
  ADD CONSTRAINT handoffs_assignee_unit_fk
  FOREIGN KEY (tenant_id, assigned_user_id, unit_id)
  REFERENCES user_units (tenant_id, user_id, unit_id);

-- A unidade escolhida precisa estar autorizada na conexão corporativa.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_unit_fk
  FOREIGN KEY (tenant_id, channel_connection_id, unit_id)
  REFERENCES channel_connection_units (tenant_id, channel_connection_id, unit_id);

-- Papel sem login usado pela aplicação; autenticação permanece externa.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zap_pronto_app') THEN
    CREATE ROLE zap_pronto_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO zap_pronto_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zap_pronto_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zap_pronto_app;
REVOKE UPDATE, DELETE ON audit_events FROM zap_pronto_app;
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON schema_migrations FROM zap_pronto_app;
  END IF;
END
$$;

-- tenant_id vem exclusivamente do contexto transacional da conexão.
CREATE FUNCTION current_app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION current_app_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_tenant_id() TO zap_pronto_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_app_tenant_id())
  WITH CHECK (id = current_app_tenant_id());

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'units', 'users', 'user_units', 'channel_connections',
    'channel_connection_units', 'contacts', 'contact_identities', 'conversations', 'service_cases',
    'messages', 'message_attachments', 'human_handoffs', 'catalog_items',
    'price_lists', 'price_list_versions', 'prices', 'outbox_events', 'audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_app_tenant_id()) WITH CHECK (tenant_id = current_app_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;
COMMIT;
