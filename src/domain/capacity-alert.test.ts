import assert from "node:assert/strict";import test from "node:test";
import{capacityAlertPolicyFingerprint,getUnitCapacityAlertSnapshot,setUnitCapacityAlertPolicy}from"./capacity-alert.js";
const unitId="33333333-3333-4333-8333-333333333333";
test("capacity alert policy command is canonical",async()=>{const calls:{sql:string;values:unknown[]}[]=[];
  const client={async query(sql:string,values:unknown[]){calls.push({sql,values});return{rows:[{unitId,enabled:true,minimumQueued:4,sustainedMinutes:20,version:1,updatedAt:new Date(),replayed:false}]}}};
  await setUnitCapacityAlertPolicy(client as never,{unitId:unitId.toUpperCase(),enabled:true,minimumQueued:4,sustainedMinutes:20,expectedVersion:0,idempotencyKey:" capacity-key-1 "});
  assert.deepEqual(calls[0]!.values.slice(0,6),[unitId,true,4,20,0,"capacity-key-1"]);
  assert.equal(calls[0]!.values[6],capacityAlertPolicyFingerprint({unitId,enabled:true,minimumQueued:4,sustainedMinutes:20,expectedVersion:0}))});
test("capacity alert policy rejects unsafe thresholds before SQL",async()=>{let queried=false;
  await assert.rejects(setUnitCapacityAlertPolicy({async query(){queried=true;return{rows:[]}}}as never,
    {unitId,enabled:true,minimumQueued:0,sustainedMinutes:20,expectedVersion:0,idempotencyKey:"capacity-key-1"}),/INVALID_CAPACITY_ALERT_POLICY_REQUEST/);assert.equal(queried,false)});
test("capacity alert snapshot validates asOf before SQL",async()=>{let queried=false;
  await assert.rejects(getUnitCapacityAlertSnapshot({async query(){queried=true;return{rows:[]}}}as never,unitId,new Date(Number.NaN)),/INVALID_CAPACITY_ALERT_SNAPSHOT_REQUEST/);assert.equal(queried,false)});
