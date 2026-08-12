import assert from "node:assert/strict";
import test from "node:test";
import { classifyMetaCallback, META_CALLBACK_LIMITS } from "./meta-callback.js";

const textMessage={id:"wamid.callback",from:"sender",timestamp:"1786381200",type:"text",text:{body:"Olá"}};

test("classifica status-only e mixed sem transformar status em mensagem",()=>{
  const status={id:"wamid.status-1",status:"delivered",timestamp:"1786381200",recipient_id:"recipient",errors:[{code:131047,title:"not stored"}]};
  const only=classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},statuses:[status]}}]}]});
  assert.equal(only.messages.length,0);assert.equal(only.statusCount,1);assert.equal(only.statuses[0]?.normalizedStatus,"DELIVERED");assert.deepEqual(only.statuses[0]?.errorCodes,[131047]);
  const mixed=classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},
    statuses:[status],messages:[textMessage,{id:"unsupported",type:"reaction"}]}}]}]});
  assert.equal(mixed.messages.length,1);assert.equal(mixed.statuses.length,1);assert.equal(mixed.statusCount,1);assert.equal(mixed.ignoredCount,1);
});

test("normaliza statuses conhecidos e sanitiza unknown sem persistir detalhes",()=>{const statuses=["sent","delivered","read","failed","future_state"].map((status,index)=>({id:`wamid.${index}`,status,timestamp:String(1786381200+index)}));
  const result=classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},statuses}}]}]});
  assert.deepEqual(result.statuses.map(item=>[item.providerStatus,item.normalizedStatus]),[["sent","SENT"],["delivered","DELIVERED"],["read","READ"],["failed","FAILED"],["unknown",null]]);});

test("mantém timestamp futuro estruturalmente válido para a guarda persistente",()=>{const seconds=Math.floor(Date.now()/1000)+20*60;
  const result=classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},statuses:[{id:"wamid.future",status:"read",timestamp:String(seconds)}]}}]}]});
  assert.equal(result.statuses[0]?.occurredAt,new Date(seconds*1000).toISOString());});

test("rejeita shape estrutural inválido de status",()=>{for(const status of[
  {id:"wamid",status:"sent",timestamp:"bad"},{id:"",status:"sent",timestamp:"1"},{id:"wamid",status:"SENT",timestamp:"1"},
  {id:"wamid",status:"failed",timestamp:"1",errors:[{code:"x"}]},{id:"wamid",status:"sent",timestamp:"1",recipient_id:["bad"]},
])assert.throws(()=>classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},statuses:[status]}}]}]}),/INVALID_META_CALLBACK/);});

test("tipos autênticos não suportados são classificados como não acionáveis",()=>{
  const result=classifyMetaCallback({entry:[{changes:[{value:{metadata:{phone_number_id:"account"},messages:[{id:"unsupported",type:"reaction"}]}}]}]});
  assert.deepEqual({messages:result.messages,statuses:result.statuses,statusCount:result.statusCount,ignoredCount:result.ignoredCount},{messages:[],statuses:[],statusCount:0,ignoredCount:1});
});

test("limites estruturais falham fechado",()=>{
  assert.throws(()=>classifyMetaCallback({entry:[]}),/INVALID_META_CALLBACK/);
  assert.throws(()=>classifyMetaCallback({entry:Array.from({length:META_CALLBACK_LIMITS.entries+1},()=>({changes:[]}))}),
    /INVALID_META_CALLBACK/);
  assert.throws(()=>classifyMetaCallback({entry:[{changes:[{value:{messages:Array.from({length:101},()=>textMessage)}}]}]}),
    /INVALID_META_CALLBACK/);
});
