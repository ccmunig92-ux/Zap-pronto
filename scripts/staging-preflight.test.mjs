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

test("staging worker healthcheck requires a recent successful capacity discovery", () => {
  const source = readFileSync(new URL("../deploy/staging/compose.yaml", import.meta.url), "utf8");
  const worker = source.match(/\r?\n  worker:\r?\n([\s\S]*?)\r?\n  web:/)?.[1];
  assert.ok(worker, "worker service must exist");
  assert.match(worker, /healthcheck:\s*\n\s+test: \["CMD", "node", "-e", ".*zap-pronto-capacity-alert\.healthy.*"\]/);
  assert.match(worker, /CAPACITY_ALERT_DISCOVERY_FAILURE_THRESHOLD: "3"/);
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
  api:{...hardened("1","768M",["app","data"],["database_runtime_url"],{"provision-runtime":{condition:"service_completed_successfully"}}),environment:{META_WEBHOOK_ENABLED:"false"}},
  worker:{...hardened("0.5","384M",["data"],["database_worker_url"],{"provision-runtime":{condition:"service_completed_successfully"}}),environment:{OUTBOUND_WORKER_ENABLED:"false"}},
  web:{...hardened("0.5","256M",["app"],[],{api:{condition:"service_healthy"}}),ports:[{host_ip:"127.0.0.1",target:8080,protocol:"tcp"}]},
} };
const metaCompose = structuredClone(compose);
metaCompose.services.api.secrets.push({source:"meta_app_secret"},{source:"meta_verify_token"});
Object.assign(metaCompose.services.api.environment,{META_WEBHOOK_ENABLED:"true",META_APP_SECRET_FILE:"/run/secrets/meta_app_secret",META_VERIFY_TOKEN_FILE:"/run/secrets/meta_verify_token"});
Object.assign(metaCompose.services.worker,{volumes:workerMetaSecretMount,environment:{OUTBOUND_WORKER_ENABLED:"true",META_WHATSAPP_SECRET_ROOT:"/run/zap-pronto-secrets/meta"}});

test("accepts immutable images, coherent HTTPS OIDC and minimum resources", () => {
  validateEnvironment(validEnv); validateResources(compose); validateComposeInvariants(compose);
  const expectedEmailClaims = {
    emailClaim:"https://clinicaprontomedic.online/claims/email",
    emailVerifiedClaim:"https://clinicaprontomedic.online/claims/email_verified",
  };
  validateEnvironment({...validEnv,OIDC_EMAIL_CLAIM:expectedEmailClaims.emailClaim,
    OIDC_EMAIL_VERIFIED_CLAIM:expectedEmailClaims.emailVerifiedClaim});
  const claimsCompose = structuredClone(compose);
  Object.assign(claimsCompose.services.api.environment, {
    OIDC_EMAIL_CLAIM:expectedEmailClaims.emailClaim,
    OIDC_EMAIL_VERIFIED_CLAIM:expectedEmailClaims.emailVerifiedClaim,
  });
  validateComposeInvariants(claimsCompose,{expectedEmailClaims});
  validateEnvironment({...validEnv,META_GRAPH_API_VERSION:"v23.0"},{metaEnabled:true});
  validateComposeInvariants(metaCompose,{metaEnabled:true});
});

test("rejects exposed internal services, topology drift and weakened hardening", () => {
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,api:{...compose.services.api,ports:[{host_ip:"127.0.0.1",target:3000,protocol:"tcp"}]}}}), /API_PORTS_FORBIDDEN/);
  assert.throws(() => validateComposeInvariants({...compose,networks:{data:{internal:false}}}), /DATA_NETWORK_NOT_INTERNAL/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,web:{...compose.services.web,ports:[{host_ip:"0.0.0.0",target:8080,protocol:"tcp"}]}}}), /WEB_PORT_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,api:{...compose.services.api,read_only:false}}}), /API_HARDENING_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,migrate:{...compose.services.migrate,secrets:[]}}}), /MIGRATE_SECRETS_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,web:{...compose.services.web,depends_on:{}}}}), /WEB_DEPENDENCY_INVALID/);
  assert.throws(() => validateComposeInvariants({...compose,services:{...compose.services,worker:{...compose.services.worker,volumes:workerMetaSecretMount}}}), /WORKER_META_DISABLED_CONFIGURATION_INVALID/);
  assert.throws(() => validateComposeInvariants({...metaCompose,services:{...metaCompose.services,worker:{...metaCompose.services.worker,volumes:[]}}},{metaEnabled:true}), /WORKER_META_SECRET_MOUNT_INVALID/);
});

