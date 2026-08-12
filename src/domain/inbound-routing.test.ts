import assert from"node:assert/strict";import test from"node:test";import{listRoutingRequired,resolveRoutingRequired}from"./inbound-routing.js";
test("routing list exposes only safe projection and creates a canonical cursor",async()=>{const calls:unknown[][]=[];
  const client={async query(_text:string,values?:unknown[]){calls.push(values??[]);return{rows:[{receipt_id:"10000000-0000-4000-8000-000000000001",
    channel_connection_id:"20000000-0000-4000-8000-000000000001",provider:"META_WHATSAPP",kind:"TEXT",
    occurred_at:new Date("2026-08-10T10:00:00.000Z"),received_at:new Date("2026-08-10T10:00:01.000Z"),eligible_units:[]}]};}};
  const page=await listRoutingRequired(client,{limit:1});assert.equal(page.items[0]?.allowedActions.length,0);
  assert.equal(JSON.stringify(page).includes("sender"),false);assert.deepEqual(calls[0],[2,null,null]);});
test("routing resolution derives fingerprint and sends only receipt unit and key",async()=>{let values:unknown[]=[];
  const client={async query(_text:string,input?:unknown[]){values=input??[];return{rows:[{receiptId:"10000000-0000-4000-8000-000000000001",
    unitId:"30000000-0000-4000-8000-000000000001",outboxId:"40000000-0000-4000-8000-000000000001",replayed:false}]};}};
  await resolveRoutingRequired(client,{receiptId:"10000000-0000-4000-8000-000000000001",
    unitId:"30000000-0000-4000-8000-000000000001",idempotencyKey:"routing-command"});
  assert.equal(values.length,4);assert.match(String(values[3]),/^[0-9a-f]{64}$/);});
