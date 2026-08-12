import{createHash}from"node:crypto";import type{TenantTransactionPool}from"../database/tenant-transaction.js";import type{MetaDeliveryStatusEvent}from"./meta-callback.js";
export interface MetaDeliveryStatusResult{receiptId:string;applicationId:string;messageId:string|null;outcome:string;previousStatus:string|null;resultStatus:string|null;candidateCount:number;replayed:boolean}
function key(event:MetaDeliveryStatusEvent){return createHash("sha256").update(`${event.provider}\0${event.channelAccountId}\0${event.externalMessageId}\0${event.providerStatus}\0${event.occurredAt}`).digest("hex")}
function fingerprint(event:MetaDeliveryStatusEvent){return createHash("sha256").update(JSON.stringify(event)).digest("hex")}
export async function reconcileMetaDeliveryStatus(pool:TenantTransactionPool,event:MetaDeliveryStatusEvent,correlationId:string):Promise<MetaDeliveryStatusResult>{
  if(correlationId.length<8||correlationId.length>128)throw new Error("INVALID_CORRELATION_ID");const client=await pool.connect();
  try{await client.query("BEGIN");await client.query("SET LOCAL ROLE zap_pronto_api");await client.query("SELECT set_config('app.correlation_id',$1,true)",[correlationId]);
    const result=await client.query(`SELECT receipt_id AS "receiptId",application_id AS "applicationId",message_id AS "messageId",outcome,
      previous_status AS "previousStatus",result_status AS "resultStatus",candidate_count AS "candidateCount",replayed
      FROM reconcile_meta_delivery_status($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[event.channelAccountId,event.externalMessageId,event.recipientExternalId,
      event.providerStatus,event.normalizedStatus,event.occurredAt,[...event.errorCodes],key(event),fingerprint(event),correlationId]) as{rows:MetaDeliveryStatusResult[]};
    if(result.rows.length!==1)throw new Error("META_STATUS_RECONCILIATION_FAILED");await client.query("COMMIT");client.release();return result.rows[0]!;
  }catch(error){try{await client.query("ROLLBACK");client.release()}catch(rollback){client.release(rollback instanceof Error?rollback:true)}throw error;}}
