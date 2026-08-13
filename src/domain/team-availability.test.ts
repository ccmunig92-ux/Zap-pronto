import assert from "node:assert/strict";import test from "node:test";import {listTeamAvailability} from "./team-availability.js";
const unitId="10000000-0000-4000-8000-000000000001";
const rows=[{userId:"20000000-0000-4000-8000-000000000001",displayName:"Ana",role:"ATTENDANT",status:"AVAILABLE",maxActive:2,activeCount:1,remainingCapacity:1,pauseReason:null,pausedUntil:null,updatedAt:new Date()},
  {userId:"20000000-0000-4000-8000-000000000002",displayName:"Bia",role:"SUPERVISOR",status:"PAUSED",maxActive:1,activeCount:1,remainingCapacity:0,pauseReason:"BREAK",pausedUntil:null,updatedAt:new Date()}];
test("consulta DTO estreito e limita sem mutar",async()=>{let sql="",values:unknown[]=[];const client={async query(text:string,input:unknown[]){sql=text;values=input;return{rows}}};
  const page=await listTeamAvailability(client as never,{unitId,limit:1});assert.deepEqual(page.items,[rows[0]]);assert.ok(page.nextCursor);
  assert.match(sql,/list_unit_team_availability/);assert.deepEqual(values,[unitId,2,null,null,null]);assert.equal(rows.length,2)});
test("cursor é fechado, vinculado e canônico",async()=>{const client={async query(_text:string,values:unknown[]){assert.deepEqual(values.slice(2),["AVAILABLE","Ana",rows[0]!.userId]);return{rows:[]}}};
  const first=await listTeamAvailability({query:async()=>({rows})} as never,{unitId,limit:1,status:"AVAILABLE"});
  assert.ok(first.nextCursor);await listTeamAvailability(client as never,{unitId,limit:1,status:"AVAILABLE",cursor:first.nextCursor});
  await assert.rejects(listTeamAvailability(client as never,{unitId,limit:1,status:"PAUSED",cursor:first.nextCursor}),/INVALID_TEAM_AVAILABILITY_REQUEST/);
  await assert.rejects(listTeamAvailability(client as never,{unitId,cursor:Buffer.from(JSON.stringify({v:1,scope:"UNIT_TEAM_AVAILABILITY",unitId,statusFilter:null,displayName:"Ana",userId:rows[0]!.userId,extra:true})).toString("base64url")}),/INVALID_TEAM_AVAILABILITY_REQUEST/)});
test("rejeita filtro limite e unidade inválidos antes do SQL",async()=>{let called=false;const client={async query(){called=true;return{rows:[]}}};
  await assert.rejects(listTeamAvailability(client as never,{unitId,limit:0}),/INVALID_TEAM_AVAILABILITY_REQUEST/);
  await assert.rejects(listTeamAvailability(client as never,{unitId,status:"BLOCKED" as never}),/INVALID_TEAM_AVAILABILITY_REQUEST/);assert.equal(called,false)});
