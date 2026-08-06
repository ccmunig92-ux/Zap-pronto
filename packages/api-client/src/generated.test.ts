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

test("invitation client loads canonical options and sends one idempotent POST", async () => {
  const requests: Request[] = [];
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async (request) => {
      requests.push(request);
      if (request.method === "GET") return new Response(JSON.stringify({ providers: [{ code: "primary" }],
        units: [{ id: "33333333-3333-4333-8333-333333333333", code: "CENTRO", name: "Centro" }],
        roles: ["ATTENDANT"] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ invitation: { id: "44444444-4444-4444-8444-444444444444",
        email: "user@example.test", displayName: "User", status: "PENDING",
        expiresAt: "2026-08-20T12:00:00.000Z", providerCode: "primary" }, assignments: [{
          unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO", unitName: "Centro", role: "ATTENDANT",
        }], replayed: false, invitationToken: "a".repeat(43) }),
      { status: 201, headers: { "content-type": "application/json" } });
    } });
  await client.getUserInvitationOptions();
  await client.createUserInvitation({ email: "user@example.test", displayName: "User", providerCode: "primary",
    expiresAt: "2026-08-20T12:00:00.000Z", assignments: [{
      unitId: "33333333-3333-4333-8333-333333333333", role: "ATTENDANT",
    }] }, "invitation-command-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.example.test/v1/users/invitations/options");
  assert.equal(requests[1]?.headers.get("idempotency-key"), "invitation-command-1");
});

test("administration client uses generated lifecycle paths and explicit idempotency", async () => {
  const requests: Request[] = [];
  const invitation = { id: "44444444-4444-4444-8444-444444444444", email: "user@example.test",
    displayName: "User", status: "REVOKED", expiresAt: "2026-08-20T12:00:00.000Z", providerCode: "primary",
    assignments: [], allowedActions: ["REISSUE"] };
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async (request) => { requests.push(request); const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/users") return Response.json({ items: [] });
      if (request.method === "GET") return Response.json({ items: [invitation] });
      if (url.pathname.endsWith("/status")) return Response.json({ user: {
        id: "55555555-5555-4555-8555-555555555555", status: "BLOCKED", version: 2 }, replayed: false });
      if (url.pathname.endsWith("/reissue")) return Response.json({ invitation: { ...invitation,
        id: "66666666-6666-4666-8666-666666666666", status: "PENDING", allowedActions: ["REVOKE", "REISSUE"] },
        replayed: false, invitationToken: "a".repeat(43) }, { status: 201 });
      return Response.json({ invitation, replayed: false });
    } });
  await client.listAdministrativeUsers({ limit: 10 }); await client.listAdministrativeInvitations();
  await client.changeAdministrativeUserStatus("55555555-5555-4555-8555-555555555555",
    { action: "BLOCK", expectedVersion: 1, reason: "Security review" }, "status-command-1");
  await client.revokeUserInvitation(invitation.id, { reason: "Reissue" }, "revoke-command-1");
  await client.reissueUserInvitation(invitation.id, { reason: "New expiry",
    expiresAt: "2026-08-21T12:00:00.000Z" }, "reissue-command-1");
  assert.equal(requests.length, 5);
  assert.equal(new URL(requests[0]!.url).searchParams.get("limit"), "10");
  assert.deepEqual(requests.slice(2).map((request) => request.headers.get("idempotency-key")),
    ["status-command-1", "revoke-command-1", "reissue-command-1"]);
});
