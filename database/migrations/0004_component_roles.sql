BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zap_pronto_api') THEN
    CREATE ROLE zap_pronto_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zap_pronto_worker') THEN
    CREATE ROLE zap_pronto_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE zap_pronto_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE zap_pronto_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE zap_pronto_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

DO $$
DECLARE
  member_role text;
  granted_role text;
BEGIN
  FOREACH member_role IN ARRAY ARRAY['zap_pronto_app', 'zap_pronto_api', 'zap_pronto_worker']
  LOOP
    FOR granted_role IN
      SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = member_role
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, member_role);
    END LOOP;
  END LOOP;
END
$$;

DO $$
DECLARE
  component_role text;
  existing_member text;
BEGIN
  FOREACH component_role IN ARRAY ARRAY['zap_pronto_app', 'zap_pronto_api', 'zap_pronto_worker']
  LOOP
    FOR existing_member IN
      SELECT member.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE parent.rolname = component_role
    LOOP
      EXECUTE format('REVOKE %I FROM %I', component_role, existing_member);
    END LOOP;
  END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM zap_pronto_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM zap_pronto_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM zap_pronto_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM zap_pronto_app;

GRANT USAGE ON SCHEMA public TO zap_pronto_api, zap_pronto_worker;

GRANT SELECT ON
  tenants, units, users, user_units, channel_connections, channel_connection_units,
  contacts, contact_identities, conversations, service_cases, messages,
  message_attachments, human_handoffs, catalog_items, price_lists,
  price_list_versions, prices, outbox_events, audit_events
TO zap_pronto_api;

GRANT INSERT, UPDATE ON
  units, users, user_units, channel_connections, channel_connection_units, contacts,
  contact_identities, conversations, service_cases, message_attachments,
  human_handoffs, catalog_items, price_lists, price_list_versions, prices
TO zap_pronto_api;
GRANT INSERT ON messages, outbox_events, audit_events TO zap_pronto_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zap_pronto_api;

GRANT SELECT ON
  tenants, units, channel_connections, channel_connection_units, contacts,
  contact_identities, conversations, service_cases, messages,
  message_attachments, human_handoffs, outbox_events
TO zap_pronto_worker;
GRANT UPDATE ON outbox_events TO zap_pronto_worker;
GRANT INSERT ON audit_events TO zap_pronto_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zap_pronto_worker;

GRANT EXECUTE ON FUNCTION current_app_tenant_id() TO zap_pronto_api, zap_pronto_worker;
GRANT EXECUTE ON FUNCTION current_app_actor_id() TO zap_pronto_api, zap_pronto_worker;
GRANT EXECUTE ON FUNCTION assert_app_context_authorized() TO zap_pronto_api, zap_pronto_worker;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON schema_migrations FROM zap_pronto_api, zap_pronto_worker;
  END IF;
END
$$;

COMMIT;
