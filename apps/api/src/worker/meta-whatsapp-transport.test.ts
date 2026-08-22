import assert from "node:assert/strict";
import test from "node:test";
import { createMetaWhatsAppTransport, loadMetaWhatsAppTransportConfig } from "./meta-whatsapp-transport.js";

const input={tenantId:"10000000-0000-4000-8000-000000000001",messageId:"30000000-0000-4000-8000-000000000001",
  channelConnectionId:"40000000-0000-4000-8000-000000000001",channelAccountId:"997041050169954",
  recipientExternalId:"5511999999999",body:"Olá"};
const config={accessToken:"token-not-real",graphApiVersion:"v23.0",timeoutMs:500};

test("Meta transport sends only the canonical WhatsApp text payload and returns provider id",async()=>{
  let request:Request|undefined;
  const transport=createMetaWhatsAppTransport(config,{fetch:async(input,init)=>{
    request=new Request(String(input),init);return Response.json({messages:[{id:"wamid.test.1"}]});
  }});
  assert.deepEqual(await transport.sendText(input,new AbortController().signal),{externalMessageId:"wamid.test.1"});
  assert.equal(request?.url,"https://graph.facebook.com/v23.0/997041050169954/messages");
  assert.equal(request?.method,"POST");assert.equal(request?.headers.get("authorization"),"Bearer token-not-real");
  assert.deepEqual(await request?.json(),{messaging_product:"whatsapp",to:"5511999999999",type:"text",text:{body:"Olá",preview_url:false}});
});

test("Meta transport fails closed for invalid channel data and provider errors",async()=>{
  const transport=createMetaWhatsAppTransport(config,{fetch:async()=>new Response("provider-secret",{status:500})});
  await assert.rejects(transport.sendText({...input,channelAccountId:"local-e2e-account"},new AbortController().signal),/META_WHATSAPP_PHONE_NUMBER_ID_INVALID/);
  await assert.rejects(transport.sendText(input,new AbortController().signal),/META_WHATSAPP_HTTP_500/);
});

test("Meta config requires version and token, with direct/file source exclusion",async()=>{
  await assert.rejects(loadMetaWhatsAppTransportConfig({}),/META_GRAPH_API_VERSION_INVALID/);
  await assert.rejects(loadMetaWhatsAppTransportConfig({META_GRAPH_API_VERSION:"v23.0"}),/META_WHATSAPP_ACCESS_TOKEN_INVALID/);
  await assert.rejects(loadMetaWhatsAppTransportConfig({META_GRAPH_API_VERSION:"v23.0",META_WHATSAPP_ACCESS_TOKEN:"a",META_WHATSAPP_ACCESS_TOKEN_FILE:"b"}),/META_WHATSAPP_ACCESS_TOKEN_SOURCE_CONFLICT/);
  assert.equal((await loadMetaWhatsAppTransportConfig({META_GRAPH_API_VERSION:"v23.0",META_WHATSAPP_ACCESS_TOKEN:"a"})).graphApiVersion,"v23.0");
});

test("Meta transport propagates cancellation without exposing request data",async()=>{
  const controller=new AbortController();
  const transport=createMetaWhatsAppTransport(config,{fetch:async(_input,init)=>new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
  })});
  const pending=transport.sendText(input,controller.signal);controller.abort();
  await assert.rejects(pending,/META_WHATSAPP_ABORTED/);
});
