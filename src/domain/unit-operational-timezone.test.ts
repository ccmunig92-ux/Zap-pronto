import assert from"node:assert/strict";import test from"node:test";
import{getUnitOperationalTimezone,setUnitOperationalTimezone,unitOperationalTimezoneFingerprint}from"./unit-operational-timezone.js";
const unit="11111111-1111-4111-8111-111111111111";
test("fingerprint de timezone e canonico",()=>assert.equal(unitOperationalTimezoneFingerprint({unitId:unit.toUpperCase(),timeZone:"America/Sao_Paulo",expectedVersion:0}),
  unitOperationalTimezoneFingerprint({unitId:unit,timeZone:"America/Sao_Paulo",expectedVersion:0})));
test("ausencia permanece explicita sem default",async()=>assert.rejects(getUnitOperationalTimezone({query:async()=>({rows:[]})}as never,unit),/UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND/));
test("set envia contrato estreito e fingerprint",async()=>{let values:unknown[]=[];const client={query:async(_sql:string,input?:unknown[])=>{values=input??[];return{rows:[{unitId:unit,timeZone:"America/Sao_Paulo",version:1,updatedAt:new Date(),replayed:false}]}}};
  const row=await setUnitOperationalTimezone(client as never,{unitId:unit.toUpperCase(),timeZone:"America/Sao_Paulo",expectedVersion:0,idempotencyKey:"timezone-key"});
  assert.equal(row.version,1);assert.deepEqual(values.slice(0,4),[unit,"America/Sao_Paulo",0,"timezone-key"]);assert.match(String(values[4]),/^[a-f0-9]{64}$/)});
test("rejeita timezone adulterada antes do banco",async()=>{let called=false;const client={query:async()=>{called=true;return{rows:[]}}};
  await assert.rejects(setUnitOperationalTimezone(client as never,{unitId:unit,timeZone:" America/Sao_Paulo",expectedVersion:0,idempotencyKey:"timezone-key"}),/INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST/);assert.equal(called,false)});
