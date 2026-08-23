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
// Long-lived SSE listeners must not consume the transactional API pool.
// Keep a bounded dedicated pool so saturation degrades to polling instead
// of starving authenticated requests.
const notificationPgPool = new pg.Pool({
  connectionString: runtime.databaseUrl,
  max: Math.max(1, Math.min(runtime.databasePoolMax, 8)),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const notificationPool: InboxNotificationPool = notificationPgPool;
const app = await buildApp({ pool, notificationPool, identityVerifier, metaWebhook: runtime.metaWebhook });
app.addHook("onClose", async () => { await Promise.all([pool.end(), notificationPgPool.end()]); });
await app.listen({ host: runtime.host, port: runtime.port });
