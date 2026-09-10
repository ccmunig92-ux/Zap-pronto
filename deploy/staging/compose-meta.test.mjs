import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const base = await readFile(new URL("./compose.yaml", import.meta.url), "utf8");
const meta = await readFile(new URL("./compose.meta.yaml", import.meta.url), "utf8");

test("base staging disables Meta without requiring placeholder secrets", () => {
  assert.match(base, /META_WEBHOOK_ENABLED: "false"/);
  assert.match(base, /OUTBOUND_WORKER_ENABLED: "false"/);
  assert.doesNotMatch(base, /META_APP_SECRET_FILE|META_VERIFY_TOKEN_FILE|META_WHATSAPP_SECRET_ROOT/);
  assert.doesNotMatch(base, /^  meta_(?:app_secret|verify_token):/m);
});

test("Meta override fails closed on real external secret paths", () => {
  assert.match(meta, /META_WEBHOOK_ENABLED: "true"/);
  assert.match(meta, /OUTBOUND_WORKER_ENABLED: "true"/);
  assert.match(meta, /META_APP_SECRET_FILE:\?META_APP_SECRET_FILE must be outside the repository/);
  assert.match(meta, /META_VERIFY_TOKEN_FILE:\?META_VERIFY_TOKEN_FILE must be outside the repository/);
  assert.match(meta, /META_WHATSAPP_SECRET_ROOT:\?META_WHATSAPP_SECRET_ROOT must point to an external secret directory/);
});
