import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sql = readFileSync(new URL("../../database/migrations/0001_core.sql", import.meta.url), "utf8");
const tables = ["units","users","user_units","channel_connections","channel_connection_units","contacts","contact_identities","conversations","service_cases","messages","message_attachments","human_handoffs","catalog_items","price_lists","price_list_versions","prices","outbox_events","audit_events"];

function definition(table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE ${table} \\(([^;]+)\\);`));
  assert.ok(match?.[1], `TABLE_NOT_FOUND:${table}`);
  return match[1];
}

test("tabelas operacionais possuem tenant_id", () => {
  for (const table of tables) assert.match(definition(table), /tenant_id uuid NOT NULL/);
});

test("entidades centrais impedem referências cross-tenant", () => {
  for (const table of ["conversations","service_cases","messages","human_handoffs","prices"])
    assert.match(definition(table), /FOREIGN KEY\(tenant_id,/);
});

test("preços usam versão, centavos positivos e BRL", () => {
  const prices = definition("prices");
  assert.match(prices, /price_list_version_id uuid NOT NULL/);
  assert.match(prices, /amount_minor bigint NOT NULL CHECK\(amount_minor>0\)/);
  assert.match(prices, /CHECK\(currency='BRL'\)/);
});

test("mensagens e handoffs possuem idempotência", () => {
  assert.match(definition("messages"), /UNIQUE\(tenant_id,conversation_id,external_message_id\)/);
  assert.match(definition("human_handoffs"), /UNIQUE\(tenant_id,idempotency_key\)/);
});
