import assert from "node:assert/strict";import test from "node:test";
import {acknowledgeSlaAlert,listSlaAlerts,slaAlertAcknowledgementFingerprint} from "./sla-alerts.js";
const unit="33333333-3333-4333-8333-333333333333",handoff="44444444-4444-4444-8444-444444444444";
test("SLA alert acknowledgement fingerprint is canonical",()=>assert.equal(slaAlertAcknowledgementFingerprint({handoffId:handoff.toUpperCase(),expectedVersion:7}),
  slaAlertAcknowledgementFingerprint({handoffId:handoff,expectedVersion:7})));
test("SLA alerts bind cursor to unit filters and asOf",async()=>{const calls:unknown[][]=[];const client={async query(_sql:string,values?:unknown[]){calls.push(values??[]);return{rows:[
  {handoffId:handoff,unitId:unit,priority:"URGENT",slaStatus:"OVERDUE",slaDueAt:new Date("2026-01-01T09:00:00Z"),queuedAt:new Date("2026-01-01T08:00:00Z"),ageSeconds:7200,availableCapacity:2,acknowledgedAt:null,acknowledgementVersion:null},
  {handoffId:"55555555-5555-4555-8555-555555555555",unitId:unit,priority:"HIGH",slaStatus:"DUE_SOON",slaDueAt:new Date("2026-01-01T10:10:00Z"),queuedAt:new Date("2026-01-01T09:00:00Z"),ageSeconds:3600,availableCapacity:2,acknowledgedAt:null,acknowledgementVersion:null}]}}};
  const first=await listSlaAlerts(client,{unitId:unit,pageSize:1,asOf:new Date("2026-01-01T10:00:00Z")});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  await assert.rejects(listSlaAlerts(client,{unitId:"66666666-6666-4666-8666-666666666666",pageSize:1,
    asOf:new Date("2026-01-01T10:00:00Z"),cursor:first.nextCursor!}),/INVALID_PAGE_CURSOR/);assert.equal(calls.length,1);});
test("SLA alert cursor preserves snapshot, filters and both independent ranks across two pages",async()=>{
  const calls:unknown[][]=[];let page=0;const second="55555555-5555-4555-8555-555555555555";
  const client={async query(_sql:string,values?:unknown[]){calls.push(values??[]);page+=1;return{rows:page===1?[
    {handoffId:handoff,unitId:unit,priority:"HIGH",slaStatus:"OVERDUE",slaDueAt:new Date("2026-01-01T09:00:00Z"),queuedAt:new Date("2026-01-01T08:00:00Z"),ageSeconds:7200,availableCapacity:2,acknowledgedAt:null,acknowledgementVersion:7},
    {handoffId:second,unitId:unit,priority:"HIGH",slaStatus:"OVERDUE",slaDueAt:new Date("2026-01-01T09:30:00Z"),queuedAt:new Date("2026-01-01T08:30:00Z"),ageSeconds:5400,availableCapacity:2,acknowledgedAt:null,acknowledgementVersion:8}]:[
    {handoffId:second,unitId:unit,priority:"HIGH",slaStatus:"OVERDUE",slaDueAt:new Date("2026-01-01T09:30:00Z"),queuedAt:new Date("2026-01-01T08:30:00Z"),ageSeconds:5400,availableCapacity:2,acknowledgedAt:null,acknowledgementVersion:8}]}}};
  const asOf=new Date("2026-01-01T10:00:00Z"),first=await listSlaAlerts(client,{unitId:unit,pageSize:1,slaStatus:"OVERDUE",priority:"HIGH",asOf});
  assert.ok(first.nextCursor);const secondPage=await listSlaAlerts(client,{unitId:unit,pageSize:1,slaStatus:"OVERDUE",priority:"HIGH",cursor:first.nextCursor!});
  assert.equal(secondPage.items[0]?.handoffId,second);assert.equal(calls[0]?.[4],asOf.toISOString());assert.equal(calls[1]?.[4],asOf.toISOString());
  assert.deepEqual(calls[1]?.slice(0,7),[unit,2,"OVERDUE","HIGH",asOf.toISOString(),1,2]);
});
test("SLA acknowledgement passes stable key and fingerprint",async()=>{let values:unknown[]=[];const client={async query(_sql:string,input?:unknown[]){values=input??[];return{rows:[{handoffId:handoff,unitId:unit,acknowledgedAt:new Date(),acknowledgedByUserId:unit,version:1,replayed:false}]}}};
  await acknowledgeSlaAlert(client,{handoffId:handoff,expectedVersion:2,idempotencyKey:" ack-command-1 "});assert.equal(values[2],"ack-command-1");assert.match(String(values[3]),/^[a-f0-9]{64}$/);});
