import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadApiRuntimeConfig } from "./runtime-config.js";

test("API runtime config validates database and bounded numeric settings", () => {
  assert.deepEqual(loadApiRuntimeConfig({ DATABASE_URL:"postgresql://db/app" }), {
    databaseUrl:"postgresql://db/app",databasePoolMax:10,host:"127.0.0.1",port:3000 });
  assert.deepEqual(loadApiRuntimeConfig({ DATABASE_URL:"postgres://db/app",DATABASE_POOL_MAX:"25",
    API_HOST:"0.0.0.0",API_PORT:"8080" }), {
    databaseUrl:"postgres://db/app",databasePoolMax:25,host:"0.0.0.0",port:8080 });
  for (const env of [{}, { DATABASE_URL:"mysql://db/app" },
    { DATABASE_URL:"postgresql://db/app",DATABASE_POOL_MAX:"0" },
    { DATABASE_URL:"postgresql://db/app",DATABASE_POOL_MAX:"ten" },
    { DATABASE_URL:"postgresql://db/app",API_PORT:"65536" },
    { DATABASE_URL:"postgresql://db/app",API_HOST:"bad host" }]) {
    assert.throws(() => loadApiRuntimeConfig(env));
  }
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
