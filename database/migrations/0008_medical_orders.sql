BEGIN;

CREATE TYPE medical_order_status AS ENUM (
  'RECEIVED', 'PROCESSING', 'REVIEW_REQUIRED', 'REVIEWED', 'UNREADABLE', 'FAILED'
);
CREATE TYPE medical_order_page_status AS ENUM ('PENDING', 'OCR_COMPLETED', 'UNREADABLE', 'FAILED');
CREATE TYPE medical_order_item_status AS ENUM ('EXTRACTED', 'MATCH_SUGGESTED', 'CONFIRMED', 'REJECTED');

ALTER TABLE messages ADD CONSTRAINT messages_tenant_id_id_conversation_id_unique
  UNIQUE (tenant_id, id, conversation_id);
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_tenant_id_id_message_id_unique
  UNIQUE (tenant_id, id, message_id);
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_tenant_id_id_unique
  UNIQUE (tenant_id, id);

CREATE TABLE medical_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_attachment_id uuid NOT NULL,
  document_sha256 char(64) NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  status medical_order_status NOT NULL DEFAULT 'RECEIVED',
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 100),
  processing_provider text,
  processing_model text,
  processing_version text,
  overall_confidence numeric(5,4) CHECK (overall_confidence BETWEEN 0 AND 1),
  extraction_fingerprint char(64) CHECK (extraction_fingerprint IS NULL OR extraction_fingerprint ~ '^[0-9a-f]{64}$'),
  extraction_idempotency_key text,
  confidence_threshold numeric(5,4) CHECK (confidence_threshold BETWEEN 0 AND 1),
  confidence_policy_version text,
  review_required boolean NOT NULL DEFAULT true CHECK (review_required),
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  failure_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, service_case_id),
  UNIQUE (tenant_id, service_case_id, document_sha256),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, service_case_id, conversation_id, unit_id)
    REFERENCES service_cases (tenant_id, id, conversation_id, unit_id),
  FOREIGN KEY (tenant_id, message_id, conversation_id)
    REFERENCES messages (tenant_id, id, conversation_id),
  FOREIGN KEY (tenant_id, message_attachment_id, message_id)
    REFERENCES message_attachments (tenant_id, id, message_id),
  FOREIGN KEY (tenant_id, reviewed_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT medical_orders_review_consistency CHECK (
    (status = 'REVIEWED' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND failure_code IS NULL)
    OR (status <> 'REVIEWED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
  ),
  CONSTRAINT medical_orders_failure_consistency CHECK (
    (status IN ('UNREADABLE', 'FAILED') AND failure_code IS NOT NULL)
    OR (status NOT IN ('UNREADABLE', 'FAILED') AND failure_code IS NULL)
  ),
  CHECK (processing_provider IS NULL OR length(btrim(processing_provider)) BETWEEN 1 AND 100),
  CHECK (processing_model IS NULL OR length(btrim(processing_model)) BETWEEN 1 AND 100),
  CHECK (processing_version IS NULL OR length(btrim(processing_version)) BETWEEN 1 AND 100),
  CHECK (extraction_idempotency_key IS NULL OR length(btrim(extraction_idempotency_key)) BETWEEN 1 AND 200),
  CHECK (confidence_policy_version IS NULL OR length(btrim(confidence_policy_version)) BETWEEN 1 AND 100),
  CHECK (failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 200)
);

CREATE TABLE medical_order_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  medical_order_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number > 0),
  status medical_order_page_status NOT NULL DEFAULT 'PENDING',
  storage_key text,
  ocr_text text,
  ocr_confidence numeric(5,4) CHECK (ocr_confidence BETWEEN 0 AND 1),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, medical_order_id, page_number),
  UNIQUE (tenant_id, id, medical_order_id),
  FOREIGN KEY (tenant_id, medical_order_id) REFERENCES medical_orders (tenant_id, id),
  CONSTRAINT medical_order_pages_state_consistency CHECK (
    (status = 'OCR_COMPLETED' AND ocr_text IS NOT NULL AND ocr_confidence IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('UNREADABLE', 'FAILED') AND failure_code IS NOT NULL)
    OR (status = 'PENDING' AND ocr_text IS NULL AND ocr_confidence IS NULL AND failure_code IS NULL)
  )
);

