import { randomUUID } from "node:crypto";
import { materializeInboundChannelEvent } from "@zap-pronto/core/domain/inbound-materialization";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface WorkerClient { query(text:string,values?:unknown[]):Promise<{rows:unknown[]}>; release(error?:Error|boolean):void; }
export interface WorkerPool { connect():Promise<WorkerClient>; end():Promise<void>; }
export interface InboundWorkerOptions { batchSize:number; leaseSeconds:number; pollIntervalMs:number; backoffSeconds:number; }
interface ClaimedInbound { tenant_id:string;outbox_id:string;aggregate_id:string;event_type:string;payload_version:number;lease_token:string; }

function claimed(row:unknown):ClaimedInbound {
  if(!row||typeof row!=="object")throw new Error("INBOUND_CLAIM_INVALID");
  const value=row as Record<string,unknown>;
  if(!UUID.test(String(value.tenant_id))||!UUID.test(String(value.outbox_id))||!UUID.test(String(value.aggregate_id))||
    !UUID.test(String(value.lease_token))||value.event_type!=="channel.inbound.received"||value.payload_version!==1)
    throw new Error("INBOUND_CLAIM_INVALID");
  return value as unknown as ClaimedInbound;
}

async function transaction<T>(pool:WorkerPool,operation:(client:WorkerClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
    const result=await operation(client);await client.query("COMMIT");client.release();return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);client.release();throw error;}
}

export async function claimInboundMaterializationEvents(pool:WorkerPool,options:InboundWorkerOptions):Promise<ClaimedInbound[]>{
  return transaction(pool,async client=>{
    const result=await client.query("SELECT * FROM claim_inbound_materialization_events($1,$2)",
      [options.batchSize,options.leaseSeconds]);
    return result.rows.map(claimed);
  });
}

async function failClaim(pool:WorkerPool,job:ClaimedInbound,options:InboundWorkerOptions):Promise<void>{
  await transaction(pool,async client=>{
    await client.query("SELECT fail_inbound_materialization_event($1,$2,$3,$4)",
      [job.outbox_id,job.lease_token,"INBOUND_MATERIALIZATION_FAILED",options.backoffSeconds]);
  });
}

export async function processInboundClaim(pool:WorkerPool,job:ClaimedInbound,options:InboundWorkerOptions):Promise<void>{
  try{
    await transaction(pool,async client=>{
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.correlation_id',$2,true)",
        [job.tenant_id,`inbound-worker:${randomUUID()}`]);
      await materializeInboundChannelEvent(client,job.outbox_id,job.lease_token);
    });
  }catch(error){
    await failClaim(pool,job,options).catch(()=>undefined);
    throw new Error("INBOUND_MATERIALIZATION_FAILED",{cause:error});
  }
}

function abortableDelay(milliseconds:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const timer=setTimeout(done,milliseconds);
    function done(){signal.removeEventListener("abort",done);clearTimeout(timer);resolve();}
    signal.addEventListener("abort",done,{once:true});});
}

export async function runInboundWorker(pool:WorkerPool,options:InboundWorkerOptions,signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
    const jobs=await claimInboundMaterializationEvents(pool,options);
    for(const job of jobs){if(signal.aborted)break;await processInboundClaim(pool,job,options).catch(()=>undefined);}
    if(!signal.aborted&&jobs.length===0)await abortableDelay(options.pollIntervalMs,signal);
  }
}
