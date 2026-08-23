import assert from "node:assert/strict";import test from "node:test";
import{capacityAlertPolicyFingerprint,getUnitCapacityAlertSnapshot,setUnitCapacityAlertPolicy}from"./capacity-alert.js";
import{capacityAlertEpisodeAcknowledgementFingerprint,listCapacityAlertEpisodes}from"./capacity-alert-episodes.js";
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
test("capacity alert episode list delegates only to the tenant-unit SQL function",async()=>{const calls:{sql:string;values:unknown[]}[]=[];const client={async query(sql:string,values:unknown[]){calls.push({sql,values});return{rows:[]}}};
  await listCapacityAlertEpisodes(client as never,{unitId:unitId.toUpperCase(),status:"OPEN",pageSize:10});assert.match(calls[0]!.sql,/list_unit_capacity_alert_episodes/);assert.deepEqual(calls[0]!.values,[unitId,"OPEN",10]);assert.doesNotMatch(calls[0]!.sql,/FROM\s+public\.unit_capacity_alert_episodes\b/i)});
test("capacity episode acknowledgement fingerprint follows the SQL command contract",()=>{assert.equal(capacityAlertEpisodeAcknowledgementFingerprint({episodeId:unitId,expectedVersion:2,reason:"Supervisor reviewed queue"}).length,64);assert.throws(()=>capacityAlertEpisodeAcknowledgementFingerprint({episodeId:unitId,expectedVersion:0,reason:"x"}),/INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT/)});