CREATE TABLE medical_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  medical_order_id uuid NOT NULL,
  page_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  raw_text text NOT NULL CHECK (length(btrim(raw_text)) > 0),
  normalized_text text,
  suggested_catalog_item_id uuid,
  confirmed_catalog_item_id uuid,
  match_confidence numeric(5,4) CHECK (match_confidence BETWEEN 0 AND 1),
  status medical_order_item_status NOT NULL DEFAULT 'EXTRACTED',
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, medical_order_id),
  UNIQUE (tenant_id, medical_order_id, sequence),
  FOREIGN KEY (tenant_id, medical_order_id) REFERENCES medical_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, page_id, medical_order_id)
    REFERENCES medical_order_pages (tenant_id, id, medical_order_id),
  FOREIGN KEY (tenant_id, suggested_catalog_item_id) REFERENCES catalog_items (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_catalog_item_id) REFERENCES catalog_items (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT medical_order_items_state_consistency CHECK (
    (status = 'EXTRACTED' AND suggested_catalog_item_id IS NULL AND confirmed_catalog_item_id IS NULL
      AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL)
    OR (status = 'MATCH_SUGGESTED' AND suggested_catalog_item_id IS NOT NULL
      AND match_confidence IS NOT NULL AND confirmed_catalog_item_id IS NULL
      AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL)
    OR (status = 'CONFIRMED' AND confirmed_catalog_item_id IS NOT NULL
      AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NULL)
    OR (status = 'REJECTED' AND reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL)
  )
);

