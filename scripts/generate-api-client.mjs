import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../apps/api/dist/app.js";
import openapiTS, { astToString } from "openapi-typescript";

const output = resolve("packages/api-client/src/generated.ts");
const app = await buildApp();
await app.ready();
const document = app.swagger();
await app.close();
if (document.paths?.["/v1/me"]?.get?.operationId !== "getCurrentUser") {
  throw new Error("OPENAPI_GET_CURRENT_USER_MISSING");
}
if (document.paths?.["/v1/users/invitations/options"]?.get?.operationId !== "getUserInvitationOptions"
  || document.paths?.["/v1/users/invitations"]?.post?.operationId !== "createUserInvitation") {
  throw new Error("OPENAPI_USER_INVITATIONS_MISSING");
}
if (document.paths?.["/v1/users"]?.get?.operationId !== "listAdministrativeUsers"
  || document.paths?.["/v1/users/invitations"]?.get?.operationId !== "listAdministrativeInvitations"
  || document.paths?.["/v1/users/{userId}/status"]?.post?.operationId !== "changeAdministrativeUserStatus"
  || document.paths?.["/v1/users/invitations/{invitationId}/revoke"]?.post?.operationId !== "revokeUserInvitation"
  || document.paths?.["/v1/users/invitations/{invitationId}/reissue"]?.post?.operationId !== "reissueUserInvitation") {
  throw new Error("OPENAPI_USER_ADMINISTRATION_MISSING");
}
if (document.paths?.["/v1/auth/invitations/accept"]?.post?.operationId !== "acceptUserInvitation") {
  throw new Error("OPENAPI_INVITATION_ACCEPTANCE_MISSING");
}
if (document.paths?.["/v1/inbox/handoffs"]?.get?.operationId !== "listHandoffs"
  || document.paths?.["/v1/inbox/handoffs/{handoffId}/claim"]?.post?.operationId !== "claimHandoff"
  || document.paths?.["/v1/inbox/handoffs/{handoffId}/resolve"]?.post?.operationId !== "resolveInboxHandoff"
  || document.paths?.["/v1/inbox/handoffs/{handoffId}/requeue"]?.post?.operationId !== "requeueInboxHandoff"
  || document.paths?.["/v1/inbox/handoffs/{handoffId}/transfer-candidates"]?.get?.operationId !== "listInboxHandoffTransferCandidates"
  || document.paths?.["/v1/inbox/handoffs/{handoffId}/transfer"]?.post?.operationId !== "transferInboxHandoff") {
  throw new Error("OPENAPI_INBOX_HANDOFFS_MISSING");
}
if(document.paths?.["/v1/inbox/active"]?.get?.operationId!=="listActiveInboxHandoffs")throw new Error("OPENAPI_INBOX_ACTIVE_MISSING");
if(document.paths?.["/v1/inbox/resolved"]?.get?.operationId!=="listResolvedInboxHandoffs")throw new Error("OPENAPI_INBOX_RESOLVED_MISSING");
if(document.paths?.["/v1/inbox/routing-required"]?.get?.operationId!=="listRoutingRequired"
  ||document.paths?.["/v1/inbox/routing-required/{receiptId}/resolve"]?.post?.operationId!=="resolveRoutingRequired"){
  throw new Error("OPENAPI_INBOUND_ROUTING_MISSING");
}
if(document.paths?.["/v1/inbox/conversations/{conversationId}"]?.get?.operationId!=="getInboxConversation"
  ||document.paths?.["/v1/inbox/conversations/{conversationId}/messages"]?.get?.operationId!=="listInboxConversationMessages"
  ||document.paths?.["/v1/inbox/conversations/{conversationId}/messages"]?.post?.operationId!=="sendHumanTextMessage"){
  throw new Error("OPENAPI_INBOX_CONVERSATIONS_MISSING");
}
if(document.paths?.["/v1/inbox/conversations/{conversationId}/messages/{messageId}/cancel"]?.post?.operationId!=="cancelHumanTextMessage"){
  throw new Error("OPENAPI_INBOX_MESSAGE_CANCEL_MISSING");
}
const source = `// Generated from the canonical OpenAPI document. Do not edit manually.\n${astToString(await openapiTS(document))}`;
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== source) {
    const expectedLines=source.split("\n"),currentLines=current.split("\n");
    const mismatch=expectedLines.findIndex((line,index)=>line!==currentLines[index]);
    console.error(JSON.stringify({mismatchLine:mismatch+1,expected:expectedLines.slice(mismatch,mismatch+20),current:currentLines.slice(mismatch,mismatch+20)},null,2));
    throw new Error("GENERATED_API_CLIENT_OUT_OF_DATE");
  }
} else {
  await mkdir(resolve("packages/api-client/src"), { recursive: true });
  await writeFile(output, source, "utf8");
}
