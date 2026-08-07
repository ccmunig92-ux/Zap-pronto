BEGIN;

CREATE TYPE price_version_status AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE quote_status AS ENUM (
  'DRAFT', 'REVIEW_REQUIRED', 'READY', 'SENT',
  'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'
);

UPDATE price_list_versions SET status = 'PUBLISHED' WHERE status = 'ACTIVE';
ALTER TABLE price_list_versions ALTER COLUMN status DROP DEFAULT;
ALTER TABLE price_list_versions
  ALTER COLUMN status TYPE price_version_status USING status::price_version_status,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN retired_at timestamptz;
UPDATE price_list_versions SET published_at = effective_at WHERE status = 'PUBLISHED';
ALTER TABLE price_list_versions
  ADD CONSTRAINT price_list_versions_state_consistency CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'PUBLISHED' AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'RETIRED' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  );
CREATE UNIQUE INDEX price_list_versions_one_published
  ON price_list_versions (tenant_id, price_list_id) WHERE status = 'PUBLISHED';
ALTER TABLE price_lists ADD CONSTRAINT price_lists_tenant_id_id_unit_id_unique
  UNIQUE (tenant_id, id, unit_id);
ALTER TABLE price_list_versions ADD CONSTRAINT price_list_versions_tenant_id_id_price_list_id_unique
  UNIQUE (tenant_id, id, price_list_id);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  service_case_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  price_list_version_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  supersedes_quote_id uuid,
  status quote_status NOT NULL DEFAULT 'DRAFT',
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor bigint NOT NULL DEFAULT 0,
  valid_until timestamptz NOT NULL,
  prepared_by_user_id uuid NOT NULL,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, price_list_version_id),
  UNIQUE (tenant_id, service_case_id, revision),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, service_case_id, conversation_id, unit_id)
    REFERENCES service_cases (tenant_id, id, conversation_id, unit_id),
  FOREIGN KEY (tenant_id, price_list_id, unit_id)
    REFERENCES price_lists (tenant_id, id, unit_id),
  FOREIGN KEY (tenant_id, price_list_version_id, price_list_id)
    REFERENCES price_list_versions (tenant_id, id, price_list_id),
  FOREIGN KEY (tenant_id, prepared_by_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_quote_id) REFERENCES quotes (tenant_id, id),
  CONSTRAINT quotes_total_valid CHECK (
    discount_minor <= subtotal_minor AND total_minor >= 0 AND total_minor = subtotal_minor - discount_minor
  ),
  CONSTRAINT quotes_validity_valid CHECK (valid_until > created_at),
  CONSTRAINT quotes_review_consistency CHECK (
    (reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT quotes_state_timestamps CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL AND accepted_at IS NULL
      AND declined_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'ACCEPTED' AND sent_at IS NOT NULL AND accepted_at IS NOT NULL
      AND declined_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'DECLINED' AND sent_at IS NOT NULL AND accepted_at IS NULL
      AND declined_at IS NOT NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'EXPIRED' AND sent_at IS NOT NULL AND accepted_at IS NULL
      AND declined_at IS NULL AND expired_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND accepted_at IS NULL AND declined_at IS NULL
      AND expired_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status IN ('DRAFT', 'REVIEW_REQUIRED', 'READY') AND sent_at IS NULL
      AND accepted_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
  )
);

CREATE TABLE quote_items (
  tenant_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  catalog_item_id uuid NOT NULL,
  price_list_version_id uuid NOT NULL,
  catalog_code_snapshot text NOT NULL,
  description_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor > 0 AND line_total_minor = unit_price_minor * quantity),
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  price_effective_at timestamptz NOT NULL,
  price_source text NOT NULL DEFAULT 'PLATFORM' CHECK (price_source IN ('PLATFORM', 'EXTERNAL_SNAPSHOT')),
  PRIMARY KEY (tenant_id, quote_id, line_number),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id, price_list_version_id)
    REFERENCES quotes (tenant_id, id, price_list_version_id),
  FOREIGN KEY (tenant_id, catalog_item_id) REFERENCES catalog_items (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_version_id) REFERENCES price_list_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_version_id, catalog_item_id)
    REFERENCES prices (tenant_id, price_list_version_id, catalog_item_id)
);

