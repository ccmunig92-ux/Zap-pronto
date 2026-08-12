import assert from "node:assert/strict";
import test from "node:test";
import { ApiProblem, AuthenticationRequired, createApiClient, InvalidApiResponse } from "./client.js";

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

test("membership lifecycle client is unit-scoped and idempotent",async()=>{let request:Request|undefined;
  const userId="55555555-5555-4555-8555-555555555555",unitId="44444444-4444-4444-8444-444444444444";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;
    return Response.json({membership:{userId,unitId,status:"REVOKED",version:2},replayed:false})}});
  const result=await client.changeUnitMembership(userId,unitId,{expectedVersion:1,operation:"REVOKE",reason:"Acesso removido"},"membership-command-1");
  assert.equal(result.membership.status,"REVOKED");assert.equal(new URL(request!.url).pathname,`/v1/users/${userId}/memberships/${unitId}/lifecycle`);
  assert.equal(request!.headers.get("idempotency-key"),"membership-command-1");
  assert.deepEqual(await request!.json(),{expectedVersion:1,operation:"REVOKE",reason:"Acesso removido"});});

test("unit membership catalog sends only the unit-scoped keyset query and bearer token",async()=>{
  let request:Request|undefined;
  const unitId="44444444-4444-4444-8444-444444444444",userId="55555555-5555-4555-8555-555555555555";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"unit-manager-token",
    fetch:async input=>{request=input;return Response.json({items:[{userId,displayName:"Atendente B",role:"ATTENDANT",
      status:"ACTIVE",version:3,allowedActions:["REVOKE"]}],nextCursor:"unit-cursor-next"})}});
  const page=await client.listUnitMemberships({unitId,limit:20,cursor:"unit-cursor-current"});
  const url=new URL(request!.url);
  assert.equal(request!.method,"GET");assert.equal(url.pathname,`/v1/units/${unitId}/memberships`);
  assert.equal(url.searchParams.get("limit"),"20");assert.equal(url.searchParams.get("cursor"),"unit-cursor-current");
  assert.deepEqual([...url.searchParams.keys()].sort(),["cursor","limit"]);
  assert.equal(request!.headers.get("authorization"),"Bearer unit-manager-token");
  assert.deepEqual(page.items,[{userId,displayName:"Atendente B",role:"ATTENDANT",status:"ACTIVE",version:3,
    allowedActions:["REVOKE"]}]);assert.equal("email" in page.items[0]!,false);
});

test("reopen client sends the generated idempotent command and validates the episodic response",async()=>{let request:Request|undefined;
  const sourceHandoffId="20000000-0000-4000-8000-000000000001",handoffId="20000000-0000-4000-8000-000000000002";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({
    sourceHandoffId,handoffId,conversationId:"30000000-0000-4000-8000-000000000001",serviceCaseId:"40000000-0000-4000-8000-000000000001",
    handoffVersion:1,conversationVersion:4,serviceCaseVersion:3,replayed:false})}});
  const result=await client.reopenInboxHandoff(sourceHandoffId,2,"NEW_INFORMATION","reopen-command-1");
  assert.equal(result.handoffId,handoffId);assert.equal(request?.method,"POST");assert.equal(new URL(request!.url).pathname,`/v1/inbox/handoffs/${sourceHandoffId}/reopen`);
  assert.equal(request?.headers.get("idempotency-key"),"reopen-command-1");assert.deepEqual(await request!.json(),{expectedVersion:2,reason:"NEW_INFORMATION"});});

test("unit membership catalog rejects responses containing email",async()=>{
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async()=>Response.json({items:[{
    userId:"55555555-5555-4555-8555-555555555555",displayName:"Atendente B",email:"private@example.test",
    role:"ATTENDANT",status:"ACTIVE",version:1,allowedActions:["REVOKE"]}]})});
  await assert.rejects(client.listUnitMemberships({unitId:"44444444-4444-4444-8444-444444444444"}),InvalidApiResponse);
});

test("unit membership catalog fails locally without token and maps a valid forbidden problem",async()=>{
  const unitId="44444444-4444-4444-8444-444444444444";
  const unauthenticated=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>undefined});
  await assert.rejects(unauthenticated.listUnitMemberships({unitId}),AuthenticationRequired);
  const forbidden=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async()=>
    new Response(JSON.stringify({type:"urn:zap-pronto:forbidden",title:"Forbidden",status:403,correlationId:"unit-catalog-403"}),
      {status:403,headers:{"content-type":"application/problem+json"}})});
  await assert.rejects(forbidden.listUnitMemberships({unitId}),(error:unknown)=>error instanceof ApiProblem
    && error.problem.status===403&&error.problem.correlationId==="unit-catalog-403");
});

