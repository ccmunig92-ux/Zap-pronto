import assert from "node:assert/strict";import test from "node:test";
import { claimInboundMaterializationEvents,processInboundClaim,runInboundWorker,type InboundWorkerOptions,type WorkerClient,type WorkerPool } from "./inbound-runner.js";
const options:InboundWorkerOptions={batchSize:1,leaseSeconds:60,pollIntervalMs:10_000,backoffSeconds:30};
const job={tenant_id:"10000000-0000-4000-8000-000000000001",outbox_id:"81000000-0000-4000-8000-000000000001",
  aggregate_id:"71000000-0000-4000-8000-000000000001",event_type:"channel.inbound.received",payload_version:1,
  lease_token:"91000000-0000-4000-8000-000000000001"};
function poolFor(handler:(text:string,values?:unknown[])=>Promise<{rows:unknown[]}>){
  const calls:{text:string;values?:unknown[]}[]=[];
  const client:WorkerClient={async query(text,values){calls.push({text,...(values?{values}: {})});return handler(text,values);},release(){}};
  const pool:WorkerPool={async connect(){return client;},async end(){}};return {pool,calls};
}
test("claims only through the narrow inbound function and validates its envelope",async()=>{
  const mock=poolFor(async text=>({rows:text.includes("claim_inbound")?[job]:[]}));
  assert.equal((await claimInboundMaterializationEvents(mock.pool,options)).length,1);
  assert.equal(mock.calls.some(call=>call.text.includes("claim_outbox_events(")),false);
  const invalid=poolFor(async text=>({rows:text.includes("claim_inbound")?[{...job,event_type:"unknown"}]:[]}));
  await assert.rejects(claimInboundMaterializationEvents(invalid.pool,options),/INBOUND_CLAIM_INVALID/);
});
test("materialization installs machine tenant context, relies on atomic ACK and never sends payload to SQL",async()=>{
  const mock=poolFor(async text=>({rows:text.includes("FROM materialize_inbound_channel_event")?[{contactId:"1",contactIdentityId:"2",
    conversationId:"3",messageId:"4",replayed:false}]:[]}));
  await processInboundClaim(mock.pool,job,options);
  assert.equal(mock.calls.filter(call=>call.text.includes("materialize_inbound_channel_event")).length,1);
  assert.equal(mock.calls.some(call=>call.text.includes("acknowledge_outbox_event")),false);
  assert.equal(mock.calls.some(call=>JSON.stringify(call.values??[]).includes("sender")),false);
  const context=mock.calls.find(call=>call.text.includes("app.tenant_id"));assert.equal(context?.values?.[0],job.tenant_id);
});
test("transient failure is persisted only as an allowlisted code",async()=>{
  const mock=poolFor(async text=>{if(text.includes("FROM materialize_inbound"))throw new Error("phone + body + sql secret");return {rows:[]};});
  await assert.rejects(processInboundClaim(mock.pool,job,options),/INBOUND_MATERIALIZATION_FAILED/);
  const failed=mock.calls.find(call=>call.text.includes("fail_inbound_materialization_event"));
  assert.equal(failed?.values?.[2],"INBOUND_MATERIALIZATION_FAILED");
  assert.doesNotMatch(JSON.stringify(failed?.values),/phone|body|secret/);
});
test("abort interrupts idle polling and prevents another claim",async()=>{
  const controller=new AbortController();let claims=0;
  const mock=poolFor(async text=>{if(text.includes("claim_inbound")){claims++;controller.abort();}return {rows:[]};});
  await runInboundWorker(mock.pool,{...options,pollIntervalMs:60_000},controller.signal);assert.equal(claims,1);
});
test("shutdown waits for the active materialization and starts no new claim",async()=>{
  const controller=new AbortController();let claims=0;let finish!:()=>void;
  const active=new Promise<void>(resolve=>{finish=resolve;});
  const mock=poolFor(async text=>{
    if(text.includes("claim_inbound")){claims++;return {rows:claims===1?[job]:[]};}
    if(text.includes("FROM materialize_inbound_channel_event")){controller.abort();await active;
      return {rows:[{contactId:"1",contactIdentityId:"2",conversationId:"3",messageId:"4",replayed:false}]};}
    return {rows:[]};
  });
  const running=runInboundWorker(mock.pool,options,controller.signal);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(claims,1);finish();await running;assert.equal(claims,1);
});
