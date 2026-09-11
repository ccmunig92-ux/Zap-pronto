import pg from "pg";
import { writeFile } from "node:fs/promises";
import { runInboundWorker } from "./worker/inbound-runner.js";
import { runOutboundWorker,type OutboundTransport } from "./worker/outbound-runner.js";
import { createFileSecretResolver, createMetaWhatsAppTransport, loadMetaWhatsAppTransportConfig } from "./worker/meta-whatsapp-transport.js";
import { loadInboundWorkerRuntimeConfig } from "./worker/runtime-config.js";
import { runCapacityAlertWorker } from "./worker/capacity-alert-runner.js";

const config=await loadInboundWorkerRuntimeConfig();
const secretRoot=config.outboundEnabled?process.env.META_WHATSAPP_SECRET_ROOT?.trim():undefined;
if(config.outboundEnabled&&!secretRoot)throw new Error("META_WHATSAPP_SECRET_ROOT_REQUIRED");
const outboundTransport:OutboundTransport|undefined=config.outboundEnabled
  ?createMetaWhatsAppTransport(await loadMetaWhatsAppTransportConfig(),{secretResolver:createFileSecretResolver(secretRoot!)}):undefined;
const pool=new pg.Pool({connectionString:config.databaseUrl,max:Math.min(config.batchSize,10),connectionTimeoutMillis:5000});
const controller=new AbortController();let stopped=false;
function reportWorkerFailure(worker:string,code:string):void{
  console.error(JSON.stringify({level:"error",event:"worker.failure",worker,code}));
}
function stop(){if(!stopped){stopped=true;controller.abort();}}
process.once("SIGTERM",stop);process.once("SIGINT",stop);
let timer:NodeJS.Timeout|undefined;
try{
  const workers:Promise<void>[]= [
    runInboundWorker(pool,{...config,reportFailure:failure=>reportWorkerFailure("inbound",failure.kind)},controller.signal),
    runCapacityAlertWorker(pool,{pollIntervalMs:config.capacityAlertPollIntervalMs,
      pageSize:config.capacityAlertDiscoveryPageSize,
      maxConsecutiveDiscoveryFailures:config.capacityAlertDiscoveryFailureThreshold,
      reportFailure:failure=>reportWorkerFailure("capacity-alert",failure.kind),
      markDiscoveryHealthy:()=>writeFile("/tmp/zap-pronto-capacity-alert.healthy","",{mode:0o600})},controller.signal),
  ];
  if(outboundTransport)workers.push(runOutboundWorker(pool,
    {...config,reportFailure:failure=>reportWorkerFailure("outbound",failure.kind)},outboundTransport,controller.signal));
  await Promise.race([Promise.all(workers).then(()=>undefined),new Promise<never>((_,reject)=>{
    if(!controller.signal.aborted)controller.signal.addEventListener("abort",()=>{
      timer=setTimeout(()=>reject(new Error("INBOUND_WORKER_SHUTDOWN_TIMEOUT")),config.shutdownTimeoutMs);timer.unref();
    },{once:true});
  })]);
}finally{stop();if(timer)clearTimeout(timer);await pool.end();}
