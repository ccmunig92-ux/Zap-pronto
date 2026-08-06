import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationDeniedError, requirePermission } from "./authorize.js";

test("permission policy is delegated to the canonical database function", async () => {
  const calls: unknown[][] = [];
  await requirePermission({ async query(_text, values) { calls.push(values ?? []); return { rows: [{ allowed: true }] }; } },
    "medical_order.review", "10000000-0000-4000-8000-000000000001");
  assert.deepEqual(calls, [["medical_order.review", "10000000-0000-4000-8000-000000000001"]]);
  await assert.rejects(requirePermission({ async query() { return { rows: [{ allowed: false }] }; } },
    "medical_order.review"), AuthorizationDeniedError);
});
