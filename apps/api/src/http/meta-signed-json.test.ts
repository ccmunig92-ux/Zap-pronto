import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { registerMetaSignedJsonBoundary } from "./meta-signed-json.js";

const secret = "segredo-sintético-ç";

function signature(body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function testApp(maxBodyBytes = 256) {
  const app = Fastify({ logger: false });
  app.post("/ordinary", async (request) => request.body);
  await registerMetaSignedJsonBoundary(app, { appSecret: secret, maxBodyBytes, async registerRoutes(scope) {
    scope.post("/meta", { bodyLimit: maxBodyBytes }, async (request) => ({ parsed: request.body }));
  } });
  return app;
}

test("fronteira Meta verifica bytes exatos antes de interpretar JSON", async () => {
  const app = await testApp();
  const rawBody = Buffer.from('{ "mensagem": "olá" }', "utf8");
  const valid = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json; charset=utf-8", "x-hub-signature-256": signature(rawBody),
  }, payload: rawBody });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { parsed: { mensagem: "olá" } });
  const reserialized = Buffer.from('{"mensagem":"olá"}', "utf8");
  const changed = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": signature(reserialized),
  }, payload: rawBody });
  assert.equal(changed.statusCode, 401);
  assert.match(changed.json().type, /meta-webhook-rejected/);
  assert.equal(changed.headers["cache-control"], "no-store");
  await app.close();
});

test("assinatura inválida ou duplicada falha uniformemente antes do JSON.parse", async () => {
  const app = await testApp();
  const malformed = Buffer.from("{not-json", "utf8");
  const invalid = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64),
  }, payload: malformed });
  assert.equal(invalid.statusCode, 401);
  assert.match(invalid.json().type, /meta-webhook-rejected/);
  const duplicated = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": [signature(malformed), signature(malformed)],
  }, payload: malformed });
  assert.equal(duplicated.statusCode, 401);
  assert.match(duplicated.json().type, /meta-webhook-rejected/);
  const signedInvalidJson = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": signature(malformed),
  }, payload: malformed });
  assert.equal(signedInvalidJson.statusCode, 400);
  assert.match(signedInvalidJson.json().type, /meta-webhook-invalid-json/);
  await app.close();
});

test("bodyLimit interrompe excesso e não altera o parser JSON das demais rotas", async () => {
  const app = await testApp(32);
  const atLimit = Buffer.from(JSON.stringify({ value: "x".repeat(20) }), "utf8");
  assert.equal(atLimit.byteLength, 32);
  const accepted = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": signature(atLimit),
  }, payload: atLimit });
  assert.equal(accepted.statusCode, 200);
  const overLimit = Buffer.concat([atLimit, Buffer.from(" ")]);
  const rejected = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": signature(overLimit),
  }, payload: overLimit });
  assert.equal(rejected.statusCode, 413);
  const ordinary = await app.inject({ method: "POST", url: "/ordinary", payload: { ordinary: true } });
  assert.equal(ordinary.statusCode, 200);
  assert.deepEqual(ordinary.json(), { ordinary: true });
  await app.close();
});

test("bodyLimit interrompe corpo chunked sem confiar em Content-Length", async () => {
  const app = await testApp(32);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const overLimit = Buffer.from(JSON.stringify({ value: "x".repeat(21) }), "utf8");
  const statusCode = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/meta", method: "POST", headers: {
      "content-type": "application/json", "transfer-encoding": "chunked",
      "x-hub-signature-256": signature(overLimit),
    } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.write(overLimit.subarray(0, 16));
    outgoing.end(overLimit.subarray(16));
  });
  assert.equal(statusCode, 413);
  await app.close();
});

test("respostas nunca refletem segredo, assinatura ou corpo", async () => {
  const app = await testApp();
  const rawBody = Buffer.from('{"patient":"sensitive-value"}', "utf8");
  const digest = signature(rawBody);
  const response = await app.inject({ method: "POST", url: "/meta", headers: {
    "content-type": "application/json", "x-hub-signature-256": digest,
  }, payload: Buffer.from('{"patient":"tampered"}', "utf8") });
  assert.equal(response.statusCode, 401);
  for (const forbidden of [secret, digest, "sensitive-value", "tampered"]) assert.doesNotMatch(response.body, new RegExp(forbidden));
  await app.close();
});
