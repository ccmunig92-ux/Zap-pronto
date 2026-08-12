import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { buildApp } from "../app.js";
import { getRegisteredRoutePolicies } from "../auth/plugin.js";

const appSecret="synthetic-app-secret";const verifyToken="synthetic-verify-token";
const options={enabled:true,appSecret,verifyToken,maxBodyBytes:4096} as const;
const callback={entry:[{changes:[{value:{metadata:{phone_number_id:"account-b"},statuses:[{id:"wamid.outbound",status:"delivered",timestamp:"1786381200",recipient_id:"recipient"}],messages:[
  {id:"wamid.http",from:"sender-private",timestamp:"1786381200",type:"text",text:{body:"conteúdo privado"}},
  {id:"ignored",type:"reaction"},
]}}]}]};

function signed(body:Buffer){return `sha256=${createHmac("sha256",appSecret).update(body).digest("hex")}`;}

function inboundPool(settings:{failPersist?:boolean;failCommit?:boolean}={}):{pool:TenantTransactionPool;queries:string[];persisted:()=>number;reconciled:()=>number}{
  const queries:string[]=[];let persisted=0,reconciled=0;
  return {queries,persisted:()=>persisted,reconciled:()=>reconciled,pool:{async connect(){return {release(){},async query(sql){
    const compact=sql.replace(/\s+/g," ").trim();queries.push(compact);
    if(sql.includes("resolve_inbound_channel_binding"))return {rowCount:1,rows:[{tenantId:"50000000-0000-4000-8000-000000000002",
      channelConnectionId:"51000000-0000-4000-8000-000000000002",unitId:"55000000-0000-4000-8000-000000000002",
      routingStatus:"ROUTED",routingReason:null}]};
    if(sql.includes("persist_inbound_channel_event")){
      if(settings.failPersist)throw new Error("private database failure");persisted+=1;
      return {rowCount:1,rows:[{id:"91000000-0000-4000-8000-000000000001",
        tenantId:"50000000-0000-4000-8000-000000000002",unitId:"55000000-0000-4000-8000-000000000002",
        channelConnectionId:"51000000-0000-4000-8000-000000000002",routingStatus:"ROUTED",routingReason:null,replayed:false}]};
    }
    if(sql.includes("reconcile_meta_delivery_status")){if(settings.failPersist)throw new Error("private status database failure");reconciled+=1;return{rowCount:1,rows:[{receiptId:"92000000-0000-4000-8000-000000000001",applicationId:"93000000-0000-4000-8000-000000000001",messageId:null,outcome:"UNMATCHED",previousStatus:null,resultStatus:null,candidateCount:0,replayed:false}]};}
    if(sql==="COMMIT"&&settings.failCommit)throw new Error("private commit failure");
    return {rowCount:null,rows:[]};
  }};}}};
}

test("GET Meta verifica query escalar, não exige HMAC e não cria HEAD",async()=>{
  const database=inboundPool();const app=await buildApp({pool:database.pool,metaWebhook:options});
  await app.ready();
  const webhookPath=app.swagger().paths?.["/v1/webhooks/meta"];
  assert.deepEqual(Object.keys(webhookPath??{}).sort(),["get","post"]);
  assert.deepEqual(webhookPath?.get?.security,[]);assert.deepEqual(webhookPath?.post?.security,[]);
  assert.deepEqual(getRegisteredRoutePolicies(app).filter(policy=>policy.url==="/v1/webhooks/meta")
    .map(policy=>[policy.method,policy.policy]).sort(),[["GET","public"],["POST","public"]]);
  const success=await app.inject({method:"GET",url:"/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token="+
    encodeURIComponent(verifyToken)+"&hub.challenge=challenge-123"});
  assert.equal(success.statusCode,200);assert.equal(success.body,"challenge-123");
  assert.match(String(success.headers["content-type"]),/^text\/plain/);assert.equal(success.headers["cache-control"],"no-store");
  for(const url of [
    "/v1/webhooks/meta?hub.mode=wrong&hub.verify_token="+verifyToken+"&hub.challenge=x",
    "/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x",
    "/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token="+verifyToken+"&hub.challenge=x&hub.challenge=y",
    "/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token="+verifyToken,
  ]){const rejected=await app.inject({method:"GET",url});assert.equal(rejected.statusCode,403);
    assert.equal(rejected.headers["cache-control"],"no-store");assert.doesNotMatch(rejected.body,/synthetic-verify-token/);}
  assert.equal((await app.inject({method:"HEAD",url:"/v1/webhooks/meta"})).statusCode,401);
  await app.close();
});