test("invitation acceptance sends only bearer, idempotency key and one-time token", async () => {
  let request: Request | undefined;
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "oidc-token",
    fetch: async (input) => { request = input; return Response.json({ currentUser: {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "user@example.test", displayName: "User" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Tenant" }, memberships: [], grants: [],
    }, replayed: false }); } });
  await client.acceptUserInvitation("a".repeat(43), "accept-command-1");
  assert.equal(request?.url, "https://api.example.test/v1/auth/invitations/accept");
  assert.equal(request?.headers.get("authorization"), "Bearer oidc-token");
  assert.equal(request?.headers.get("idempotency-key"), "accept-command-1");
  assert.deepEqual(await request?.json(), { invitationToken: "a".repeat(43) });
});

test("invitation acceptance exposes 429 Retry-After without retrying", async () => {
  let calls = 0;
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "oidc-token",
    fetch: async () => { calls += 1; return Response.json({ type: "urn:zap-pronto:error:rate-limit-exceeded",
      title: "Too Many Requests", status: 429, correlationId: "correlation-123" },
    { status: 429, headers: { "retry-after": "37" } }); } });
  await assert.rejects(client.acceptUserInvitation("a".repeat(43), "accept-command-1"),
    (error) => error instanceof ApiProblem && error.problem.status === 429 && error.retryAfterSeconds === 37);
  assert.equal(calls, 1);
});

test("routing client uses canonical list and idempotent resolve contracts",async()=>{const requests:Request[]=[];
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async request=>{
    requests.push(request);if(request.method==="GET")return Response.json({items:[]});return Response.json({
      receiptId:"10000000-0000-4000-8000-000000000001",unitId:"30000000-0000-4000-8000-000000000001",
      routingStatus:"ROUTED",replayed:false});}});
  await client.listRoutingRequired({limit:10,cursor:"abc"});await client.resolveRoutingRequired(
    "10000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000001","routing-command-1");
  assert.equal(new URL(requests[0]!.url).pathname,"/v1/inbox/routing-required");
  assert.equal(new URL(requests[0]!.url).searchParams.get("cursor"),"abc");
  assert.equal(requests[1]!.headers.get("idempotency-key"),"routing-command-1");
  assert.deepEqual(await requests[1]!.json(),{unitId:"30000000-0000-4000-8000-000000000001"});
});

test("inbox conversation client uses canonical detail and history paths",async()=>{const requests:Request[]=[];const conversationId="20000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async request=>{requests.push(request);
    if(new URL(request.url).pathname.endsWith("/messages"))return Response.json({items:[{id:"60000000-0000-4000-8000-000000000001",direction:"INBOUND",actor:"CUSTOMER",body:"Olá",kind:"TEXT",trust:"UNTRUSTED",deliveryStatus:null,allowedActions:[],createdAt:"2026-08-10T10:00:00.000Z"}]});
    return Response.json({conversationId,unitId:"30000000-0000-4000-8000-000000000001",channelConnectionId:"40000000-0000-4000-8000-000000000001",status:"OPEN",automationStatus:"HUMAN_QUEUED",assignedUserId:null,version:1,
      updatedAt:"2026-08-10T10:00:00.000Z",stateChangedAt:"2026-08-10T10:00:00.000Z",closedAt:null,displayName:"Contato",allowedActions:[],claimTarget:null,sendTextTarget:null,resolveTarget:null,requeueTarget:null,transferTarget:null,takeoverTarget:null});}});
  await client.getInboxConversation(conversationId);await client.listInboxConversationMessages(conversationId,{limit:10,cursor:"abc",before:"2026-08-10T10:00:00.000Z"});
  assert.equal(new URL(requests[0]!.url).pathname,`/v1/inbox/conversations/${conversationId}`);assert.equal(new URL(requests[1]!.url).search,"?limit=10&cursor=abc&before=2026-08-10T10%3A00%3A00.000Z");
  assert.ok(requests.every(request=>request.headers.get("authorization")==="Bearer token"));});

