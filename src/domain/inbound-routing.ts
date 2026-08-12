import { createHash } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL=/^[A-Za-z0-9_-]+$/;const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export interface EligibleRoutingUnit{readonly id:string;readonly code:string;readonly name:string}
export interface RoutingRequiredItem{readonly receiptId:string;readonly channelConnectionId:string;
  readonly provider:string;readonly kind:string;readonly occurredAt:Date;readonly receivedAt:Date;
  readonly eligibleUnits:readonly EligibleRoutingUnit[];readonly allowedActions:readonly("RESOLVE")[]}
export interface RoutingRequiredPage{readonly items:readonly RoutingRequiredItem[];readonly nextCursor?:string}
interface Cursor{readonly receivedAt:string;readonly id:string}
function cursor(value:string|undefined):Cursor|null{if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_PAGE_CURSOR");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();
    const decoded=JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;
    if(Object.keys(decoded).sort().join(",")!=="id,receivedAt,v"||decoded.v!==1||typeof decoded.id!=="string"||!UUID.test(decoded.id)
      ||typeof decoded.receivedAt!=="string"||!ISO.test(decoded.receivedAt)||new Date(decoded.receivedAt).toISOString()!==decoded.receivedAt)throw new Error();
    return {id:decoded.id,receivedAt:decoded.receivedAt};}catch{throw new Error("INVALID_PAGE_CURSOR");}}
interface DbItem{receipt_id:string;channel_connection_id:string;provider:string;kind:string;occurred_at:Date;received_at:Date;eligible_units:EligibleRoutingUnit[]}
export async function listRoutingRequired(client:TenantQueryClient,input:{limit?:number;cursor?:string}):Promise<RoutingRequiredPage>{
  const limit=input.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("INVALID_PAGE_LIMIT");const anchor=cursor(input.cursor);
  const result=await client.query(`SELECT * FROM list_inbound_routing_required($1,$2::timestamptz,$3::uuid)`,
    [limit+1,anchor?.receivedAt??null,anchor?.id??null]) as {rows:DbItem[]};
  const page=result.rows.slice(0,limit);const items=page.map(row=>({receiptId:row.receipt_id,
    channelConnectionId:row.channel_connection_id,provider:row.provider,kind:row.kind,occurredAt:new Date(row.occurred_at),
    receivedAt:new Date(row.received_at),eligibleUnits:row.eligible_units,
    allowedActions:(row.eligible_units.length?["RESOLVE"]:[]) as readonly("RESOLVE")[]}));
  const last=page.at(-1);return {items,...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:1,
    receivedAt:new Date(last.received_at).toISOString(),id:last.receipt_id})).toString("base64url")}:{})};
}
export async function resolveRoutingRequired(client:TenantQueryClient,input:{receiptId:string;unitId:string;idempotencyKey:string}){
  if(!UUID.test(input.receiptId)||!UUID.test(input.unitId))throw new Error("INVALID_INBOUND_ROUTING_REQUEST");
  const key=input.idempotencyKey.trim();if(key!==input.idempotencyKey||key.length<8||key.length>200)throw new Error("INVALID_IDEMPOTENCY_KEY");
  const fingerprint=createHash("sha256").update(`${input.receiptId}\0${input.unitId}`).digest("hex");
  const result=await client.query(`SELECT receipt_id AS "receiptId",unit_id AS "unitId",outbox_id AS "outboxId",replayed
    FROM resolve_inbound_routing_required($1,$2,$3,$4)`,[input.receiptId,input.unitId,key,fingerprint]) as
    {rows:{receiptId:string;unitId:string;outboxId:string;replayed:boolean}[]};
  if(result.rows.length!==1)throw new Error("INBOUND_ROUTING_FAILED");return result.rows[0]!;
}
