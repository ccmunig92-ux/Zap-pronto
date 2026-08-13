import assert from "node:assert/strict";import test from "node:test";
import {slaPolicyFingerprint,setUnitSlaPolicy} from "./sla-policy.js";
const unit="11111111-1111-4111-8111-111111111111";
const targets=[{priority:"URGENT" as const,targetMinutes:15},{priority:"HIGH" as const,targetMinutes:30},
  {priority:"NORMAL" as const,targetMinutes:60},{priority:"LOW" as const,targetMinutes:120}];
test("normaliza a ordem e publica politica",async()=>{const calls:unknown[][]=[];const client={query:async(_sql:string,values?:unknown[])=>{
  calls.push(values??[]);return{rowCount:1,rows:[{unitId:unit,version:1,effectiveAt:new Date(),targets,replayed:false}]};}};
  const result=await setUnitSlaPolicy(client as never,{unitId:unit.toUpperCase(),expectedVersion:0,targets,idempotencyKey:" policy-1 "});
  assert.equal(result.version,1);assert.equal(calls[0]?.[0],unit);assert.equal(calls[0]?.[3],"policy-1");});
test("fingerprint independe da ordem",()=>assert.equal(slaPolicyFingerprint({unitId:unit,expectedVersion:0,targets}),
  slaPolicyFingerprint({unitId:unit,expectedVersion:0,targets:[...targets].reverse()})));
test("rejeita grade incompleta e limites",async()=>{await assert.rejects(setUnitSlaPolicy({} as never,
  {unitId:unit,expectedVersion:0,targets:targets.slice(1),idempotencyKey:"policy-1"}),/INVALID_SLA_POLICY_REQUEST/);
  assert.throws(()=>slaPolicyFingerprint({unitId:unit,expectedVersion:0,targets:targets.map((x,i)=>i?x:{...x,targetMinutes:0})}),/INVALID_SLA_POLICY_REQUEST/);});
