import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateComposeInvariants, validateEnvironment, validateResources, validateSecrets, validateSecretMetadata, validateMetaSecretRoot, parseEnv } from "./staging-preflight.mjs";

const digest = "a".repeat(64);
const validEnv = { ZAP_API_IMAGE:`ghcr.io/acme/api@sha256:${digest}`, ZAP_WEB_IMAGE:`ghcr.io/acme/web@sha256:${digest}`,
  POSTGRES_IMAGE:`postgres@sha256:${digest}`, OIDC_ISSUER:"https://id.example/tenant/", OIDC_AUTHORITY_ORIGIN:"https://id.example",
  OIDC_AUDIENCE:"zap-pronto", OIDC_JWKS_URL:"https://id.example/jwks", OIDC_DISCOVERY_URL:"https://id.example/discovery" };

test("staging smoke scripts provision the isolated worker credential", () => {
  for (const script of ["staging-smoke.sh", "staging-backup-smoke.sh"]) {
    const source = readFileSync(new URL(script, import.meta.url), "utf8");
    assert.match(source, /database-worker-url/);
    assert.match(source, /zap_pronto_worker_runtime/);
    assert.match(source, /export DATABASE_WORKER_URL_FILE=/);
  }
});

test("staging worker exposes a process liveness healthcheck for compose wait", () => {
  const source = readFileSync(new URL("../deploy/staging/compose.yaml", import.meta.url), "utf8");
  const worker = source.match(/\r?\n  worker:\r?\n([\s\S]*?)\r?\n  web:/)?.[1];
  assert.ok(worker, "worker service must exist");
  assert.match(worker, /healthcheck:\s*\n\s+test: \["CMD", "node", "-e", "process\.kill\(1, 0\)"\]/);
  assert.doesNotMatch(worker, /healthcheck:\s*\n\s+disable: true/);
});
const hardened = (cpus,memory,networks,secrets,depends_on={}) => ({deploy:{resources:{limits:{cpus,memory}}},
  networks:Object.fromEntries(networks.map((name)=>[name,null])),secrets:secrets.map((source)=>({source})),depends_on,
  read_only:true,cap_drop:["ALL"],security_opt:["no-new-privileges:true"],
  logging:{driver:"json-file",options:{"max-size":"10m","max-file":"5"}}});
const workerMetaSecretMount = [{type:"bind",source:"/srv/zap-pronto/secrets/staging/meta",target:"/run/zap-pronto-secrets/meta",read_only:true}];
const compose = { networks:{data:{internal:true}}, services: {
  postgres:{...hardened("1.50","1536M",["data"],["postgres_password"]),read_only:undefined,cap_drop:undefined},
  migrate:hardened("1","512M",["data"],["database_migration_url"],{postgres:{condition:"service_healthy"}}),
  "provision-runtime":hardened("0.5","256M",["data"],["database_migration_url","database_runtime_url","database_worker_url"],{migrate:{condition:"service_completed_successfully"}}),
  api:{...hardened("1","768M",["app","data"],["database_runtime_url","meta_app_secret","meta_verify_token"],{"provision-runtime":{condition:"service_completed_successfully"}}),environment:{META_WEBHOOK_ENABLED:"false",META_APP_SECRET_FILE:"/run/secrets/meta_app_secret",META_VERIFY_TOKEN_FILE:"/run/secrets/meta_verify_token"}},
  worker:{...hardened("0.5","384M",["data"],["database_worker_url"],{"provision-runtime":{condition:"service_completed_successfully"}}),volumes:workerMetaSecretMount},
  web:{...hardened("0.5","256M",["app"],[],{api:{condition:"service_healthy"}}),ports:[{host_ip:"127.0.0.1",target:8080,protocol:"tcp"}]},
} };

test("accepts immutable images, coherent HTTPS OIDC and minimum resources", () => {
  validateEnvironment(validEnv); validateResources(compose); validateComposeInvariants(compose);
});

test("rejects exposed internal services, topology drift and weakened hardening", () => {
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,api:{...compose.services.api,ports:[{host_ip:"127.0.0.1",target:3000,protocol:"tcp"}]}}}), /API_PORTS_FORBIDDEN/);
  assert.throws(() => validateComposeInvariants({...compose,networks:{data:{internal:false}}}), /DATA_NETWORK_NOT_INTERNAL/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,web:{...compose.services.web,ports:[{host_ip:"0.0.0.0",target:8080,protocol:"tcp"}]}}}), /WEB_PORT_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,api:{...compose.services.api,read_only:false}}}), /API_HARDENING_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,migrate:{...compose.services.migrate,secrets:[]}}}), /MIGRATE_SECRETS_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,web:{...compose.services.web,depends_on:{}}}}), /WEB_DEPENDENCY_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,worker:{...compose.services.worker,volumes:[]}}}), /WORKER_META_SECRET_MOUNT_INVALID/);
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
    const names = ["postgres", "migration", "runtime", "worker", "meta-app", "meta-verify"].map((name) => join(directory, name));
  try {
    for (const file of names) { writeFileSync(file, "not-read-by-preflight"); chmodSync(file, 0o600); }
    const env = { POSTGRES_PASSWORD_FILE:names[0], DATABASE_MIGRATION_URL_FILE:names[1], DATABASE_RUNTIME_URL_FILE:names[2], DATABASE_WORKER_URL_FILE:names[3], META_APP_SECRET_FILE:names[4], META_VERIFY_TOKEN_FILE:names[5] };
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

test("rejects a secret reached through a symlinked parent", {skip: typeof process.getuid !== "function"}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "zap-preflight-link-"));
  try {
    const real = join(directory,"real"); mkdirSync(real); writeFileSync(join(real,"secret"),"opaque");
    const link = join(directory,"linked"); symlinkSync(real,link,"dir");
    const throughLink = join(link,"secret");
    await assert.rejects(validateSecrets({POSTGRES_PASSWORD_FILE:throughLink,
      DATABASE_MIGRATION_URL_FILE:throughLink,DATABASE_RUNTIME_URL_FILE:throughLink},process.cwd()), /SYMLINK_REJECTED/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("requires the Meta secret root to be an external absolute directory", async () => {
  await assert.rejects(validateMetaSecretRoot("relative/meta", process.cwd()), /META_WHATSAPP_SECRET_ROOT_NOT_ABSOLUTE/);
});

test("rejects a symlinked Meta secret root", {skip: typeof process.getuid !== "function"}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "zap-meta-root-link-"));
  try {
    const real = join(directory, "real"); mkdirSync(real); const link = join(directory, "linked"); symlinkSync(real, link, "dir");
    await assert.rejects(validateMetaSecretRoot(link, process.cwd()), /META_WHATSAPP_SECRET_ROOT_SYMLINK_REJECTED/);
  } finally { rmSync(directory, {recursive:true, force:true}); }
});
