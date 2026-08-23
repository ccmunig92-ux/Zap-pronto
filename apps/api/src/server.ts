import { buildApp } from "./app.js";
import type { InboxNotificationPool } from "./realtime/inbox-events.js";
import pg from "pg";
import { createOidcIdentityVerifier } from "./auth/oidc-verifier.js";
import { loadOidcRuntimeConfig } from "./auth/oidc-readiness.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";

const runtime = loadApiRuntimeConfig();
const oidc = loadOidcRuntimeConfig();
const pool = new pg.Pool({
  connectionString: runtime.databaseUrl,
  max: runtime.databasePoolMax,
  connectionTimeoutMillis: 5_000,
});
const identityVerifier = createOidcIdentityVerifier(oidc);
const notificationPool = pool as unknown as InboxNotificationPool;
const app = await buildApp({ pool, notificationPool, identityVerifier, metaWebhook: runtime.metaWebhook });
app.addHook("onClose", async () => { await pool.end(); });
await app.listen({ host: runtime.host, port: runtime.port });
