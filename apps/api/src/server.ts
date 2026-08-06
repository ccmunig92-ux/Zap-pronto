import { buildApp } from "./app.js";
import pg from "pg";
import { createOidcIdentityVerifier } from "./auth/oidc-verifier.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const oidcIssuer = process.env.OIDC_ISSUER;
const oidcAudience = process.env.OIDC_AUDIENCE;
const oidcJwksUrl = process.env.OIDC_JWKS_URL;
if (!oidcIssuer || !oidcAudience || !oidcJwksUrl) throw new Error("OIDC_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
const identityVerifier = createOidcIdentityVerifier({ issuer: oidcIssuer, audience: oidcAudience,
  jwksUrl: oidcJwksUrl, ...(process.env.OIDC_ORGANIZATION_CLAIM
    ? { organizationClaim: process.env.OIDC_ORGANIZATION_CLAIM } : {}) });
const app = await buildApp({ pool, identityVerifier });
app.addHook("onClose", async () => { await pool.end(); });
await app.listen({ host: process.env.API_HOST ?? "127.0.0.1", port: Number(process.env.API_PORT ?? 3000) });
