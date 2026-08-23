import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "./client.js";

test("inbox realtime sends Bearer, parses split SSE frames and ignores heartbeats", async () => {
  let request: Request | undefined;
  const chunks = [": connected\n\n", "event: inbox-change\ndata: {\"kind\":\"messages\",", "\"entityId\":\"60000000-0000-4000-8000-000000000001\"}\n\n"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
  });
  const events: unknown[] = [];
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async input => { request = input; return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }); } });
  await client.subscribeInboxEvents("33333333-3333-4333-8333-333333333333", new AbortController().signal, event => events.push(event));
  assert.equal(request?.headers.get("authorization"), "Bearer token");
  assert.equal(request?.headers.get("accept"), "text/event-stream");
  assert.equal(new URL(request!.url).searchParams.get("unitId"), "33333333-3333-4333-8333-333333333333");
  assert.deepEqual(events, [{ kind: "messages", entityId: "60000000-0000-4000-8000-000000000001" }]);
});

test("inbox realtime abort cancels the reader instead of leaving a stream open", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")); },
    cancel() { cancelled = true; },
  });
  const client = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "token",
    fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }) });
  const controller = new AbortController();
  const pending = client.subscribeInboxEvents("33333333-3333-4333-8333-333333333333", controller.signal, () => undefined);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await pending;
  assert.equal(cancelled, true);
});
