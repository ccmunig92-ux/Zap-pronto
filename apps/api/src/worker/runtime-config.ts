import { readFile } from "node:fs/promises";

export interface InboundWorkerRuntimeConfig { databaseUrl:string;batchSize:number;leaseSeconds:number;
  pollIntervalMs:number;backoffSeconds:number;shutdownTimeoutMs:number;outboundEnabled:boolean;
  capacityAlertTargets:readonly {tenantId:string;unitId:string}[]; }
function integer(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number):number{
  const raw=env[name];if(raw===undefined)return fallback;
  if(!/^\d+$/.test(raw))throw new Error(`${name}_INVALID`);const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name}_INVALID`);return value;
}
async function secret(env:NodeJS.ProcessEnv):Promise<string>{
  const direct=env.DATABASE_WORKER_URL;const file=env.DATABASE_WORKER_URL_FILE;
  if(direct&&file)throw new Error("DATABASE_WORKER_URL_SOURCE_CONFLICT");
  let value=direct;if(!value&&file){try{value=await readFile(file,"utf8");}catch{throw new Error("DATABASE_WORKER_URL_FILE_UNREADABLE");}}
  value=value?.trim();if(!value)throw new Error("DATABASE_WORKER_URL_REQUIRED");
  let parsed:URL;try{parsed=new URL(value);}catch{throw new Error("DATABASE_WORKER_URL_INVALID");}
  if(!["postgres:","postgresql:"].includes(parsed.protocol)||decodeURIComponent(parsed.username)!=="zap_pronto_worker_runtime"||
    !parsed.password||!parsed.hostname||!parsed.pathname.slice(1))throw new Error("DATABASE_WORKER_URL_INVALID");
  return value;
}
function outboundEnabled(env:NodeJS.ProcessEnv):boolean{
  const raw=env.OUTBOUND_WORKER_ENABLED??"false";
  if(raw!=="false"&&raw!=="true")throw new Error("OUTBOUND_WORKER_ENABLED_INVALID");
  return raw==="true";
}
function capacityAlertTargets(env:NodeJS.ProcessEnv):readonly {tenantId:string;unitId:string}[]{
  const raw=env.CAPACITY_ALERT_EVALUATION_TARGETS?.trim();if(!raw)return [];
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targets=raw.split(",").map(value=>value.trim()).filter(Boolean).map(value=>{
    const [tenantId,unitId,...rest]=value.split(":");
    if(rest.length||!tenantId||!unitId||!UUID.test(tenantId)||!UUID.test(unitId))throw new Error("CAPACITY_ALERT_TARGETS_INVALID");
    return {tenantId:tenantId.toLowerCase(),unitId:unitId.toLowerCase()};
  });
  if(targets.length>100)throw new Error("CAPACITY_ALERT_TARGETS_INVALID");
  return targets;
}
export async function loadInboundWorkerRuntimeConfig(env:NodeJS.ProcessEnv=process.env):Promise<InboundWorkerRuntimeConfig>{
  const leaseSeconds=integer(env,"INBOUND_WORKER_LEASE_SECONDS",60,5,900);
  const shutdownTimeoutMs=integer(env,"INBOUND_WORKER_SHUTDOWN_TIMEOUT_MS",10_000,100,899_000);
  if(shutdownTimeoutMs>=leaseSeconds*1000)throw new Error("INBOUND_WORKER_SHUTDOWN_TIMEOUT_INVALID");
  return {databaseUrl:await secret(env),batchSize:integer(env,"INBOUND_WORKER_BATCH_SIZE",10,1,100),leaseSeconds,
    pollIntervalMs:integer(env,"INBOUND_WORKER_POLL_INTERVAL_MS",1000,50,60_000),
    backoffSeconds:integer(env,"INBOUND_WORKER_BACKOFF_SECONDS",30,1,3600),shutdownTimeoutMs,
    outboundEnabled:outboundEnabled(env),capacityAlertTargets:capacityAlertTargets(env)};
}
