import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadApiRuntimeConfig } from "./runtime-config.js";

test("API runtime config validates database and bounded numeric settings", () => {
  assert.deepEqual(loadApiRuntimeConfig({ DATABASE_URL:"postgresql://db/app" }), {
    databaseUrl:"postgresql://db/app",databasePoolMax:10,host:"127.0.0.1",port:3000,
    metaWebhook:{enabled:false} });
  assert.deepEqual(loadApiRuntimeConfig({ DATABASE_URL:"postgres://db/app",DATABASE_POOL_MAX:"25",
    API_HOST:"0.0.0.0",API_PORT:"8080" }), {
    databaseUrl:"postgres://db/app",databasePoolMax:25,host:"0.0.0.0",port:8080,
    metaWebhook:{enabled:false} });
  for (const env of [{}, { DATABASE_URL:"mysql://db/app" },
    { DATABASE_URL:"postgresql://db/app",DATABASE_POOL_MAX:"0" },
    { DATABASE_URL:"postgresql://db/app",DATABASE_POOL_MAX:"ten" },
    { DATABASE_URL:"postgresql://db/app",API_PORT:"65536" },
    { DATABASE_URL:"postgresql://db/app",API_HOST:"bad host" }]) {
    assert.throws(() => loadApiRuntimeConfig(env));
  }
});

test("Meta webhook config is disabled by default and fails closed when enabled", () => {
  const base={DATABASE_URL:"postgresql://db/app"};
  for(const env of [
    {...base,META_WEBHOOK_ENABLED:"TRUE"},
    {...base,META_WEBHOOK_ENABLED:"true",META_APP_SECRET:"secret"},
    {...base,META_WEBHOOK_ENABLED:"true",META_VERIFY_TOKEN:"token"},
    {...base,META_WEBHOOK_ENABLED:"true",META_APP_SECRET:"",META_VERIFY_TOKEN:"token"},
    {...base,META_WEBHOOK_ENABLED:"true",META_APP_SECRET:"secret",META_VERIFY_TOKEN:"token",META_WEBHOOK_MAX_BODY_BYTES:"0"},
    {...base,META_WEBHOOK_ENABLED:"true",META_APP_SECRET:"secret",META_VERIFY_TOKEN:"token",META_WEBHOOK_MAX_BODY_BYTES:"1048577"},
  ]) assert.throws(()=>loadApiRuntimeConfig(env),/API_CONFIGURATION_/);
  const enabled=loadApiRuntimeConfig({...base,META_WEBHOOK_ENABLED:"true",META_APP_SECRET:"secret",
    META_VERIFY_TOKEN:"verify-token",META_WEBHOOK_MAX_BODY_BYTES:"4096"}).metaWebhook;
  assert.deepEqual(enabled,{enabled:true,appSecret:"secret",verifyToken:"verify-token",maxBodyBytes:4096});
});

test("Meta secrets use exclusive direct or file sources without exposing contents", () => {
  const directory=mkdtempSync(join(tmpdir(),"zap-pronto-meta-secret-"));
  const appSecret=join(directory,"app-secret");const verifyToken=join(directory,"verify-token");
  try{
    writeFileSync(appSecret,"app-secret-file",{mode:0o600});writeFileSync(verifyToken,"verify-token-file",{mode:0o600});
    const base={DATABASE_URL:"postgresql://db/app",META_WEBHOOK_ENABLED:"true"};
    assert.deepEqual(loadApiRuntimeConfig({...base,META_APP_SECRET_FILE:appSecret,META_VERIFY_TOKEN_FILE:verifyToken}).metaWebhook,
      {enabled:true,appSecret:"app-secret-file",verifyToken:"verify-token-file",maxBodyBytes:1048576});
    assert.throws(()=>loadApiRuntimeConfig({...base,META_APP_SECRET:"secret-value",META_APP_SECRET_FILE:appSecret,
      META_VERIFY_TOKEN:"token-value"}),/API_CONFIGURATION_SOURCE_CONFLICT:META_APP_SECRET/);
    try{loadApiRuntimeConfig({...base,META_APP_SECRET_FILE:join(directory,"missing"),META_VERIFY_TOKEN:"token"});}
    catch(error){assert.doesNotMatch(String(error),/secret-value|token-value|missing\\app/);}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("API runtime config reads a Docker secret without exposing or ambiguously overriding it", () => {
  const directory=mkdtempSync(join(tmpdir(),"zap-pronto-db-secret-"));
  const secret=join(directory,"database-url");
  try {
    writeFileSync(secret,"postgresql://secret-user:secret-password@db/zap\n",{mode:0o600});
    const config=loadApiRuntimeConfig({DATABASE_URL_FILE:secret});
    assert.equal(config.databaseUrl,"postgresql://secret-user:secret-password@db/zap");
    assert.throws(()=>loadApiRuntimeConfig({DATABASE_URL:"postgresql://db/zap",DATABASE_URL_FILE:secret}),
      /DATABASE_URL_SOURCE_CONFLICT/);
    assert.throws(()=>loadApiRuntimeConfig({DATABASE_URL_FILE:join(directory,"missing")}),
      /DATABASE_URL_FILE_UNREADABLE/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
