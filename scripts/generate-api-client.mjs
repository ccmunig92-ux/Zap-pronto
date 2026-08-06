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
const source = `// Generated from the canonical OpenAPI document. Do not edit manually.\n${astToString(await openapiTS(document))}`;
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== source) throw new Error("GENERATED_API_CLIENT_OUT_OF_DATE");
} else {
  await mkdir(resolve("packages/api-client/src"), { recursive: true });
  await writeFile(output, source, "utf8");
}
