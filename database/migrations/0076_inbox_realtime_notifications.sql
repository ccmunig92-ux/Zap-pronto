BEGIN;

/*
 * The payload contains identifiers only.  Authorization remains in the API
 * transaction and the API filters by the resolved tenant and requested unit;
 * no patient/contact content is ever published through NOTIFY.
 */
CREATE OR REPLACE FUNCTION notify_inbox_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  changed_tenant uuid;
  changed_unit uuid;
  changed_entity uuid;
BEGIN
  changed_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  changed_entity := COALESCE(NEW.id, OLD.id);
  IF TG_TABLE_NAME = 'conversations' THEN
    changed_unit := COALESCE(NEW.unit_id, OLD.unit_id);
  ELSIF TG_TABLE_NAME = 'human_handoffs' THEN
    changed_unit := COALESCE(NEW.unit_id, OLD.unit_id);
  ELSIF TG_TABLE_NAME = 'messages' THEN
    SELECT c.unit_id INTO changed_unit
      FROM public.conversations c
     WHERE c.tenant_id = changed_tenant
       AND c.id = COALESCE(NEW.conversation_id, OLD.conversation_id);
  END IF;
  IF changed_tenant IS NOT NULL AND changed_unit IS NOT NULL THEN
    PERFORM pg_notify('zap_pronto_inbox', json_build_object(
      'tenantId', changed_tenant, 'unitId', changed_unit,
      'kind', TG_TABLE_NAME, 'entityId', changed_entity
    )::text);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS conversations_inbox_realtime_notify ON conversations;
CREATE TRIGGER conversations_inbox_realtime_notify
AFTER INSERT OR UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION notify_inbox_change();

DROP TRIGGER IF EXISTS messages_inbox_realtime_notify ON messages;
CREATE TRIGGER messages_inbox_realtime_notify
AFTER INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION notify_inbox_change();

DROP TRIGGER IF EXISTS human_handoffs_inbox_realtime_notify ON human_handoffs;
CREATE TRIGGER human_handoffs_inbox_realtime_notify
AFTER INSERT OR UPDATE ON human_handoffs
FOR EACH ROW EXECUTE FUNCTION notify_inbox_change();

REVOKE ALL ON FUNCTION notify_inbox_change() FROM PUBLIC;

COMMIT;