CREATE TABLE quote_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  quote_id uuid NOT NULL,
  from_status quote_status,
  to_status quote_status NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users (tenant_id, id)
  ,UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX quotes_case_timeline_idx
  ON quotes (tenant_id, service_case_id, revision DESC);
CREATE INDEX quote_events_timeline_idx
  ON quote_events (tenant_id, quote_id, occurred_at, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zap_pronto_quote_event_executor') THEN
    CREATE ROLE zap_pronto_quote_event_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE zap_pronto_quote_event_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
DO $$
DECLARE related_role text;
BEGIN
  FOR related_role IN
    SELECT parent.rolname FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid
    WHERE member.rolname = 'zap_pronto_quote_event_executor'
  LOOP EXECUTE format('REVOKE %I FROM zap_pronto_quote_event_executor', related_role); END LOOP;
  FOR related_role IN
    SELECT member.rolname FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles parent ON parent.oid = membership.roleid
    WHERE parent.rolname = 'zap_pronto_quote_event_executor'
  LOOP EXECUTE format('REVOKE zap_pronto_quote_event_executor FROM %I', related_role); END LOOP;
END
$$;
GRANT USAGE ON SCHEMA public TO zap_pronto_quote_event_executor;
GRANT INSERT ON quote_events, outbox_events TO zap_pronto_quote_event_executor;
GRANT USAGE, SELECT ON SEQUENCE quote_events_id_seq TO zap_pronto_quote_event_executor;
GRANT EXECUTE ON FUNCTION current_app_tenant_id() TO zap_pronto_quote_event_executor;
GRANT EXECUTE ON FUNCTION current_app_actor_id() TO zap_pronto_quote_event_executor;

CREATE FUNCTION capture_quote_transition() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_setting text;
  correlation_setting text;
BEGIN
  actor_setting := current_setting('app.actor_id', true);
  correlation_setting := current_setting('app.correlation_id', true);
  IF actor_setting IS NULL OR actor_setting = '' THEN RETURN NEW; END IF;

  INSERT INTO public.quote_events
    (tenant_id, quote_id, from_status, to_status, reason, actor_id, correlation_id, idempotency_key)
  VALUES (NEW.tenant_id, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status, 'STATE_TRANSITION', actor_setting::uuid, correlation_setting,
    'quote.transition:' || NEW.id::text || ':' || NEW.version::text || ':' || NEW.status::text);

  IF NEW.status IN ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED') THEN
    INSERT INTO public.outbox_events
      (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
    VALUES (NEW.tenant_id, 'quote', NEW.id, 'quote.' || lower(NEW.status::text),
      jsonb_build_object('quoteId', NEW.id, 'status', NEW.status),
      'quote.' || lower(NEW.status::text) || ':' || NEW.id::text);
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION capture_quote_transition() OWNER TO zap_pronto_quote_event_executor;
REVOKE ALL ON FUNCTION capture_quote_transition() FROM PUBLIC;
CREATE TRIGGER quotes_insert_capture
  AFTER INSERT ON quotes FOR EACH ROW EXECUTE FUNCTION capture_quote_transition();
CREATE TRIGGER quotes_transition_capture
  AFTER UPDATE OF status ON quotes FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION capture_quote_transition();

CREATE FUNCTION enforce_quote_and_price_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  price_parent_status price_version_status;
  quote_parent_status quote_status;
  calculated_subtotal bigint;
  quote_item_count integer;
BEGIN
  IF TG_TABLE_NAME = 'price_list_versions' THEN
    IF OLD.status IN ('PUBLISHED', 'RETIRED')
      AND (NEW.tenant_id, NEW.price_list_id, NEW.version, NEW.effective_at, NEW.published_at)
        IS DISTINCT FROM
          (OLD.tenant_id, OLD.price_list_id, OLD.version, OLD.effective_at, OLD.published_at) THEN
      RAISE EXCEPTION 'PUBLISHED_PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      IF OLD.status <> 'DRAFT' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'PUBLISHED_PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
      RAISE EXCEPTION 'INVALID_PRICE_VERSION_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('price-list:' || NEW.price_list_id::text, 0));
      IF NOT EXISTS (
        SELECT 1 FROM public.prices price
        WHERE price.tenant_id = NEW.tenant_id AND price.price_list_version_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'PRICE_VERSION_EMPTY' USING ERRCODE = '23514';
      END IF;
      UPDATE public.price_list_versions version
      SET status = 'RETIRED', retired_at = clock_timestamp()
      WHERE version.tenant_id = NEW.tenant_id AND version.price_list_id = NEW.price_list_id
        AND version.id <> NEW.id AND version.status = 'PUBLISHED';
      NEW.published_at := clock_timestamp();
      NEW.retired_at := NULL;
    ELSIF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED' THEN
      NEW.retired_at := COALESCE(NEW.retired_at, clock_timestamp());
    END IF;
  ELSIF TG_TABLE_NAME = 'prices' THEN
    SELECT status INTO price_parent_status FROM public.price_list_versions
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.price_list_version_id, OLD.price_list_version_id);
    IF price_parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_PRICES_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'quotes' THEN
    IF TG_OP = 'INSERT' THEN
      IF current_user = 'zap_pronto_api' AND (
        NEW.status <> 'DRAFT' OR NEW.version <> 1 OR NEW.subtotal_minor <> 0
        OR NEW.discount_minor <> 0 OR NEW.total_minor <> 0
        OR NEW.prepared_by_user_id <> current_app_actor_id()
        OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
        OR NEW.sent_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.declined_at IS NOT NULL
        OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'INVALID_QUOTE_INSERT' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF (NEW.tenant_id, NEW.service_case_id, NEW.conversation_id, NEW.unit_id,
        NEW.price_list_id, NEW.price_list_version_id, NEW.revision, NEW.supersedes_quote_id,
        NEW.currency, NEW.valid_until, NEW.prepared_by_user_id, NEW.idempotency_key, NEW.request_fingerprint)
      IS DISTINCT FROM
       (OLD.tenant_id, OLD.service_case_id, OLD.conversation_id, OLD.unit_id,
        OLD.price_list_id, OLD.price_list_version_id, OLD.revision, OLD.supersedes_quote_id,
        OLD.currency, OLD.valid_until, OLD.prepared_by_user_id, OLD.idempotency_key, OLD.request_fingerprint) THEN
      RAISE EXCEPTION 'QUOTE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'QUOTE_VERSION_INCREMENT_REQUIRED' USING ERRCODE = '23514';
    ELSIF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'QUOTE_VERSION_CHANGE_WITHOUT_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('REVIEW_REQUIRED', 'READY', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED')
      AND (NEW.tenant_id, NEW.service_case_id, NEW.conversation_id, NEW.unit_id,
           NEW.price_list_id, NEW.price_list_version_id, NEW.revision, NEW.supersedes_quote_id,
           NEW.currency, NEW.subtotal_minor, NEW.discount_minor, NEW.total_minor, NEW.valid_until,
           NEW.prepared_by_user_id, NEW.idempotency_key, NEW.request_fingerprint)
        IS DISTINCT FROM
          (OLD.tenant_id, OLD.service_case_id, OLD.conversation_id, OLD.unit_id,
           OLD.price_list_id, OLD.price_list_version_id, OLD.revision, OLD.supersedes_quote_id,
           OLD.currency, OLD.subtotal_minor, OLD.discount_minor, OLD.total_minor, OLD.valid_until,
           OLD.prepared_by_user_id, OLD.idempotency_key, OLD.request_fingerprint) THEN
      RAISE EXCEPTION 'READY_QUOTE_COMMERCIAL_DATA_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      IF OLD.status IN ('READY', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'SENT_QUOTE_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('REVIEW_REQUIRED', 'READY', 'CANCELLED'))
      OR (OLD.status = 'REVIEW_REQUIRED' AND NEW.status IN ('READY', 'CANCELLED'))
      OR (OLD.status = 'READY' AND NEW.status IN ('SENT', 'CANCELLED'))
      OR (OLD.status = 'SENT' AND NEW.status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'INVALID_QUOTE_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('REVIEW_REQUIRED', 'READY') THEN
      SELECT count(*)::integer, COALESCE(sum(line_total_minor), 0)
      INTO quote_item_count, calculated_subtotal
      FROM public.quote_items WHERE tenant_id = NEW.tenant_id AND quote_id = NEW.id;
      IF quote_item_count = 0 OR calculated_subtotal <> NEW.subtotal_minor THEN
        RAISE EXCEPTION 'QUOTE_TOTAL_MISMATCH' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF OLD.status = 'REVIEW_REQUIRED' AND NEW.status = 'READY'
      AND (NEW.reviewed_by_user_id <> current_app_actor_id() OR NEW.reviewed_at IS NULL) THEN
      RAISE EXCEPTION 'QUOTE_REVIEW_ACTOR_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'READY'
      AND (NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'UNEXPECTED_QUOTE_REVIEW' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SENT' AND NEW.valid_until <= clock_timestamp() THEN
      RAISE EXCEPTION 'QUOTE_ALREADY_EXPIRED' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ACCEPTED' AND OLD.valid_until <= clock_timestamp() THEN
      RAISE EXCEPTION 'QUOTE_ALREADY_EXPIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'quote_items' THEN
    SELECT quote.status INTO quote_parent_status FROM public.quotes quote
    WHERE quote.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND quote.id = COALESCE(NEW.quote_id, OLD.quote_id);
    IF quote_parent_status NOT IN ('DRAFT', 'REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'QUOTE_ITEMS_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF TG_OP <> 'DELETE' AND current_user = 'zap_pronto_api'
      AND NEW.tenant_id = current_app_tenant_id() AND NOT EXISTS (
      SELECT 1 FROM public.prices price
      JOIN public.catalog_items item ON item.tenant_id = price.tenant_id AND item.id = price.catalog_item_id
      JOIN public.price_list_versions version ON version.tenant_id = price.tenant_id
        AND version.id = price.price_list_version_id
      WHERE price.tenant_id = NEW.tenant_id
        AND price.price_list_version_id = NEW.price_list_version_id
        AND price.catalog_item_id = NEW.catalog_item_id
        AND item.code = NEW.catalog_code_snapshot
        AND item.name = NEW.description_snapshot
        AND price.amount_minor = NEW.unit_price_minor
        AND price.currency = NEW.currency
        AND version.effective_at = NEW.price_effective_at
    ) THEN
      RAISE EXCEPTION 'QUOTE_ITEM_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION enforce_quote_and_price_integrity() FROM PUBLIC;
CREATE TRIGGER price_list_versions_integrity_guard
  BEFORE UPDATE ON price_list_versions FOR EACH ROW EXECUTE FUNCTION enforce_quote_and_price_integrity();
CREATE TRIGGER prices_integrity_guard
  BEFORE INSERT OR UPDATE OR DELETE ON prices FOR EACH ROW EXECUTE FUNCTION enforce_quote_and_price_integrity();
CREATE TRIGGER quotes_integrity_guard
  BEFORE INSERT OR UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION enforce_quote_and_price_integrity();
CREATE TRIGGER quote_items_integrity_guard
  BEFORE INSERT OR UPDATE OR DELETE ON quote_items FOR EACH ROW EXECUTE FUNCTION enforce_quote_and_price_integrity();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['quotes', 'quote_items', 'quote_events']
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

GRANT SELECT ON quotes, quote_items, quote_events TO zap_pronto_api;
GRANT INSERT, UPDATE ON quotes TO zap_pronto_api;
GRANT INSERT ON quote_items TO zap_pronto_api;

COMMIT;
