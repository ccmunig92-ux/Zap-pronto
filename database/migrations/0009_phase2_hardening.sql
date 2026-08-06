BEGIN;

CREATE FUNCTION current_actor_has_unit_access(target_tenant uuid, target_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
SET row_security=off
AS $$ SELECT target_tenant=current_app_tenant_id() AND EXISTS (
  SELECT 1 FROM public.user_units membership WHERE membership.tenant_id=target_tenant
    AND membership.unit_id=target_unit AND membership.user_id=current_app_actor_id()) $$;
REVOKE ALL ON FUNCTION current_actor_has_unit_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_actor_has_unit_access(uuid,uuid) TO zap_pronto_api;
GRANT EXECUTE ON FUNCTION current_actor_has_unit_access(uuid,uuid) TO zap_pronto_quote_event_executor;
GRANT SELECT ON quotes TO zap_pronto_quote_event_executor;

DROP POLICY tenant_isolation ON price_lists;
CREATE POLICY tenant_unit_isolation ON price_lists
USING (current_actor_has_unit_access(tenant_id,unit_id))
WITH CHECK (current_actor_has_unit_access(tenant_id,unit_id));

DROP POLICY tenant_isolation ON price_list_versions;
CREATE POLICY tenant_unit_isolation ON price_list_versions
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM price_lists list
  WHERE list.tenant_id=price_list_versions.tenant_id AND list.id=price_list_versions.price_list_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM price_lists list
  WHERE list.tenant_id=price_list_versions.tenant_id AND list.id=price_list_versions.price_list_id));

DROP POLICY tenant_isolation ON prices;
CREATE POLICY tenant_unit_isolation ON prices
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM price_list_versions version
  JOIN price_lists list ON list.tenant_id=version.tenant_id AND list.id=version.price_list_id
  WHERE version.tenant_id=prices.tenant_id AND version.id=prices.price_list_version_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM price_list_versions version
  JOIN price_lists list ON list.tenant_id=version.tenant_id AND list.id=version.price_list_id
  WHERE version.tenant_id=prices.tenant_id AND version.id=prices.price_list_version_id));

DROP POLICY tenant_isolation ON quotes;
CREATE POLICY tenant_unit_isolation ON quotes
USING (current_actor_has_unit_access(tenant_id,unit_id))
WITH CHECK (current_actor_has_unit_access(tenant_id,unit_id));

DROP POLICY tenant_isolation ON quote_items;
CREATE POLICY tenant_unit_isolation ON quote_items
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM quotes quote
  WHERE quote.tenant_id=quote_items.tenant_id AND quote.id=quote_items.quote_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM quotes quote
  WHERE quote.tenant_id=quote_items.tenant_id AND quote.id=quote_items.quote_id));

DROP POLICY tenant_isolation ON quote_events;
CREATE POLICY tenant_unit_isolation ON quote_events
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM quotes quote
  WHERE quote.tenant_id=quote_events.tenant_id AND quote.id=quote_events.quote_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM quotes quote
  WHERE quote.tenant_id=quote_events.tenant_id AND quote.id=quote_events.quote_id));

DROP POLICY tenant_unit_isolation ON medical_orders;
CREATE POLICY tenant_unit_isolation ON medical_orders
USING (current_actor_has_unit_access(tenant_id,unit_id))
WITH CHECK (current_actor_has_unit_access(tenant_id,unit_id));

DROP POLICY tenant_unit_isolation ON medical_order_pages;
CREATE POLICY tenant_unit_isolation ON medical_order_pages
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id));

DROP POLICY tenant_unit_isolation ON medical_order_items;
CREATE POLICY tenant_unit_isolation ON medical_order_items
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id));

DROP POLICY tenant_unit_isolation ON medical_order_review_events;
CREATE POLICY tenant_unit_isolation ON medical_order_review_events
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id));

COMMIT;
