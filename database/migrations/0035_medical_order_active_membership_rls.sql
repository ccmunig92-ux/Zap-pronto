BEGIN;

-- Revoked memberships remain as historical rows after 0034. Recreate every
-- medical-order policy so that historical membership can never authorize IO.
DROP POLICY tenant_unit_isolation ON medical_orders;
CREATE POLICY tenant_unit_isolation ON medical_orders
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM user_units membership
  WHERE membership.tenant_id=medical_orders.tenant_id AND membership.unit_id=medical_orders.unit_id
    AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM user_units membership
  WHERE membership.tenant_id=medical_orders.tenant_id AND membership.unit_id=medical_orders.unit_id
    AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'));

DROP POLICY tenant_unit_isolation ON medical_order_pages;
CREATE POLICY tenant_unit_isolation ON medical_order_pages
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_pages.tenant_id AND medical.id=medical_order_pages.medical_order_id));

DROP POLICY tenant_unit_isolation ON medical_order_items;
CREATE POLICY tenant_unit_isolation ON medical_order_items
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_items.tenant_id AND medical.id=medical_order_items.medical_order_id));

DROP POLICY tenant_unit_isolation ON medical_order_review_events;
CREATE POLICY tenant_unit_isolation ON medical_order_review_events
USING (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id))
WITH CHECK (tenant_id=current_app_tenant_id() AND EXISTS (SELECT 1 FROM medical_orders medical JOIN user_units membership
  ON membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE'
  WHERE medical.tenant_id=medical_order_review_events.tenant_id AND medical.id=medical_order_review_events.medical_order_id));

COMMIT;