test("active inbox client sends unit-scoped keyset query",async()=>{let request:Request|undefined;const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",
  fetch:async input=>{request=input;return Response.json({items:[]})}});await client.listActiveInboxHandoffs({unitId:"30000000-0000-4000-8000-000000000001",limit:10,cursor:"active-cursor"});
  const url=new URL(request!.url);assert.equal(url.pathname,"/v1/inbox/active");assert.equal(url.searchParams.get("cursor"),"active-cursor");});

test("resolved inbox client sends the unit-scoped filters and validates its DTO",async()=>{let request:Request|undefined;const unitId="30000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({items:[{id:"10000000-0000-4000-8000-000000000001",conversationId:"20000000-0000-4000-8000-000000000001",unitId,contactName:"Contato",reason:"LOCAL",priority:"NORMAL",resolvedAt:"2026-08-11T12:00:00.000Z",disposition:"LEGACY_UNSPECIFIED",resolvedByUserId:null,resolvedByDisplayName:null,version:2,reopenTarget:null}],nextCursor:"resolved-next"})}});
  const page=await client.listResolvedInboxHandoffs({unitId,limit:10,cursor:"resolved-cursor",priority:"HIGH",disposition:"CUSTOMER_WITHDREW",resolvedFrom:"2026-08-01T00:00:00.000Z",resolvedBefore:"2026-08-12T00:00:00.000Z"});const url=new URL(request!.url);
  assert.equal(url.pathname,"/v1/inbox/resolved");assert.equal(url.searchParams.get("unitId"),unitId);assert.equal(url.searchParams.get("cursor"),"resolved-cursor");
  assert.equal(url.searchParams.get("priority"),"HIGH");assert.equal(url.searchParams.get("disposition"),"CUSTOMER_WITHDREW");assert.equal(url.searchParams.get("resolvedFrom"),"2026-08-01T00:00:00.000Z");assert.equal(url.searchParams.get("resolvedBefore"),"2026-08-12T00:00:00.000Z");assert.equal(page.nextCursor,"resolved-next");});

test("supervised inbox client sends only the unit-scoped keyset query",async()=>{let request:Request|undefined;const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({items:[]})}});await client.listSupervisedInboxHandoffs({unitId:"30000000-0000-4000-8000-000000000001",limit:10,cursor:"supervised-cursor"});const url=new URL(request!.url);assert.equal(url.pathname,"/v1/inbox/supervised");assert.equal(url.searchParams.get("unitId"),"30000000-0000-4000-8000-000000000001");assert.equal(url.searchParams.get("cursor"),"supervised-cursor");});

test("claim client sends canonical handoff version and stable idempotency key",async()=>{let request:Request|undefined;const handoff={id:"10000000-0000-4000-8000-000000000001",conversationId:"20000000-0000-4000-8000-000000000001",serviceCaseId:"30000000-0000-4000-8000-000000000001",unitId:"40000000-0000-4000-8000-000000000001",contactName:"Contato",reason:"LOCAL",priority:"NORMAL",status:"ACTIVE",assignedUserId:"50000000-0000-4000-8000-000000000001",requestedAt:"2026-08-10T10:00:00.000Z",queuedAt:"2026-08-10T10:00:00.000Z",slaDueAt:null,slaStatus:null,automationStatus:"HUMAN_ACTIVE",version:2};
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({handoff,replayed:false})}});
  await client.claimHandoff(handoff.id,1,"claim-intent-stable");assert.equal(request!.method,"POST");assert.equal(new URL(request!.url).pathname,`/v1/inbox/handoffs/${handoff.id}/claim`);
  assert.equal(request!.headers.get("idempotency-key"),"claim-intent-stable");assert.deepEqual(await request!.json(),{expectedVersion:1});});

test("resolve client sends only the canonical handoff version and stable idempotency key",async()=>{let request:Request|undefined;const handoffId="10000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({handoffId,conversationId:"20000000-0000-4000-8000-000000000001",serviceCaseId:"30000000-0000-4000-8000-000000000001",handoffVersion:3,conversationVersion:9,replayed:false})}});
  const result=await client.resolveHandoff(handoffId,2,"RESOLVED","resolve-intent-stable");assert.equal(result.handoffVersion,3);assert.equal(request!.method,"POST");
  assert.equal(new URL(request!.url).pathname,`/v1/inbox/handoffs/${handoffId}/resolve`);assert.equal(request!.headers.get("idempotency-key"),"resolve-intent-stable");
  assert.deepEqual(await request!.json(),{expectedVersion:2,disposition:"RESOLVED"});});