CREATE TABLE medical_order_review_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  medical_order_id uuid NOT NULL,
  medical_order_item_id uuid,
  action text NOT NULL CHECK (action IN ('CONFIRMED', 'CORRECTED', 'REJECTED', 'MARKED_UNREADABLE', 'REVIEW_COMPLETED')),
  actor_id uuid NOT NULL,
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, medical_order_id) REFERENCES medical_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, medical_order_item_id, medical_order_id)
    REFERENCES medical_order_items (tenant_id, id, medical_order_id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((action IN ('CONFIRMED','CORRECTED','REJECTED') AND medical_order_item_id IS NOT NULL)
    OR (action IN ('MARKED_UNREADABLE','REVIEW_COMPLETED') AND medical_order_item_id IS NULL)),
  CHECK (length(btrim(correlation_id)) BETWEEN 1 AND 200),
  CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX medical_orders_review_queue_idx
  ON medical_orders (tenant_id, unit_id, status, updated_at, id);
CREATE INDEX medical_order_pages_order_idx
  ON medical_order_pages (tenant_id, medical_order_id, page_number);
CREATE INDEX medical_order_items_review_idx
  ON medical_order_items (tenant_id, medical_order_id, status, sequence);
CREATE INDEX medical_order_review_events_timeline_idx
  ON medical_order_review_events (tenant_id, medical_order_id, occurred_at, id);

CREATE FUNCTION enforce_medical_order_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE pending_items integer; total_items integer;
BEGIN
  IF TG_TABLE_NAME = 'medical_orders' THEN
    IF TG_OP = 'INSERT' THEN
      IF current_user = 'zap_pronto_api' AND (NEW.status <> 'RECEIVED' OR NEW.version <> 1
        OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
        OR NEW.overall_confidence IS NOT NULL OR NEW.failure_code IS NOT NULL
        OR NEW.processing_provider IS NOT NULL OR NEW.processing_model IS NOT NULL
        OR NEW.processing_version IS NOT NULL OR NEW.extraction_fingerprint IS NOT NULL
        OR NEW.extraction_idempotency_key IS NOT NULL OR NEW.confidence_threshold IS NOT NULL
        OR NEW.confidence_policy_version IS NOT NULL) THEN
        RAISE EXCEPTION 'INVALID_MEDICAL_ORDER_INSERT' USING ERRCODE = '23514';
      END IF;
      IF current_user = 'zap_pronto_api' AND NEW.tenant_id = current_app_tenant_id() AND NOT EXISTS (
        SELECT 1 FROM public.messages message
        JOIN public.message_attachments attachment ON attachment.tenant_id=message.tenant_id
          AND attachment.message_id=message.id
        JOIN public.service_cases service_case ON service_case.tenant_id=message.tenant_id
          AND service_case.id=NEW.service_case_id AND service_case.conversation_id=message.conversation_id
        WHERE message.tenant_id = NEW.tenant_id AND message.id=NEW.message_id
          AND message.conversation_id=NEW.conversation_id AND message.direction='INBOUND'
          AND message.actor='CUSTOMER' AND service_case.kind='MEDICAL_ORDER'
          AND attachment.id = NEW.message_attachment_id
          AND attachment.message_id = NEW.message_id AND attachment.sha256 = NEW.document_sha256
          AND attachment.media_type IN ('IMAGE', 'DOCUMENT')
      ) THEN RAISE EXCEPTION 'MEDICAL_ORDER_SOURCE_INVALID' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END IF;
    IF
      (NEW.processing_provider, NEW.processing_model, NEW.processing_version, NEW.overall_confidence,
       NEW.extraction_fingerprint, NEW.extraction_idempotency_key, NEW.confidence_threshold,
       NEW.confidence_policy_version) IS DISTINCT FROM
      (OLD.processing_provider, OLD.processing_model, OLD.processing_version, OLD.overall_confidence,
       OLD.extraction_fingerprint, OLD.extraction_idempotency_key, OLD.confidence_threshold,
       OLD.confidence_policy_version)
      AND NOT (OLD.status='PROCESSING' AND NEW.status='REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_EXTRACTION_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF (NEW.tenant_id, NEW.service_case_id, NEW.conversation_id, NEW.unit_id,
        NEW.message_id, NEW.message_attachment_id, NEW.document_sha256, NEW.page_count,
        NEW.idempotency_key, NEW.created_at)
      IS DISTINCT FROM
       (OLD.tenant_id, OLD.service_case_id, OLD.conversation_id, OLD.unit_id,
        OLD.message_id, OLD.message_attachment_id, OLD.document_sha256, OLD.page_count,
        OLD.idempotency_key, OLD.created_at) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_VERSION_INCREMENT_REQUIRED' USING ERRCODE = '23514';
    ELSIF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_VERSION_CHANGE_WITHOUT_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'RECEIVED' AND NEW.status IN ('PROCESSING', 'UNREADABLE', 'FAILED'))
      OR (OLD.status = 'PROCESSING' AND NEW.status IN ('REVIEW_REQUIRED', 'UNREADABLE', 'FAILED'))
      OR (OLD.status = 'REVIEW_REQUIRED' AND NEW.status IN ('REVIEWED', 'UNREADABLE'))
    ) THEN RAISE EXCEPTION 'INVALID_MEDICAL_ORDER_TRANSITION' USING ERRCODE = '23514'; END IF;
    IF NEW.status = 'REVIEWED' THEN
      SELECT count(*)::integer,
        count(*) FILTER (WHERE item.status NOT IN ('CONFIRMED', 'REJECTED'))::integer
      INTO total_items, pending_items FROM public.medical_order_items item
      WHERE item.tenant_id = NEW.tenant_id AND item.medical_order_id = NEW.id
      ;
      IF total_items = 0 OR pending_items > 0 THEN
        RAISE EXCEPTION 'MEDICAL_ORDER_ITEMS_PENDING' USING ERRCODE = '23514';
      END IF;
      IF NEW.reviewed_by_user_id <> current_app_actor_id() THEN
        RAISE EXCEPTION 'HUMAN_REVIEW_ACTOR_REQUIRED' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.user_units membership
        WHERE membership.tenant_id=NEW.tenant_id AND membership.unit_id=NEW.unit_id
          AND membership.user_id=current_app_actor_id()) THEN
        RAISE EXCEPTION 'MEDICAL_ORDER_REVIEWER_UNIT_FORBIDDEN' USING ERRCODE='42501';
      END IF;
    END IF;
    IF NEW.status = 'REVIEW_REQUIRED' AND (
      NEW.overall_confidence IS NULL OR NEW.extraction_fingerprint IS NULL
      OR NEW.extraction_idempotency_key IS NULL OR NEW.confidence_threshold IS NULL
      OR NEW.confidence_policy_version IS NULL OR NEW.processing_provider IS NULL
      OR NEW.processing_model IS NULL OR NEW.processing_version IS NULL
    ) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_EXTRACTION_EVIDENCE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF NEW.status='UNREADABLE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
      SELECT 1 FROM public.user_units membership WHERE membership.tenant_id=NEW.tenant_id
        AND membership.unit_id=NEW.unit_id AND membership.user_id=current_app_actor_id()) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_REVIEWER_UNIT_FORBIDDEN' USING ERRCODE='42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'medical_order_pages' THEN
    IF TG_OP='INSERT' THEN
      IF current_user='zap_pronto_api' AND (NEW.status <> 'PENDING' OR NEW.ocr_text IS NOT NULL
        OR NEW.ocr_confidence IS NOT NULL OR NEW.failure_code IS NOT NULL) THEN
        RAISE EXCEPTION 'INVALID_MEDICAL_ORDER_PAGE_INSERT' USING ERRCODE='23514';
      END IF;
    ELSE
      IF (NEW.tenant_id,NEW.medical_order_id,NEW.page_number,NEW.storage_key,NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id,OLD.medical_order_id,OLD.page_number,OLD.storage_key,OLD.created_at) THEN
        RAISE EXCEPTION 'MEDICAL_ORDER_PAGE_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      IF OLD.status <> 'PENDING' AND (NEW.status,NEW.ocr_text,NEW.ocr_confidence,NEW.failure_code)
        IS DISTINCT FROM (OLD.status,OLD.ocr_text,OLD.ocr_confidence,OLD.failure_code) THEN
        RAISE EXCEPTION 'MEDICAL_ORDER_PAGE_TERMINAL_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT
        (OLD.status='PENDING' AND NEW.status IN ('OCR_COMPLETED','UNREADABLE','FAILED')) THEN
        RAISE EXCEPTION 'INVALID_MEDICAL_ORDER_PAGE_TRANSITION' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'medical_order_items' AND TG_OP = 'INSERT' THEN
    IF current_user = 'zap_pronto_api' AND (NEW.status NOT IN ('EXTRACTED', 'MATCH_SUGGESTED')
      OR NEW.confirmed_catalog_item_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.rejection_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'OCR_CANNOT_CONFIRM_ITEM' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'medical_order_items' AND TG_OP = 'UPDATE' THEN
    IF (NEW.tenant_id, NEW.medical_order_id, NEW.page_id, NEW.sequence, NEW.raw_text)
      IS DISTINCT FROM (OLD.tenant_id, OLD.medical_order_id, OLD.page_id, OLD.sequence, OLD.raw_text) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_ITEM_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status='EXTRACTED' AND NEW.status IN ('MATCH_SUGGESTED','CONFIRMED','REJECTED')) OR
      (OLD.status='MATCH_SUGGESTED' AND NEW.status IN ('CONFIRMED','REJECTED'))) THEN
      RAISE EXCEPTION 'INVALID_MEDICAL_ORDER_ITEM_TRANSITION' USING ERRCODE='23514';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND
      (NEW.normalized_text,NEW.suggested_catalog_item_id,NEW.confirmed_catalog_item_id,NEW.match_confidence,
       NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.rejection_reason) IS DISTINCT FROM
      (OLD.normalized_text,OLD.suggested_catalog_item_id,OLD.confirmed_catalog_item_id,OLD.match_confidence,
       OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.rejection_reason) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_ITEM_CHANGE_REQUIRES_TRANSITION' USING ERRCODE='23514';
    END IF;
    IF NEW.status IN ('CONFIRMED','REJECTED') AND
      (NEW.normalized_text,NEW.suggested_catalog_item_id,NEW.match_confidence) IS DISTINCT FROM
      (OLD.normalized_text,OLD.suggested_catalog_item_id,OLD.match_confidence) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_ITEM_SUGGESTION_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF NEW.status IN ('CONFIRMED', 'REJECTED')
      AND (NEW.reviewed_by_user_id <> current_app_actor_id() OR NEW.reviewed_at IS NULL) THEN
      RAISE EXCEPTION 'HUMAN_REVIEW_ACTOR_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('CONFIRMED', 'REJECTED') AND NOT EXISTS (
      SELECT 1 FROM public.medical_orders medical
      JOIN public.user_units membership ON membership.tenant_id = medical.tenant_id
        AND membership.unit_id = medical.unit_id AND membership.user_id = current_app_actor_id()
      WHERE medical.tenant_id = NEW.tenant_id AND medical.id = NEW.medical_order_id
    ) THEN RAISE EXCEPTION 'MEDICAL_ORDER_REVIEWER_UNIT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  ELSIF TG_TABLE_NAME = 'medical_order_review_events' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'MEDICAL_ORDER_REVIEW_EVENTS_APPEND_ONLY' USING ERRCODE = '23514'; END IF;
    IF current_user = 'zap_pronto_api' AND NEW.tenant_id=current_app_tenant_id()
      AND NEW.actor_id <> current_app_actor_id() THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_REVIEW_ACTOR_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF current_user='zap_pronto_api' AND NEW.tenant_id=current_app_tenant_id()
      AND NEW.medical_order_item_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.medical_order_items item
      WHERE item.tenant_id=NEW.tenant_id AND item.id=NEW.medical_order_item_id
        AND item.medical_order_id=NEW.medical_order_id) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_REVIEW_ITEM_MISMATCH' USING ERRCODE='23514';
    END IF;
    IF current_user='zap_pronto_api' AND current_setting('app.actor_id', true)
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.tenant_id=current_app_tenant_id() AND NOT EXISTS (
      SELECT 1 FROM public.medical_orders medical JOIN public.user_units membership
        ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
          AND membership.user_id=current_setting('app.actor_id', true)::uuid
      WHERE medical.tenant_id=NEW.tenant_id AND medical.id=NEW.medical_order_id) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_REVIEWER_UNIT_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    IF current_user='zap_pronto_api' AND current_setting('app.actor_id', true)
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.tenant_id=current_app_tenant_id() AND NOT EXISTS (
      SELECT 1 FROM public.medical_orders medical LEFT JOIN public.medical_order_items item
        ON item.tenant_id=medical.tenant_id AND item.id=NEW.medical_order_item_id
      WHERE medical.tenant_id=NEW.tenant_id AND medical.id=NEW.medical_order_id AND (
        (NEW.action='CONFIRMED' AND item.status='CONFIRMED') OR
        (NEW.action='CORRECTED' AND item.status='CONFIRMED'
          AND item.confirmed_catalog_item_id IS DISTINCT FROM item.suggested_catalog_item_id) OR
        (NEW.action='REJECTED' AND item.status='REJECTED') OR
        (NEW.action='REVIEW_COMPLETED' AND medical.status='REVIEWED') OR
        (NEW.action='MARKED_UNREADABLE' AND medical.status='UNREADABLE'))) THEN
      RAISE EXCEPTION 'MEDICAL_ORDER_REVIEW_EVENT_STATE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION enforce_medical_order_integrity() FROM PUBLIC;
