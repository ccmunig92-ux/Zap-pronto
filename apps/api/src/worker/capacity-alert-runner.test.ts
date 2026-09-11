import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverCapacityAlertTargetPage,
  evaluateCapacityAlertTarget,
  runCapacityAlertWorker,
  type CapacityAlertEvaluationTarget,
  type CapacityAlertWorkerFailure,
} from "./capacity-alert-runner.js";

const tenantId="10000000-0000-4000-8000-000000000001";
const target:CapacityAlertEvaluationTarget={tenantId,unitId:"20000000-0000-4000-8000-000000000001"};
function unit(index:number):string{return `20000000-0000-4000-8000-${String(index).padStart(12,"0")}`;}
function pool(handler?:(text:string,values?:unknown[])=>Promise<{rows:unknown[]}>){
  const calls:{text:string;values?:unknown[]}[]=[];
  const client={async query(text:string,values?:unknown[]){calls.push({text,...(values?{values}:{})});return handler?handler(text,values):{rows:[]}},release(){}};
  return{calls,pool:{async connect(){return client},async end(){}}};
}

test("capacity discovery returns bounded keyset pages beyond one hundred targets",async()=>{
  const rows=Array.from({length:101},(_,index)=>({tenant_id:tenantId,unit_id:unit(index+1)}));
  let page=0;
  const mock=pool(async text=>text.includes("list_capacity_alert_evaluation_targets")
    ?{rows:page++===0?rows.slice(0,100):rows.slice(100)}:{rows:[]});
  const first=await discoverCapacityAlertTargetPage(mock.pool,undefined,100);
  const second=await discoverCapacityAlertTargetPage(mock.pool,first.nextCursor,100);
  assert.equal(first.targets.length,100);assert.deepEqual(first.targets[0],{tenantId,unitId:unit(1)});
  assert.deepEqual(first.nextCursor,{tenantId,unitId:unit(100)});
  assert.deepEqual(second.targets,[{tenantId,unitId:unit(101)}]);assert.equal(second.nextCursor,undefined);
  const queries=mock.calls.filter(call=>call.text.includes("list_capacity_alert_evaluation_targets"));
  assert.equal(queries.length,2);assert.deepEqual(queries[0]?.values,[null,null,100]);
  assert.deepEqual(queries[1]?.values,[tenantId,unit(100),100]);
  assert.equal(mock.calls.filter(call=>call.text==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").length,2);
});

test("capacity discovery rejects invalid pages and non-progressing cursors",async()=>{
  await assert.rejects(discoverCapacityAlertTargetPage(pool().pool,undefined,0),/PAGE_SIZE_INVALID/);
  const duplicate=pool(async text=>text.includes("list_capacity_alert_evaluation_targets")
    ?{rows:[{tenant_id:tenantId,unit_id:target.unitId},{tenant_id:tenantId,unit_id:target.unitId}]}:{rows:[]});
  await assert.rejects(discoverCapacityAlertTargetPage(duplicate.pool,undefined,2),/DISCOVERY_ORDER_INVALID/);
});

test("capacity evaluator installs tenant context and only calls the lifecycle function",async()=>{
  const mock=pool();await evaluateCapacityAlertTarget(mock.pool,target,new Date("2026-08-23T12:00:00Z"));
  assert.equal(mock.calls[2]?.text,"SELECT set_config('app.tenant_id',$1,true)");assert.deepEqual(mock.calls[2]?.values,[target.tenantId]);
  assert.match(mock.calls[3]?.text??"",/evaluate_unit_capacity_alert_episode/);assert.deepEqual(mock.calls[3]?.values,[target.unitId,"2026-08-23T12:00:00.000Z"]);
  assert.equal(mock.calls.some(call=>/outbound|http|fetch/i.test(call.text)),false);
});

test("capacity evaluator rejects malformed tenant or unit targets before opening SQL",async()=>{
  const mock=pool();await assert.rejects(evaluateCapacityAlertTarget(mock.pool,{...target,tenantId:"bad"}),/CAPACITY_ALERT_TARGET_INVALID/);assert.equal(mock.calls.length,0);
});

test("capacity worker isolates a failed target and rediscovers enabled policies every cycle",async()=>{
  const bad={tenant_id:tenantId,unit_id:unit(1)},good={tenant_id:tenantId,unit_id:unit(2)},added={tenant_id:tenantId,unit_id:unit(3)};
  const controller=new AbortController(),evaluated:string[]=[],failures:CapacityAlertWorkerFailure[]=[];let discoveries=0;
  const mock=pool(async(text,values)=>{
    if(text.includes("list_capacity_alert_evaluation_targets")){
      const rows=discoveries===0?[bad,good]:discoveries===1?[]:[added];discoveries++;return{rows};
    }
    if(text.includes("evaluate_unit_capacity_alert_episode")){
      const id=String(values?.[0]);evaluated.push(id);
      if(id===bad.unit_id)throw new Error("policy disabled concurrently");
      if(id===added.unit_id)controller.abort();
    }
    return{rows:[]};
  });
  await runCapacityAlertWorker(mock.pool,{pollIntervalMs:1,pageSize:2,maxConsecutiveDiscoveryFailures:3,
    reportFailure:failure=>failures.push(failure)},controller.signal);
  assert.deepEqual(evaluated,[bad.unit_id,good.unit_id,added.unit_id]);assert.equal(discoveries,3);
  assert.deepEqual(failures,[{kind:"CAPACITY_ALERT_EVALUATION_FAILED",target:{tenantId,unitId:bad.unit_id}}]);
});

test("capacity worker accepts an empty discovery cycle without evaluating a target",async()=>{
  const controller=new AbortController();let evaluations=0;
  const mock=pool(async text=>{
    if(text.includes("list_capacity_alert_evaluation_targets")){controller.abort();return{rows:[]};}
    if(text.includes("evaluate_unit_capacity_alert_episode"))evaluations++;
    return{rows:[]};
  });
  await runCapacityAlertWorker(mock.pool,{pollIntervalMs:1,pageSize:100,maxConsecutiveDiscoveryFailures:3},controller.signal);
  assert.equal(evaluations,0);
});

test("capacity worker fails closed with a sanitized code after persistent discovery failure",async()=>{
  const failures:CapacityAlertWorkerFailure[]=[],marks:string[]=[];let discoveries=0;
  const mock=pool(async text=>{
    if(text.includes("list_capacity_alert_evaluation_targets")){
      if(discoveries++%2===0)return{rows:[{tenant_id:tenantId,unit_id:unit(1)}]};
      throw new Error("private database detail");
    }
    return{rows:[]};
  });
  await assert.rejects(runCapacityAlertWorker(mock.pool,{pollIntervalMs:1,pageSize:1,
    maxConsecutiveDiscoveryFailures:2,reportFailure:failure=>failures.push(failure),markDiscoveryHealthy:()=>{marks.push("page");}},new AbortController().signal),
  error=>error instanceof Error&&error.message==="CAPACITY_ALERT_DISCOVERY_UNAVAILABLE"&&!error.message.includes("private"));
  assert.deepEqual(failures,[{kind:"CAPACITY_ALERT_DISCOVERY_FAILED"},{kind:"CAPACITY_ALERT_DISCOVERY_FAILED"}]);
  assert.deepEqual(marks,["page","page"]);
});

test("capacity health is refreshed after every successful discovery page",async()=>{
  const controller=new AbortController();let marks=0,discoveries=0;
  const mock=pool(async text=>text.includes("list_capacity_alert_evaluation_targets")
    ?{rows:discoveries++===0?[{tenant_id:tenantId,unit_id:unit(1)}]:[]}:{rows:[]});
  await runCapacityAlertWorker(mock.pool,{pollIntervalMs:1,pageSize:1,maxConsecutiveDiscoveryFailures:3,
    markDiscoveryHealthy:()=>{marks++;if(marks===2)controller.abort();}},controller.signal);
  assert.equal(discoveries,2);assert.equal(marks,2);
});
