import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationRequired, createApiClient, InvalidApiResponse } from "./client.js";

test("generated client sends only Bearer authentication to GET /v1/me", async () => {
  let request: Request | undefined;
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async (input) => {
      request = input;
      return new Response(JSON.stringify({
        user: { id: "22222222-2222-4222-8222-222222222222", email: "a@b.test", displayName: "A" },
        tenant: { id: "11111111-1111-4111-8111-111111111111", name: "T" }, memberships: [], grants: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  await client.getCurrentUser();
  assert.equal(request?.url, "https://api.example.test/v1/me");
  assert.equal(request?.headers.get("authorization"), "Bearer token");
  assert.equal(new URL(request?.url ?? "").search, "");
});

test("generated client rejects a successful response that violates the OpenAPI contract", async () => {
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async () => new Response(JSON.stringify({ user: {} }), { status: 200,
      headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.getCurrentUser(), InvalidApiResponse);
});

test("generated client fails locally when no access token exists", async () => {
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => undefined });
  await assert.rejects(client.getCurrentUser(), AuthenticationRequired);
});

test("generated client maps a valid 401 problem to reauthentication", async () => {
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "expired",
    fetch: async () => new Response(JSON.stringify({ type: "urn:test", title: "Unauthorized", status: 401,
      correlationId: "correlation-123" }), { status: 401, headers: { "content-type": "application/problem+json" } }) });
  await assert.rejects(client.getCurrentUser(), AuthenticationRequired);
});

test("generated client rejects malformed error payloads", async () => {
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async () => new Response(JSON.stringify({ status: 503 }), { status: 503,
      headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.getCurrentUser(), InvalidApiResponse);
});
