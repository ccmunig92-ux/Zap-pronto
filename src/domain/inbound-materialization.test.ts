import assert from "node:assert/strict";
import test from "node:test";
import { materializeInboundChannelEvent } from "./inbound-materialization.js";

test("comando de materialização envia somente outbox e lease ao banco",async()=>{
  const queries:unknown[][]=[];const client={query:async(sql:string,values:unknown[]=[])=>{queries.push([sql,values]);
    return {rowCount:1,rows:[{contactId:"1",contactIdentityId:"2",conversationId:"3",messageId:"4",replayed:false}]};}};
  const outbox="81000000-0000-4000-8000-000000000001",lease="97000000-0000-4000-8000-000000000001";
  assert.equal((await materializeInboundChannelEvent(client,outbox,lease)).messageId,"4");
  assert.deepEqual(queries[0]?.[1],[outbox,lease]);
  await assert.rejects(materializeInboundChannelEvent(client,"invalid",lease),/INVALID_INBOUND_MATERIALIZATION_REQUEST/);
});
