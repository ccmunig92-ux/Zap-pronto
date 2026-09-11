import type { WorkerClient, WorkerPool } from "./inbound-runner.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CapacityAlertEvaluationTarget { tenantId:string; unitId:string; }
export type CapacityAlertWorkerFailure =
  | { kind:"CAPACITY_ALERT_DISCOVERY_FAILED" }
  | { kind:"CAPACITY_ALERT_EVALUATION_FAILED"; target:CapacityAlertEvaluationTarget };
export interface CapacityAlertWorkerOptions {
  pollIntervalMs:number;
  pageSize:number;
  maxConsecutiveDiscoveryFailures:number;
  reportFailure?:(failure:CapacityAlertWorkerFailure)=>void;
  markDiscoveryHealthy?:()=>void|Promise<void>;
}
export interface CapacityAlertTargetPage {
  targets:CapacityAlertEvaluationTarget[];
  nextCursor?:CapacityAlertEvaluationTarget;
}

function abortableDelay(milliseconds:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const timer=setTimeout(done,milliseconds);
    function done(){signal.removeEventListener("abort",done);clearTimeout(timer);resolve();}
    signal.addEventListener("abort",done,{once:true});
  });
}

async function transaction<T>(pool:WorkerPool,operation:(client:WorkerClient)=>Promise<T>,readOnly=false):Promise<T>{
  const client=await pool.connect();
  try{await client.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY":"BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
    const result=await operation(client);await client.query("COMMIT");client.release();return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);client.release();throw error;}
}

function target(row:unknown):CapacityAlertEvaluationTarget{
  if(!row||typeof row!=="object")throw new Error("CAPACITY_ALERT_DISCOVERY_ROW_INVALID");
  const value=row as Record<string,unknown>,tenantId=String(value.tenant_id??""),unitId=String(value.unit_id??"");
  if(!UUID.test(tenantId)||!UUID.test(unitId))throw new Error("CAPACITY_ALERT_DISCOVERY_ROW_INVALID");
  return{tenantId:tenantId.toLowerCase(),unitId:unitId.toLowerCase()};
}

function after(left:CapacityAlertEvaluationTarget,right:CapacityAlertEvaluationTarget):boolean{
  return left.tenantId>right.tenantId||left.tenantId===right.tenantId&&left.unitId>right.unitId;
}

export async function discoverCapacityAlertTargetPage(pool:WorkerPool,cursor:CapacityAlertEvaluationTarget|undefined,
  pageSize=100):Promise<CapacityAlertTargetPage>{
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new Error("CAPACITY_ALERT_DISCOVERY_PAGE_SIZE_INVALID");
  return transaction(pool,async client=>{
    const result=await client.query("SELECT tenant_id,unit_id FROM list_capacity_alert_evaluation_targets($1,$2,$3)",
      [cursor?.tenantId??null,cursor?.unitId??null,pageSize]);
    if(result.rows.length>pageSize)throw new Error("CAPACITY_ALERT_DISCOVERY_PAGE_INVALID");
    const targets=result.rows.map(target);let previous=cursor;
    for(const item of targets){
      if(previous&&!after(item,previous))throw new Error("CAPACITY_ALERT_DISCOVERY_ORDER_INVALID");
      previous=item;
    }
    return {targets,...(targets.length===pageSize?{nextCursor:targets[targets.length-1]!}:{})};
  },true);
}

export async function evaluateCapacityAlertTarget(pool:WorkerPool,targetValue:CapacityAlertEvaluationTarget,asOf=new Date()):Promise<void>{
  if(!UUID.test(targetValue.tenantId)||!UUID.test(targetValue.unitId)||!Number.isFinite(asOf.getTime()))throw new Error("CAPACITY_ALERT_TARGET_INVALID");
  await transaction(pool,async client=>{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[targetValue.tenantId]);
    await client.query("SELECT * FROM evaluate_unit_capacity_alert_episode($1,$2)",[targetValue.unitId,asOf.toISOString()]);
  });
}

export async function runCapacityAlertWorker(pool:WorkerPool,options:CapacityAlertWorkerOptions,signal:AbortSignal):Promise<void>{
  if(!Number.isSafeInteger(options.maxConsecutiveDiscoveryFailures)||options.maxConsecutiveDiscoveryFailures<1)
    throw new Error("CAPACITY_ALERT_DISCOVERY_FAILURE_THRESHOLD_INVALID");
  const report=options.reportFailure??((failure:CapacityAlertWorkerFailure)=>console.error(failure.kind));
  const reportSafely=(failure:CapacityAlertWorkerFailure)=>{try{report(failure);}catch{/* Observability must not stop other tenants. */}};
  let consecutiveDiscoveryFailures=0;
  while(!signal.aborted){
    const asOf=new Date();let cursor:CapacityAlertEvaluationTarget|undefined;let discoveryFailed=false;
    for(;;){
      let page:CapacityAlertTargetPage;
      try{page=await discoverCapacityAlertTargetPage(pool,cursor,options.pageSize);}
      catch{discoveryFailed=true;break;}
      if(options.markDiscoveryHealthy){
        try{await options.markDiscoveryHealthy();}catch{discoveryFailed=true;break;}
      }
      for(const item of page.targets){if(signal.aborted)break;
        try{await evaluateCapacityAlertTarget(pool,item,asOf);}
        catch{reportSafely({kind:"CAPACITY_ALERT_EVALUATION_FAILED",target:item});}
      }
      if(signal.aborted||!page.nextCursor)break;
      cursor=page.nextCursor;
    }
    if(signal.aborted)break;
    if(discoveryFailed){
      consecutiveDiscoveryFailures++;reportSafely({kind:"CAPACITY_ALERT_DISCOVERY_FAILED"});
      if(consecutiveDiscoveryFailures>=options.maxConsecutiveDiscoveryFailures)
        throw new Error("CAPACITY_ALERT_DISCOVERY_UNAVAILABLE");
    }else{
      consecutiveDiscoveryFailures=0;
    }
    if(!signal.aborted)await abortableDelay(options.pollIntervalMs,signal);
  }
}
