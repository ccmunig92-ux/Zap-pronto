import pg from "pg";
import { runInboundWorker } from "./worker/inbound-runner.js";
import { runOutboundWorker,type OutboundTransport } from "./worker/outbound-runner.js";
import { loadInboundWorkerRuntimeConfig } from "./worker/runtime-config.js";

const config=await loadInboundWorkerRuntimeConfig();
function loadOutboundTransport():OutboundTransport{
  throw new Error("OUTBOUND_TRANSPORT_NOT_CONFIGURED");
}
const outboundTransport=config.outboundEnabled?loadOutboundTransport():undefined;
const pool=new pg.Pool({connectionString:config.databaseUrl,max:Math.min(config.batchSize,10),connectionTimeoutMillis:5000});
const controller=new AbortController();let stopped=false;
function stop(){if(!stopped){stopped=true;controller.abort();}}
process.once("SIGTERM",stop);process.once("SIGINT",stop);
let timer:NodeJS.Timeout|undefined;
try{
  const workers:Promise<void>[]=[runInboundWorker(pool,config,controller.signal)];
  if(outboundTransport)workers.push(runOutboundWorker(pool,config,outboundTransport,controller.signal));
  await Promise.race([Promise.all(workers).then(()=>undefined),new Promise<never>((_,reject)=>{
    if(!controller.signal.aborted)controller.signal.addEventListener("abort",()=>{
      timer=setTimeout(()=>reject(new Error("INBOUND_WORKER_SHUTDOWN_TIMEOUT")),config.shutdownTimeoutMs);timer.unref();
    },{once:true});
  })]);
}finally{stop();if(timer)clearTimeout(timer);await pool.end();}
