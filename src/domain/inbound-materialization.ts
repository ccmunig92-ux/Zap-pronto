import type { TenantQueryClient } from "../database/tenant-transaction.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface QueryResult<Row>{readonly rowCount:number|null;readonly rows:readonly Row[]}

export interface MaterializedInboundEvent{
  readonly contactId:string;
  readonly contactIdentityId:string;
  readonly conversationId:string;
  readonly messageId:string;
  readonly replayed:boolean;
}

/** Executes only inside the canonical worker transaction and never reads inbound payload in application code. */
export async function materializeInboundChannelEvent(client:TenantQueryClient,outboxId:string,leaseToken:string):
Promise<MaterializedInboundEvent>{
  if(!UUID.test(outboxId)||!UUID.test(leaseToken))throw new Error("INVALID_INBOUND_MATERIALIZATION_REQUEST");
  const result=await client.query(`SELECT contact_id AS "contactId",contact_identity_id AS "contactIdentityId",
    conversation_id AS "conversationId",message_id AS "messageId",replayed
    FROM materialize_inbound_channel_event($1,$2)`,[outboxId,leaseToken]) as QueryResult<MaterializedInboundEvent>;
  if((result.rowCount??result.rows.length)!==1)throw new Error("INBOUND_MATERIALIZATION_FAILED");
  return result.rows[0]!;
}
