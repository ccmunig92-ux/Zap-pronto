const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_ID=/^[^\u0000-\u001f\u007f]{1,512}$/;

export interface OutboundWorkerClient { query(text:string,values?:unknown[]):Promise<{rows:unknown[]}>; release(error?:Error|boolean):void; }
export interface OutboundWorkerPool { connect():Promise<OutboundWorkerClient>; }
export interface OutboundWorkerOptions { batchSize:number;leaseSeconds:number;pollIntervalMs:number;backoffSeconds:number; }
export interface OutboundTransportInput { tenantId:string;messageId:string;channelConnectionId:string;
  channelAccountId:string;secretReference:string;recipientExternalId:string;body:string;sessionOpen:boolean; }
export interface OutboundTransportResult { externalMessageId:string; }
export interface OutboundTransport { sendText(input:OutboundTransportInput,signal:AbortSignal):Promise<OutboundTransportResult>; }

interface ClaimedOutbound { tenant_id:string;outbox_id:string;message_id:string;channel_connection_id:string;
  channel_account_id:string;secret_reference:string;recipient_external_id:string;body:string;session_open:boolean;event_type:string;payload_version:number;lease_token:string; }

function nonEmpty(value:unknown,maximum:number):value is string{
  return typeof value==="string"&&value.length>=1&&value.length<=maximum&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
}
function claimed(row:unknown):ClaimedOutbound{
  if(!row||typeof row!=="object")throw new Error("OUTBOUND_CLAIM_INVALID");
  const value=row as Record<string,unknown>;
  if(!UUID.test(String(value.tenant_id))||!UUID.test(String(value.outbox_id))||!UUID.test(String(value.message_id))||
    !UUID.test(String(value.channel_connection_id))||!UUID.test(String(value.lease_token))||
    !nonEmpty(value.channel_account_id,512)||!nonEmpty(value.secret_reference,512)||!nonEmpty(value.recipient_external_id,512)||
    !nonEmpty(value.body,4096)||typeof value.session_open!=="boolean"||value.event_type!=="channel.outbound.requested"||value.payload_version!==1)
    throw new Error("OUTBOUND_CLAIM_INVALID");
  return value as unknown as ClaimedOutbound;
}
function externalMessageId(result:unknown):string{
  if(!result||typeof result!=="object")throw new Error("OUTBOUND_TRANSPORT_RESULT_INVALID");
  const value=(result as Record<string,unknown>).externalMessageId;
  if(typeof value!=="string"||value!==value.trim()||!EXTERNAL_ID.test(value))
    throw new Error("OUTBOUND_TRANSPORT_RESULT_INVALID");
  return value;
}
async function transaction<T>(pool:OutboundWorkerPool,operation:(client:OutboundWorkerClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_worker");
    const result=await operation(client);await client.query("COMMIT");client.release();return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);client.release();throw error;}
}

export async function claimOutboundTextEvents(pool:OutboundWorkerPool,options:OutboundWorkerOptions):Promise<ClaimedOutbound[]>{
  return transaction(pool,async client=>{
    const result=await client.query("SELECT * FROM claim_outbound_delivery_events($1,$2)",[options.batchSize,options.leaseSeconds]);
    return result.rows.map(claimed);
  });
}
async function failClaim(pool:OutboundWorkerPool,job:ClaimedOutbound,options:OutboundWorkerOptions):Promise<void>{
  await transaction(pool,async client=>{await client.query("SELECT fail_outbound_delivery_event($1,$2,$3,$4)",
    [job.outbox_id,job.lease_token,"OUTBOUND_TRANSPORT_FAILED",options.backoffSeconds]);});
}
async function finalizeClaim(pool:OutboundWorkerPool,job:ClaimedOutbound,providerMessageId:string):Promise<void>{
  await transaction(pool,async client=>{
    const result=await client.query("SELECT finalize_outbound_delivery_event($1,$2,$3)",
      [job.outbox_id,job.lease_token,providerMessageId]);
    if(result.rows.length!==1)throw new Error("OUTBOUND_FINALIZE_FAILED");
    const row=result.rows[0];
    if(!row||typeof row!=="object"||Object.values(row as Record<string,unknown>)[0]!==true)
      throw new Error("OUTBOUND_FINALIZE_FAILED");
  });
}

export async function processOutboundClaim(pool:OutboundWorkerPool,job:ClaimedOutbound,options:OutboundWorkerOptions,
  transport:OutboundTransport,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return;
  try{
    const result=await transport.sendText({tenantId:job.tenant_id,messageId:job.message_id,
      channelConnectionId:job.channel_connection_id,channelAccountId:job.channel_account_id,
      secretReference:job.secret_reference,
      recipientExternalId:job.recipient_external_id,body:job.body,sessionOpen:job.session_open},signal);
    if(signal.aborted)throw new Error("OUTBOUND_ABORTED");
    await finalizeClaim(pool,job,externalMessageId(result));
  }catch(error){
    const errorCode=error instanceof Error&&error.message==="META_WHATSAPP_TEMPLATE_REQUIRED"
      ? "OUTBOUND_TEMPLATE_REQUIRED" : "OUTBOUND_TRANSPORT_FAILED";
    await transaction(pool,async client=>{await client.query("SELECT fail_outbound_delivery_event($1,$2,$3,$4)",
      [job.outbox_id,job.lease_token,errorCode,options.backoffSeconds]);}).catch(()=>undefined);
    throw new Error("OUTBOUND_DELIVERY_FAILED",{cause:error});
  }
}
function delay(milliseconds:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const timer=setTimeout(done,milliseconds);
    function done(){signal.removeEventListener("abort",done);clearTimeout(timer);resolve();}
    signal.addEventListener("abort",done,{once:true});});
}
export async function runOutboundWorker(pool:OutboundWorkerPool,options:OutboundWorkerOptions,transport:OutboundTransport,
  signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
    const jobs=await claimOutboundTextEvents(pool,options);
    for(const job of jobs){if(signal.aborted)break;await processOutboundClaim(pool,job,options,transport,signal).catch(()=>undefined);}
    if(!signal.aborted&&jobs.length===0)await delay(options.pollIntervalMs,signal);
  }
}
