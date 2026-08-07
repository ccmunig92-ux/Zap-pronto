import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOidcIdentityVerifier } from "./oidc-verifier.js";
import { IdentityTokenRejectedError } from "./errors.js";

test("OIDC verifier validates signature, issuer, audience, subject and organization claim", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "RS256" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const issuer = "https://identity.example.test";
    const verifier = createOidcIdentityVerifier({ issuer, audience: "zap-pronto",
      jwksUrl: `http://127.0.0.1:${address.port}/jwks`, organizationClaim: "org_id" });
    const token = await new SignJWT({ org_id: "tenant-a", email: "Person@Example.Test", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer).setAudience("zap-pronto").setSubject("subject-1").setExpirationTime("5m").sign(privateKey);
    assert.deepEqual(await verifier.verifyBearer(token), { issuer, audience: "zap-pronto", subject: "subject-1",
      verifiedEmail: "person@example.test",
      organization: { claim: "org_id", value: "tenant-a" } });
    const wrongAudience = await new SignJWT({ org_id: "tenant-a" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience("other")
      .setSubject("subject-1").setExpirationTime("5m").sign(privateKey);
    await assert.rejects(verifier.verifyBearer(wrongAudience), IdentityTokenRejectedError);
    const noExpiration = await new SignJWT({ org_id: "tenant-a" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience("zap-pronto")
      .setSubject("subject-1").sign(privateKey);
    await assert.rejects(verifier.verifyBearer(noExpiration), IdentityTokenRejectedError);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
