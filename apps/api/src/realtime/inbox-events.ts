import type { FastifyReply, FastifyRequest } from "fastify";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const channel = "zap_pronto_inbox";
const heartbeatMs = 15_000;
const maximumLifetimeMs = 30 * 60_000;
const notificationConnectTimeoutMs = 5_000;
const maximumPendingEvents = 256;

export interface NotificationMessage {
  readonly name?: string;
  readonly channel?: string;
  readonly payload?: string;
}

export interface InboxNotificationConnection {
  query(text: string, values?: unknown[]): Promise<unknown>;
  on(event: "notification", listener: (message: NotificationMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "notification" | "error", listener: (...args: any[]) => void): this;
  release(error?: Error | boolean): void;
}

export interface InboxNotificationPool {
  connect(): Promise<InboxNotificationConnection>;
}

interface InboxEventsOptions {
  readonly notificationConnectTimeoutMs?: number;
}

interface EventPayload {
  readonly tenantId?: unknown;
  readonly unitId?: unknown;
  readonly kind?: unknown;
  readonly entityId?: unknown;
}

function parseEvent(payload: string | undefined): EventPayload | undefined {
  if (!payload || payload.length > 2048) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object") return undefined;
    return value as EventPayload;
  } catch {
    return undefined;
  }
}

function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function connectNotification(
  pool: InboxNotificationPool,
  timeoutMs: number,
): Promise<InboxNotificationConnection> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connection = pool.connect();
  return new Promise<InboxNotificationConnection>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("NOTIFICATION_CONNECT_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    void connection.then((value) => {
      if (timedOut) {
        try { value.release(); } catch { /* best effort for a late pool result */ }
        return;
      }
      if (timer) clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (timedOut) return;
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

async function tenantId(client: { query(text: string): Promise<unknown> }): Promise<string> {
  const result = await client.query("SELECT current_app_tenant_id() AS \"tenantId\"") as { rows?: Array<{ tenantId?: unknown }> };
  const value = result.rows?.[0]?.tenantId;
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("AUTH_UNAUTHORIZED");
  return value;
}

export function registerInboxEventsRoute(
  app: import("fastify").FastifyInstance,
  pool: TenantTransactionPool,
  notificationPool?: InboxNotificationPool,
  options: InboxEventsOptions = {},
): void {
  app.get("/v1/inbox/events", protectedRoute({
    pool,
    authorization: {
      kind: "permission",
      permission: "conversation.read",
      scope: { kind: "unit", resolveUnitId: async (_client, request) => {
        const value = (request.query as { unitId?: unknown }).unitId;
        if (typeof value !== "string" || !UUID.test(value)) throw new Error("INVALID_UNIT_ID");
        return value;
      } },
    },
    schema: { operationId: "streamInboxEvents", querystring: {
      type: "object", required: ["unitId"], additionalProperties: false,
      properties: { unitId: { type: "string", format: "uuid" } },
    } },
    handler: async (client, request, reply) => {
      if (!notificationPool) {
        return reply.status(503).type("application/problem+json").send({
          type: "urn:zap-pronto:error:realtime-unavailable", title: "Service Unavailable", status: 503,
          detail: "Realtime operacional não está configurado", correlationId: request.id,
        });
      }
      const requestedUnitId = (request.query as { unitId: string }).unitId;
      const scopedTenantId = await tenantId(client);
      let listener: InboxNotificationConnection;
      try {
        listener = await connectNotification(notificationPool,
          options.notificationConnectTimeoutMs ?? notificationConnectTimeoutMs);
      } catch {
        return reply.status(503).type("application/problem+json").send({
          type: "urn:zap-pronto:error:realtime-unavailable", title: "Service Unavailable", status: 503,
          detail: "Realtime operacional não está disponível", correlationId: request.id,
        });
      }
      const raw = reply.raw;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let streamReady = false;
      let listenerFailed = false;
      let clientClosedDuringListen = raw.destroyed || raw.writableEnded;
      const pendingEvents = new Map<string, { readonly kind: unknown; readonly entityId: unknown }>();
      const onNotification = (message: NotificationMessage) => {
        if (message.channel !== channel && message.name !== channel) return;
        const event = parseEvent(message.payload);
        if (!event || event.tenantId !== scopedTenantId || event.unitId !== requestedUnitId) return;
        const change = { kind: event.kind, entityId: event.entityId };
        if (!streamReady) {
          const key = `${String(change.kind)}\u0000${String(change.entityId)}`;
          if (pendingEvents.has(key)) pendingEvents.delete(key);
          else if (pendingEvents.size >= maximumPendingEvents) {
            const oldest = pendingEvents.keys().next().value;
            if (oldest !== undefined) pendingEvents.delete(oldest);
          }
          pendingEvents.set(key, change);
          return;
        }
        writeEvent(reply, "inbox-change", change);
      };
      const onError = () => {
        if (!streamReady) { listenerFailed = true; return; }
        if (closed) return;
        writeEvent(reply, "error", { retryable: true });
        cleanup();
        raw.end();
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        listener.removeListener("notification", onNotification);
        listener.removeListener("error", onError);
        void listener.query("UNLISTEN zap_pronto_inbox").catch(() => undefined).finally(() => listener.release());
      };
      const markClientClosedDuringListen = () => { clientClosedDuringListen = true; };
      raw.once("close", markClientClosedDuringListen);
      raw.once("error", markClientClosedDuringListen);
      listener.on("notification", onNotification);
      listener.on("error", onError);
      try {
        await listener.query("LISTEN zap_pronto_inbox");
      } catch {
        raw.removeListener("close", markClientClosedDuringListen);
        raw.removeListener("error", markClientClosedDuringListen);
        listener.removeListener("notification", onNotification);
        listener.removeListener("error", onError);
        listener.release();
        if (clientClosedDuringListen || raw.destroyed || raw.writableEnded) return undefined;
        return reply.status(503).type("application/problem+json").send({
          type: "urn:zap-pronto:error:realtime-unavailable", title: "Service Unavailable", status: 503,
          detail: "Realtime operacional não está disponível", correlationId: request.id,
        });
      }
      raw.once("close", cleanup);
      raw.once("error", cleanup);
      raw.removeListener("close", markClientClosedDuringListen);
      raw.removeListener("error", markClientClosedDuringListen);
      if (closed) return undefined;
      if (clientClosedDuringListen || raw.destroyed || raw.writableEnded) { cleanup(); return undefined; }
      if (listenerFailed) {
        cleanup();
        if (raw.destroyed || raw.writableEnded) return undefined;
        return reply.status(503).type("application/problem+json").send({
          type: "urn:zap-pronto:error:realtime-unavailable", title: "Service Unavailable", status: 503,
          detail: "Realtime operacional não está disponível", correlationId: request.id,
        });
      }
      reply.hijack();
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.write(": connected\n\n");
      streamReady = true;
      for (const pendingEvent of pendingEvents.values()) writeEvent(reply, "inbox-change", pendingEvent);
      pendingEvents.clear();
      heartbeat = setInterval(() => { if (!closed) raw.write(": heartbeat\n\n"); }, heartbeatMs);
      lifetime = setTimeout(() => { cleanup(); raw.end(); }, maximumLifetimeMs);
      return undefined;
    },
  }));
}
