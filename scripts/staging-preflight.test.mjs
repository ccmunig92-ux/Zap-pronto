import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEnvironment, validateResources, validateSecrets, validateSecretMetadata, parseEnv } from "./staging-preflight.mjs";

const digest = "a".repeat(64);
const validEnv = { ZAP_API_IMAGE:`ghcr.io/acme/api@sha256:${digest}`, ZAP_WEB_IMAGE:`ghcr.io/acme/web@sha256:${digest}`,
  POSTGRES_IMAGE:`postgres@sha256:${digest}`, OIDC_ISSUER:"https://id.example/tenant/", OIDC_AUTHORITY_ORIGIN:"https://id.example",
  OIDC_AUDIENCE:"zap-pronto", OIDC_JWKS_URL:"https://id.example/jwks", OIDC_DISCOVERY_URL:"https://id.example/discovery" };
const compose = { services: { postgres:{deploy:{resources:{limits:{cpus:"1.50",memory:"1536M"}}}},
  migrate:{deploy:{resources:{limits:{cpus:"1",memory:"512M"}}}},
  "provision-runtime":{deploy:{resources:{limits:{cpus:"0.5",memory:"256M"}}}},
  api:{deploy:{resources:{limits:{cpus:"1",memory:"768M"}}}}, web:{deploy:{resources:{limits:{cpus:"0.5",memory:"256M"}}}} } };

test("accepts immutable images, coherent HTTPS OIDC and minimum resources", () => {
  validateEnvironment(validEnv); validateResources(compose);
});

test("rejects mutable images and unsafe or divergent OIDC endpoints", () => {
  assert.throws(() => validateEnvironment({...validEnv,ZAP_API_IMAGE:"ghcr.io/acme/api:latest"}), /NOT_IMMUTABLE/);
  assert.throws(() => validateEnvironment({...validEnv,OIDC_JWKS_URL:"http://id.example/jwks"}), /OIDC_JWKS_URL_INVALID/);
  assert.throws(() => validateEnvironment({...validEnv,OIDC_JWKS_URL:"https://other.example/jwks"}), /OIDC_ORIGIN_MISMATCH/);
});

test("rejects missing resource guarantees and malformed or duplicate env entries", () => {
  assert.throws(() => validateResources({...compose,services:{...compose.services,api:{deploy:{resources:{limits:{cpus:"0.5",memory:"768M"}}}}}}), /API_RESOURCES/);
  assert.deepEqual(parseEnv("# staging\nOIDC_AUDIENCE=zap-pronto\n"), {OIDC_AUDIENCE:"zap-pronto"});
  assert.throws(() => parseEnv("A=1\nA=2\n"), /ENV_INVALID/);
});

test("requires canonical 0400 ownership for non-root container secret readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zap-preflight-"));
  const names = ["postgres", "migration", "runtime"].map((name) => join(directory, name));
  try {
    for (const file of names) { writeFileSync(file, "not-read-by-preflight"); chmodSync(file, 0o600); }
    const env = { POSTGRES_PASSWORD_FILE:names[0], DATABASE_MIGRATION_URL_FILE:names[1], DATABASE_RUNTIME_URL_FILE:names[2] };
    if (typeof process.getuid === "function") {
      await assert.rejects(validateSecrets({...env,POSTGRES_PASSWORD_FILE:"relative-secret"}, process.cwd()), /NOT_ABSOLUTE/);
    } else {
      await assert.rejects(validateSecrets(env, process.cwd()), /POSIX_SECRET_METADATA_REQUIRED/);
    }
    const postgres = {mode:0o100400,uid:70,gid:70,isFile:()=>true};
    const api = {mode:0o100400,uid:1000,gid:1000,isFile:()=>true};
    validateSecretMetadata("POSTGRES_PASSWORD_FILE", names[0], postgres, process.cwd(), new Set(), {uid:70,gid:70});
    validateSecretMetadata("DATABASE_RUNTIME_URL_FILE", names[2], api, process.cwd(), new Set(), {uid:1000,gid:1000});
    assert.throws(() => validateSecretMetadata("SECRET", names[0], {...postgres,mode:0o100600}, process.cwd(), new Set(), {uid:70,gid:70}), /MODE_NOT_0400/);
    assert.throws(() => validateSecretMetadata("SECRET", names[0], postgres, process.cwd(), new Set(), {uid:1000,gid:1000}), /OWNER_MISMATCH/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
