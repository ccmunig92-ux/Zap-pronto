import assert from "node:assert/strict";
import test from "node:test";
import {claimOutboundTextEvents,processOutboundClaim,runOutboundWorker,type OutboundTransport} from "./outbound-runner.js";

const job={tenant_id:"10000000-0000-4000-8000-000000000001",outbox_id:"20000000-0000-4000-8000-000000000001",
  message_id:"30000000-0000-4000-8000-000000000001",channel_connection_id:"40000000-0000-4000-8000-000000000001",
  channel_account_id:"phone-account",secret_reference:"meta-access-token",recipient_external_id:"5511999999999",body:"Mensagem segura",session_open:true,
  event_type:"channel.outbound.requested",payload_version:1,lease_token:"50000000-0000-4000-8000-000000000001"};
const options={batchSize:10,leaseSeconds:60,pollIntervalMs:5,backoffSeconds:30};
function poolFor(handler:(text:string,values?:unknown[])=>Promise<{rows:unknown[]}>|{rows:unknown[]}){
  const calls:{text:string;values?:unknown[]}[]=[];
  return{calls,pool:{async connect(){return{async query(text:string,values?:unknown[]){calls.push(values?{text,values}:{text});return handler(text,values)},release(){}}}}};
}

test("claim uses only the narrow outbound function and rejects malformed rows",async()=>{
  const valid=poolFor(text=>({rows:text.includes("claim_outbound_delivery_events")?[job]:[]}));
  assert.equal((await claimOutboundTextEvents(valid.pool,options)).length,1);
  assert.equal(valid.calls.some(call=>call.text.includes("claim_outbox_events(")),false);
  const invalid=poolFor(text=>({rows:text.includes("claim_outbound_delivery_events")?[{...job,body:" bad\u0000"}]:[]}));
  await assert.rejects(claimOutboundTextEvents(invalid.pool,options),/OUTBOUND_CLAIM_INVALID/);
});

test("successful transport result is the only path that finalizes",async()=>{
  const mock=poolFor(text=>({rows:text.includes("finalize_outbound_delivery_event")?[{finalize_outbound_delivery_event:true}]:[]}));
  const transport:OutboundTransport={async sendText(input){assert.equal(input.body,job.body);return{externalMessageId:"wamid.real-result"}}};
  await processOutboundClaim(mock.pool,job,options,transport,new AbortController().signal);
  const final=mock.calls.find(call=>call.text.includes("finalize_outbound_delivery_event"));
  assert.deepEqual(final?.values,[job.outbox_id,job.lease_token,"wamid.real-result"]);
  assert.equal(mock.calls.some(call=>call.text.includes("fail_outbound_delivery_event")),false);
});

test("invalid or failed transport never finalizes and fails with a sanitized code",async()=>{
  for(const transport of [
    {async sendText(){return{externalMessageId:"  "}}},
    {async sendText(){throw new Error("phone body provider-secret")}}
  ] satisfies OutboundTransport[]){
    const mock=poolFor(()=>({rows:[{fail_outbound_text_event:"PENDING"}]}));
    await assert.rejects(processOutboundClaim(mock.pool,job,options,transport,new AbortController().signal),/OUTBOUND_DELIVERY_FAILED/);
    assert.equal(mock.calls.some(call=>call.text.includes("finalize_outbound_delivery_event")),false);
    const failed=mock.calls.find(call=>call.text.includes("fail_outbound_delivery_event"));
    assert.deepEqual(failed?.values,[job.outbox_id,job.lease_token,"OUTBOUND_TRANSPORT_FAILED",30]);
    assert.doesNotMatch(JSON.stringify(failed),/phone body provider-secret/);
  }
});

test("abort before processing performs no transport or database mutation",async()=>{
  let sends=0;const mock=poolFor(()=>({rows:[]}));const controller=new AbortController();controller.abort();
  await processOutboundClaim(mock.pool,job,options,{async sendText(){sends++;return{externalMessageId:"wamid.never"}}},controller.signal);
  assert.equal(sends,0);assert.equal(mock.calls.length,0);
  await runOutboundWorker(mock.pool,options,{async sendText(){throw new Error("never")}},controller.signal);
  assert.equal(mock.calls.length,0);
});

test("idle worker wakes and shuts down on abort",async()=>{
  const mock=poolFor(text=>({rows:text.includes("claim_outbound_delivery_events")?[]:[]}));
  const controller=new AbortController();const running=runOutboundWorker(mock.pool,{...options,pollIntervalMs:10_000},
    {async sendText(){throw new Error("never")}},controller.signal);
  await new Promise(resolve=>setTimeout(resolve,5));controller.abort();await running;
  assert.equal(mock.calls.filter(call=>call.text.includes("claim_outbound_delivery_events")).length,1);
});