CREATE TRIGGER medical_orders_integrity_guard
  BEFORE INSERT OR UPDATE ON medical_orders FOR EACH ROW EXECUTE FUNCTION enforce_medical_order_integrity();
CREATE TRIGGER medical_order_pages_integrity_guard
  BEFORE INSERT OR UPDATE ON medical_order_pages FOR EACH ROW EXECUTE FUNCTION enforce_medical_order_integrity();
CREATE TRIGGER medical_order_items_integrity_guard
  BEFORE INSERT OR UPDATE ON medical_order_items FOR EACH ROW EXECUTE FUNCTION enforce_medical_order_integrity();
CREATE TRIGGER medical_order_review_events_integrity_guard
  BEFORE INSERT OR UPDATE OR DELETE ON medical_order_review_events FOR EACH ROW EXECUTE FUNCTION enforce_medical_order_integrity();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'medical_orders', 'medical_order_pages', 'medical_order_items', 'medical_order_review_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

CREATE POLICY tenant_unit_isolation ON medical_orders
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM user_units membership
  WHERE membership.tenant_id=medical_orders.tenant_id AND membership.unit_id=medical_orders.unit_id
    AND membership.user_id=current_app_actor_id()))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM user_units membership
  WHERE membership.tenant_id=medical_orders.tenant_id AND membership.unit_id=medical_orders.unit_id
    AND membership.user_id=current_app_actor_id()));
CREATE POLICY tenant_unit_isolation ON medical_order_pages
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id));
CREATE POLICY tenant_unit_isolation ON medical_order_items
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id));
CREATE POLICY tenant_unit_isolation ON medical_order_review_events
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  JOIN user_units membership ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
    AND membership.user_id=current_app_actor_id()
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id));

GRANT SELECT ON medical_orders, medical_order_pages, medical_order_items, medical_order_review_events TO zap_pronto_api;
GRANT INSERT, UPDATE ON medical_orders, medical_order_pages, medical_order_items TO zap_pronto_api;
GRANT INSERT ON medical_order_review_events TO zap_pronto_api;
GRANT USAGE, SELECT ON SEQUENCE medical_order_review_events_id_seq TO zap_pronto_api;

COMMIT;
