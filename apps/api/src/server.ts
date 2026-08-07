import { buildApp } from "./app.js";
import pg from "pg";
import { createOidcIdentityVerifier } from "./auth/oidc-verifier.js";
import { loadOidcRuntimeConfig } from "./auth/oidc-readiness.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const oidc = loadOidcRuntimeConfig();
const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
const identityVerifier = createOidcIdentityVerifier(oidc);
const app = await buildApp({ pool, identityVerifier });
app.addHook("onClose", async () => { await pool.end(); });
await app.listen({ host: process.env.API_HOST ?? "127.0.0.1", port: Number(process.env.API_PORT ?? 3000) });
