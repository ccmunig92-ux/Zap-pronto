import assert from "node:assert/strict";
import test from "node:test";
import { loadOidcRuntimeConfig, probeOidcReadiness } from "./oidc-readiness.js";

const validEnv = { OIDC_ISSUER: "https://id.example/realms/zap", OIDC_AUDIENCE: "zap-pronto",
  OIDC_JWKS_URL: "https://id.example/realms/zap/keys", OIDC_ORGANIZATION_CLAIM: "org_id" };

test("OIDC config fails closed for missing or unsafe values", () => {
  assert.throws(() => loadOidcRuntimeConfig({}), /OIDC_ISSUER_REQUIRED/);
  assert.throws(() => loadOidcRuntimeConfig({ ...validEnv, OIDC_ISSUER: "http:\/\/id.example" }), /UNSAFE/);
  assert.throws(() => loadOidcRuntimeConfig({ ...validEnv, OIDC_JWKS_URL: "https:\/\/user:secret@id.example\/keys" }), /UNSAFE/);
  assert.throws(() => loadOidcRuntimeConfig({ ...validEnv, OIDC_AUDIENCE: "zap pronto" }), /AUDIENCE_FORMAT/);
  assert.throws(() => loadOidcRuntimeConfig({ ...validEnv, OIDC_ORGANIZATION_CLAIM: "bad claim" }), /CLAIM_FORMAT/);
});

test("OIDC config derives discovery from issuer path without changing canonical issuer", () => {
  assert.deepEqual(loadOidcRuntimeConfig(validEnv), { issuer: validEnv.OIDC_ISSUER,
    audience: validEnv.OIDC_AUDIENCE, jwksUrl: validEnv.OIDC_JWKS_URL,
    discoveryUrl: "https://id.example/realms/zap/.well-known/openid-configuration",
    organizationClaim: "org_id" });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("OIDC readiness validates exact discovery binding and a public signing key", async () => {
  const config = loadOidcRuntimeConfig(validEnv);
  const calls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    return url === config.discoveryUrl ? json({ issuer: config.issuer, jwks_uri: config.jwksUrl })
      : json({ keys: [{ kty: "RSA", kid: "current", use: "sig", n: "abc", e: "AQAB" }] });
  };
  await probeOidcReadiness(config, { fetch: fetchMock });
  assert.deepEqual(calls, [config.discoveryUrl, config.jwksUrl]);
});

test("OIDC readiness rejects issuer/JWKS mismatch, redirect-like HTTP failure and private keys", async () => {
  const config = loadOidcRuntimeConfig(validEnv);
  await assert.rejects(probeOidcReadiness(config, { fetch: async () => json({ issuer: "https://evil.example",
    jwks_uri: config.jwksUrl }) }), /ISSUER_MISMATCH/);
  await assert.rejects(probeOidcReadiness(config, { fetch: async () => json({}, 302) }), /HTTP_302/);
  let call = 0;
  await assert.rejects(probeOidcReadiness(config, { fetch: async () => ++call === 1
    ? json({ issuer: config.issuer, jwks_uri: config.jwksUrl })
    : json({ keys: [{ kty: "RSA", kid: "leaked", d: "private" }] }) }), /NO_SIGNING_KEYS/);
});