test("requeue client sends only expectedVersion and a stable key",async()=>{let request:Request|undefined;const handoffId="10000000-0000-4000-8000-000000000001";const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({handoffId,conversationId:"20000000-0000-4000-8000-000000000001",serviceCaseId:"30000000-0000-4000-8000-000000000001",handoffVersion:3,conversationVersion:9,serviceCaseVersion:4,replayed:false})}});const result=await client.requeueHandoff(handoffId,2,"requeue-intent-stable");assert.equal(result.handoffVersion,3);assert.equal(new URL(request!.url).pathname,`/v1/inbox/handoffs/${handoffId}/requeue`);assert.equal(request!.headers.get("idempotency-key"),"requeue-intent-stable");assert.deepEqual(await request!.json(),{expectedVersion:2});});

test("transfer client uses the narrow catalog and idempotent command contracts",async()=>{const handoffId="10000000-0000-4000-8000-000000000001",targetUserId="70000000-0000-4000-8000-000000000002";const requests:Request[]=[];
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{requests.push(input);return input.method==="GET"?Response.json({items:[{id:targetUserId,displayName:"Atendente B"}]}):Response.json({handoffId,conversationId:"20000000-0000-4000-8000-000000000001",serviceCaseId:"30000000-0000-4000-8000-000000000001",targetUserId,handoffVersion:3,conversationVersion:9,replayed:false})}});
  const candidates=await client.listInboxHandoffTransferCandidates(handoffId);assert.deepEqual(candidates.items,[{id:targetUserId,displayName:"Atendente B"}]);await client.transferInboxHandoff(handoffId,2,targetUserId,"SHIFT_CHANGE","transfer-intent-stable");
  assert.equal(new URL(requests[0]!.url).pathname,`/v1/inbox/handoffs/${handoffId}/transfer-candidates`);assert.equal(requests[1]!.headers.get("idempotency-key"),"transfer-intent-stable");assert.deepEqual(await requests[1]!.json(),{expectedVersion:2,targetUserId,reason:"SHIFT_CHANGE"});});

test("takeover client sends only expectedVersion and a stable key",async()=>{let request:Request|undefined;const handoffId="10000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({handoffId,conversationId:"20000000-0000-4000-8000-000000000001",serviceCaseId:"30000000-0000-4000-8000-000000000001",previousAssignedUserId:"50000000-0000-4000-8000-000000000001",handoffVersion:4,conversationVersion:8,replayed:false})}});
  const result=await client.takeoverInboxHandoff(handoffId,3,"takeover-intent-stable");assert.equal(result.handoffVersion,4);assert.equal(request!.method,"POST");
  assert.equal(new URL(request!.url).pathname,`/v1/inbox/handoffs/${handoffId}/takeover`);assert.equal(request!.headers.get("idempotency-key"),"takeover-intent-stable");assert.deepEqual(await request!.json(),{expectedVersion:3});});

test("human text client queues only TEXT with canonical version and key",async()=>{let request:Request|undefined;const conversationId="20000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({messageId:"60000000-0000-4000-8000-000000000001",conversationId,conversationVersion:8,deliveryStatus:"QUEUED",replayed:false},{status:202})}});
  const result=await client.sendHumanTextMessage(conversationId,{body:"Resposta local",expectedConversationVersion:7},"send-intent-stable");assert.equal(result.deliveryStatus,"QUEUED");
  assert.equal(request!.method,"POST");assert.equal(request!.headers.get("idempotency-key"),"send-intent-stable");assert.deepEqual(await request!.json(),{kind:"TEXT",body:"Resposta local",expectedConversationVersion:7});});

test("human text cancellation uses the canonical nested path and stable key",async()=>{let request:Request|undefined;const conversationId="20000000-0000-4000-8000-000000000001",messageId="60000000-0000-4000-8000-000000000001";
  const client=createApiClient({baseUrl:"https://api.example.test",getAccessToken:async()=>"token",fetch:async input=>{request=input;return Response.json({messageId,conversationId,conversationVersion:9,deliveryStatus:"CANCELLED",replayed:false},{status:202})}});
  const result=await client.cancelHumanTextMessage(conversationId,messageId,8,"cancel-intent-stable");assert.equal(result.deliveryStatus,"CANCELLED");
  assert.equal(request!.method,"POST");assert.equal(new URL(request!.url).pathname,`/v1/inbox/conversations/${conversationId}/messages/${messageId}/cancel`);
  assert.equal(request!.headers.get("idempotency-key"),"cancel-intent-stable");assert.deepEqual(await request!.json(),{expectedConversationVersion:8});});