test("rejects mutable images and unsafe or divergent OIDC endpoints", () => {
  assert.throws(() => validateEnvironment({...validEnv,ZAP_API_IMAGE:"ghcr.io/acme/api:latest"}), /NOT_IMMUTABLE/);
  assert.throws(() => validateEnvironment({...validEnv,OIDC_JWKS_URL:"http://id.example/jwks"}), /OIDC_JWKS_URL_INVALID/);
  assert.throws(() => validateEnvironment({...validEnv,OIDC_JWKS_URL:"https://other.example/jwks"}), /OIDC_ORIGIN_MISMATCH/);
  assert.throws(() => validateEnvironment(validEnv,{metaEnabled:true}), /META_GRAPH_API_VERSION_REQUIRED/);
  assert.throws(() => validateEnvironment({...validEnv,META_GRAPH_API_VERSION:"latest"},{metaEnabled:true}), /META_GRAPH_API_VERSION_INVALID/);
  assert.throws(() => validateEnvironment({...validEnv,
    OIDC_EMAIL_CLAIM:"https://clinicaprontomedic.online/claims/email"}), /PAIR_REQUIRED/);
  assert.throws(() => validateEnvironment({...validEnv,
    OIDC_EMAIL_CLAIM:"https://claims.example/email?source=profile",
    OIDC_EMAIL_VERIFIED_CLAIM:"https://clinicaprontomedic.online/claims/email_verified"}), /EMAIL_CLAIM_INVALID/);
  for (const [emailClaim, emailVerifiedClaim] of [
    ["email", "email_verified"],
    ["email", "https://clinicaprontomedic.online/claims/email_verified"],
    ["https://clinicaprontomedic.online/claims/email", "email_verified"],
  ]) {
    assert.throws(() => validateEnvironment({...validEnv,
      OIDC_EMAIL_CLAIM:emailClaim,OIDC_EMAIL_VERIFIED_CLAIM:emailVerifiedClaim}),
    /OIDC_EMAIL_(?:VERIFIED_)?CLAIM_INVALID/);
  }
});

test("binds source email claims exactly to the rendered API environment", () => {
  const expectedEmailClaims = {
    emailClaim:"https://clinicaprontomedic.online/claims/email",
    emailVerifiedClaim:"https://clinicaprontomedic.online/claims/email_verified",
  };
  const rendered = structuredClone(compose);
  Object.assign(rendered.services.api.environment, {
    OIDC_EMAIL_CLAIM:expectedEmailClaims.emailClaim,
    OIDC_EMAIL_VERIFIED_CLAIM:expectedEmailClaims.emailVerifiedClaim,
  });
  assert.doesNotThrow(() => validateComposeInvariants(rendered,{expectedEmailClaims}));
  assert.throws(() => validateComposeInvariants(compose,{expectedEmailClaims}), /OIDC_EMAIL_CLAIMS_RENDERED_MISMATCH/);
  assert.throws(() => validateComposeInvariants(rendered), /OIDC_EMAIL_CLAIMS_RENDERED_MISMATCH/);
  const mismatched = structuredClone(rendered);
  mismatched.services.api.environment.OIDC_EMAIL_VERIFIED_CLAIM =
    "https://clinicaprontomedic.online/claims/other_email_verified";
  assert.throws(() => validateComposeInvariants(mismatched,{expectedEmailClaims}),
    /OIDC_EMAIL_CLAIMS_RENDERED_MISMATCH/);
});

test("rejects missing resource guarantees and malformed or duplicate env entries", () => {
  assert.throws(() => validateResources({...compose,services:{...compose.services,api:{deploy:{resources:{limits:{cpus:"0.5",memory:"768M"}}}}}}), /API_RESOURCES/);
  assert.deepEqual(parseEnv("# staging\nOIDC_AUDIENCE=zap-pronto\n"), {OIDC_AUDIENCE:"zap-pronto"});
  assert.throws(() => parseEnv("A=1\nA=2\n"), /ENV_INVALID/);
});

test("fails closed on missing, malformed and non-finite resource limits for every service", () => {
  for (const serviceName of Object.keys(compose.services)) {
    const original = compose.services[serviceName].deploy.resources.limits;
    for (const limits of [undefined, {}, {...original, cpus: undefined}, {...original, memory: undefined},
      {...original, cpus: "invalid"}, {...original, cpus: Infinity}, {...original, cpus: true},
      {...original, memory: "invalid"}, {...original, memory: Infinity}, {...original, memory: true}]) {
      const candidate = structuredClone(compose);
      candidate.services[serviceName].deploy.resources.limits = limits;
      assert.throws(() => validateResources(candidate), /RESOURCES_BELOW_MINIMUM/, serviceName);
    }
  }
});

test("interprets rendered Compose memory as bytes and enforces the exact threshold", () => {
  for (const serviceName of Object.keys(compose.services)) {
    const candidate = structuredClone(compose);
    const limits = candidate.services[serviceName].deploy.resources.limits;
    const bytes = Number(limits.memory.slice(0, -1)) * 1048576;
    for (const value of [bytes, String(bytes)]) {
      limits.memory = value;
      assert.doesNotThrow(() => validateResources(candidate));
    }
    limits.memory = bytes - 1;
    assert.throws(() => validateResources(candidate), /RESOURCES_BELOW_MINIMUM/);
  }
});

test("requires canonical 0400 ownership for non-root container secret readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zap-preflight-"));
    const names = ["postgres", "migration", "runtime", "worker", "meta-app", "meta-verify"].map((name) => join(directory, name));
  try {
    for (const file of names) { writeFileSync(file, "not-read-by-preflight"); chmodSync(file, 0o600); }
    const env = { POSTGRES_PASSWORD_FILE:names[0], DATABASE_MIGRATION_URL_FILE:names[1], DATABASE_RUNTIME_URL_FILE:names[2], DATABASE_WORKER_URL_FILE:names[3] };
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