test("POST Meta preserva raw bytes, UTF-8 e persiste somente mensagens de callback mixed",async()=>{
  const database=inboundPool();const app=await buildApp({pool:database.pool,metaWebhook:options});
  const raw=Buffer.from(JSON.stringify(callback,null,2),"utf8");
  const response=await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json; charset=utf-8",
    "x-hub-signature-256":signed(raw)},payload:raw});
  assert.equal(response.statusCode,200);assert.equal(response.body,"OK");assert.equal(database.persisted(),1);
  assert.equal(database.reconciled(),1);
  const inboundIndex=database.queries.findIndex(query=>query.includes("persist_inbound_channel_event"));
  assert.ok(database.queries.findIndex((query,index)=>index>inboundIndex&&query==="COMMIT")>inboundIndex);
  assert.equal(response.headers["cache-control"],"no-store");
  const replay=await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
    "x-hub-signature-256":signed(raw)},payload:raw});
  assert.equal(replay.statusCode,200);assert.equal(replay.body,"OK");
  await app.close();
});

test("POST Meta autentica antes do parse e sanitiza 401, 400, 413 e 415",async()=>{
  const database=inboundPool();const app=await buildApp({pool:database.pool,metaWebhook:{...options,maxBodyBytes:256}});
  const raw=Buffer.from('{ "texto": "olá" }',"utf8");
  const cases=[
    await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json"},payload:raw}),
    await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
      "x-hub-signature-256":[signed(raw),signed(raw)]},payload:raw}),
    await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
      "x-hub-signature-256":signed(Buffer.from('{}'))},payload:raw}),
  ];
  assert.deepEqual(cases.map(item=>item.statusCode),[401,401,401]);
  const invalidJson=Buffer.from("{invalid","utf8");
  assert.equal((await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
    "x-hub-signature-256":signed(invalidJson)},payload:invalidJson})).statusCode,400);
  const invalidCallback=Buffer.from("{}","utf8");
  assert.equal((await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
    "x-hub-signature-256":signed(invalidCallback)},payload:invalidCallback})).statusCode,400);
  const oversized=Buffer.alloc(257,0x20);
  assert.equal((await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
    "x-hub-signature-256":signed(oversized)},payload:oversized})).statusCode,413);
  assert.equal((await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"text/plain",
    "x-hub-signature-256":signed(raw)},payload:raw})).statusCode,415);
  for(const response of cases)assert.doesNotMatch(response.body,/synthetic|olá|texto/);
  await app.close();
});

test("status-only autêntico persiste e tipo de mensagem não suportado recebe ACK",async()=>{
  const database=inboundPool();const app=await buildApp({pool:database.pool,metaWebhook:options});
  for(const payload of [{entry:[{changes:[{value:{metadata:{phone_number_id:"account"},statuses:[{id:"one",status:"sent",timestamp:"1786381200"},{id:"two",status:"read",timestamp:"1786381201"}]}}]}]},
    {entry:[{changes:[{value:{metadata:{phone_number_id:"account"},messages:[{type:"reaction",id:"ignored"}]}}]}]}]){
    const raw=Buffer.from(JSON.stringify(payload));const response=await app.inject({method:"POST",url:"/v1/webhooks/meta",
      headers:{"content-type":"application/json","x-hub-signature-256":signed(raw)},payload:raw});
    assert.equal(response.statusCode,200);assert.equal(response.body,"OK");
  }
  assert.equal(database.reconciled(),2);assert.equal(database.persisted(),0);await app.close();
});

test("falha de persistência ou commit retorna 503 sem ACK nem detalhes",async()=>{
  for(const settings of [{failPersist:true},{failCommit:true}]){
    const database=inboundPool(settings);const app=await buildApp({pool:database.pool,metaWebhook:options});
    const raw=Buffer.from(JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:"account-b"},
      messages:[{id:"wamid.http",from:"sender-private",timestamp:"1786381200",type:"text",
        text:{body:"conteúdo privado"}}]}}]}]}));
    const response=await app.inject({method:"POST",url:"/v1/webhooks/meta",headers:{"content-type":"application/json",
      "x-hub-signature-256":signed(raw)},payload:raw});
    assert.equal(response.statusCode,503);assert.doesNotMatch(response.body,/private|conteúdo|sender-private|synthetic-app-secret/);
    await app.close();
  }
});

test("webhook desativado por padrão não registra rota pública",async()=>{
  const app=await buildApp();assert.equal((await app.inject({method:"GET",url:"/v1/webhooks/meta"})).statusCode,401);
  await app.close();
});
