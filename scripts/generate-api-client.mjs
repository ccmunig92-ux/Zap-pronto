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
const source = `// Generated from the canonical OpenAPI document. Do not edit manually.\n${astToString(await openapiTS(document))}`;
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== source) throw new Error("GENERATED_API_CLIENT_OUT_OF_DATE");
} else {
  await mkdir(resolve("packages/api-client/src"), { recursive: true });
  await writeFile(output, source, "utf8");
}
