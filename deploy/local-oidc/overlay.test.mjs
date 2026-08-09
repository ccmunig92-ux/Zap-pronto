import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const directory = new URL("./", import.meta.url);

test("realm local usa SPA publica com PKCE e redirects exatos", async () => {
  const realm = JSON.parse(await readFile(new URL("zap-pronto-local-realm.json", directory), "utf8"));
  const client = realm.clients.find((candidate) => candidate.clientId === "zap-pronto-local");

  assert.ok(client);
  assert.equal(realm.accessTokenLifespan, 30);
  assert.ok(realm.ssoSessionIdleTimeout > realm.accessTokenLifespan);
  assert.equal(client.publicClient, true);
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.implicitFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.serviceAccountsEnabled, false);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.deepEqual(client.redirectUris, ["${LOCAL_OIDC_ORIGIN}/"]);
  assert.deepEqual(client.webOrigins, ["${LOCAL_OIDC_ORIGIN}"]);
  assert.equal(JSON.stringify(client).includes("*"), false);
  assert.equal(realm.users.length, 2);
  for (const user of realm.users) {
    assert.match(user.email, /@example\.test$/);
    assert.match(user.credentials[0].value, /^\$\{LOCAL_OIDC_(ADMIN|ATTENDANT)_PASSWORD\}$/);
  }
});

test("edge preserva variaveis nginx e nunca registra query OAuth", async () => {
  const [compose, edge] = await Promise.all([
    readFile(new URL("compose.yaml", directory), "utf8"),
    readFile(new URL("edge.conf.template", directory), "utf8"),
  ]);

  assert.match(compose, /NGINX_ENVSUBST_FILTER: "\^\(LOCAL_OIDC_HOST\)\$"/);
  assert.match(compose, /127\.0\.0\.1:\$\{LOCAL_HTTPS_PORT:-18443\}:18443/);
  assert.match(compose, /GET \/health\/ready HTTP\/1\.1/);
  assert.match(compose, /\/dev\/tcp\/127\.0\.0\.1\/9000/);
  assert.match(edge, /log_format zap_local_safe/);
  assert.match(edge, /\$request_method \$uri \$server_protocol/);
  assert.doesNotMatch(edge, /\$request(?:\s|')|\$request_uri|\$args|\$http_referer/);
  assert.match(edge, /proxy_set_header Host \$host/);
});

test("seed local restaura contas sinteticas para ACTIVE de forma idempotente", async () => {
  const seed = await readFile(new URL("seed.sql", directory), "utf8");
  assert.match(seed, /status='ACTIVE',[\s\S]*blocked_at=NULL,revoked_at=NULL/);
});

test("controlador isola volumes pelo project name local fixo", async () => {
  const controller = await readFile(new URL("local-oidc.ps1", directory), "utf8");
  assert.match(controller, /\$projectName = 'zap-pronto-local-oidc'/);
  assert.match(controller, /'compose','--project-name',\$projectName/);
  assert.doesNotMatch(controller, /system\s+prune|volume\s+prune/);
});
