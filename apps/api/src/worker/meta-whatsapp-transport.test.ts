import assert from "node:assert/strict";
import test from "node:test";
import { createMetaWhatsAppTransport, createFileSecretResolver, loadMetaWhatsAppTransportConfig } from "./meta-whatsapp-transport.js";

const input={tenantId:"10000000-0000-4000-8000-000000000001",messageId:"30000000-0000-4000-8000-000000000001",
  channelConnectionId:"40000000-0000-4000-8000-000000000001",channelAccountId:"997041050169954",
  recipientExternalId:"5511999999999",secretReference:"meta-access-token",body:"Olá",sessionOpen:true};
const config={graphApiVersion:"v23.0",timeoutMs:500};
const resolver={resolve:async()=>"token-not-real"};

test("Meta transport sends only the canonical WhatsApp text payload and returns provider id",async()=>{
  let request:Request|undefined;
  const transport=createMetaWhatsAppTransport(config,{fetch:async(input,init)=>{
    request=new Request(String(input),init);return Response.json({messages:[{id:"wamid.test.1"}]});
  },secretResolver:resolver});
  assert.deepEqual(await transport.sendText(input,new AbortController().signal),{externalMessageId:"wamid.test.1"});
  assert.equal(request?.url,"https://graph.facebook.com/v23.0/997041050169954/messages");
  assert.equal(request?.method,"POST");assert.equal(request?.headers.get("authorization"),"Bearer token-not-real");
  assert.deepEqual(await request?.json(),{messaging_product:"whatsapp",to:"5511999999999",type:"text",text:{body:"Olá",preview_url:false}});
});

test("Meta transport fails closed for invalid channel data and provider errors",async()=>{
  const transport=createMetaWhatsAppTransport(config,{fetch:async()=>new Response("provider-secret",{status:500}),secretResolver:resolver});
  await assert.rejects(transport.sendText({...input,channelAccountId:"local-e2e-account"},new AbortController().signal),/META_WHATSAPP_PHONE_NUMBER_ID_INVALID/);
  await assert.rejects(transport.sendText(input,new AbortController().signal),/META_WHATSAPP_HTTP_500/);
});

test("Meta transport never sends free-form text after the customer-service window",async()=>{
  let called=false;
  const transport=createMetaWhatsAppTransport(config,{fetch:async()=>{called=true;return Response.json({messages:[{id:"wamid.must-not-send"}]})},secretResolver:resolver});
  await assert.rejects(transport.sendText({...input,sessionOpen:false},new AbortController().signal),/META_WHATSAPP_TEMPLATE_REQUIRED/);
  assert.equal(called,false);
});

test("Meta transport sends an approved template when the customer-service window is closed",async()=>{
  let request:Request|undefined;
  const transport=createMetaWhatsAppTransport(config,{fetch:async(input,init)=>{
    request=new Request(String(input),init);return Response.json({messages:[{id:"wamid.template.1"}]});
  },secretResolver:resolver});
  const template={name:"appointment_reminder",languageCode:"pt_BR",components:[{type:"body",parameters:[{type:"text",text:"08:00"}]}]};
  assert.deepEqual(await transport.sendText({...input,sessionOpen:false,template},new AbortController().signal),{externalMessageId:"wamid.template.1"});
  assert.deepEqual(await request?.json(),{messaging_product:"whatsapp",to:"5511999999999",type:"template",
    template:{name:"appointment_reminder",language:{code:"pt_BR"},components:template.components}});
});

test("Meta transport rejects malformed template data before calling Graph",async()=>{
  let called=false;
  const transport=createMetaWhatsAppTransport(config,{fetch:async()=>{called=true;return Response.json({messages:[{id:"wamid.must-not-send"}]})},secretResolver:resolver});
  await assert.rejects(transport.sendText({...input,sessionOpen:false,template:{name:"Bad Name",languageCode:"pt_BR",components:[]}},new AbortController().signal),/META_WHATSAPP_TEMPLATE_INVALID/);
  assert.equal(called,false);
});

test("Meta config requires only version; token is resolved per connection",async()=>{
  await assert.rejects(loadMetaWhatsAppTransportConfig({}),/META_GRAPH_API_VERSION_INVALID/);
  assert.equal((await loadMetaWhatsAppTransportConfig({META_GRAPH_API_VERSION:"v23.0"})).graphApiVersion,"v23.0");
});

test("Meta transport propagates cancellation without exposing request data",async()=>{
  const controller=new AbortController();
  const transport=createMetaWhatsAppTransport(config,{fetch:async(_input,init)=>new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
  }),secretResolver:resolver});
  const pending=transport.sendText(input,controller.signal);controller.abort();
  await assert.rejects(pending,/META_WHATSAPP_ABORTED/);
});

test("file resolver rejects traversal and invalid tenant/connection scope",async()=>{
  const fileResolver=createFileSecretResolver("C:/secrets/zap-pronto");
  await assert.rejects(fileResolver.resolve({tenantId:"bad",channelConnectionId:input.channelConnectionId,secretReference:"meta"}),/REFERENCE_INVALID/);
  await assert.rejects(fileResolver.resolve({tenantId:input.tenantId,channelConnectionId:input.channelConnectionId,secretReference:"../other"}),/REFERENCE_INVALID/);
});
