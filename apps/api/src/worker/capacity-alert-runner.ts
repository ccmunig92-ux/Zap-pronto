import type { WorkerClient, WorkerPool } from "./inbound-runner.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CapacityAlertEvaluationTarget { tenantId:string; unitId:string; }
export interface CapacityAlertWorkerOptions { pollIntervalMs:number; targets:readonly CapacityAlertEvaluationTarget[]; }

function abortableDelay(milliseconds:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const timer=setTimeout(done,milliseconds);
    function done(){signal.removeEventListener("abort",done);clearTimeout(timer);resolve();}
    signal.addEventListener("abort",done,{once:true});
  });
}

async function transaction<T>(pool:WorkerPool,operation:(client:WorkerClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
    const result=await operation(client);await client.query("COMMIT");client.release();return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);client.release();throw error;}
}

export async function evaluateCapacityAlertTarget(pool:WorkerPool,target:CapacityAlertEvaluationTarget,asOf=new Date()):Promise<void>{
  if(!UUID.test(target.tenantId)||!UUID.test(target.unitId)||!Number.isFinite(asOf.getTime()))throw new Error("CAPACITY_ALERT_TARGET_INVALID");
  await transaction(pool,async client=>{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[target.tenantId]);
    await client.query("SELECT * FROM evaluate_unit_capacity_alert_episode($1,$2)",[target.unitId,asOf.toISOString()]);
  });
}

export async function runCapacityAlertWorker(pool:WorkerPool,options:CapacityAlertWorkerOptions,signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
    for(const target of options.targets){if(signal.aborted)break;await evaluateCapacityAlertTarget(pool,target);}
    if(!signal.aborted)await abortableDelay(options.pollIntervalMs,signal);
  }
}
