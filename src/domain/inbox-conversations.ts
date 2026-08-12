import type { TenantQueryClient } from "../database/tenant-transaction.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL=/^[A-Za-z0-9_-]+$/;const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export interface ConversationDetail{conversationId:string;unitId:string;channelConnectionId:string;status:string;automationStatus:string;
  assignedUserId:string|null;version:number;updatedAt:Date;stateChangedAt:Date;closedAt:Date|null;displayName:string|null;allowedActions:readonly string[];
  claimTarget:{handoffId:string;expectedVersion:number}|null;sendTextTarget:{expectedConversationVersion:number}|null;
  resolveTarget:{handoffId:string;expectedVersion:number}|null;requeueTarget:{handoffId:string;expectedVersion:number}|null;transferTarget:{handoffId:string;expectedVersion:number}|null;
  takeoverTarget:{handoffId:string;expectedVersion:number}|null}
export interface ConversationMessage{id:string;direction:string;actor:string;body:string|null;kind:string;trust:string|null;deliveryStatus:string|null;cancelQueued:boolean;allowedActions:readonly string[];createdAt:Date}
interface Cursor{createdAt:string;id:string;conversationId:string;before:string|null}
function cursor(value:string|undefined,conversationId:string,before:string|null):Cursor|null{if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_PAGE_CURSOR");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();const x=JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="before,conversationId,createdAt,id,v"||x.v!==2||x.conversationId!==conversationId||x.before!==before||typeof x.id!=="string"||!UUID.test(x.id)
      ||typeof x.createdAt!=="string"||!ISO.test(x.createdAt)||new Date(x.createdAt).toISOString()!==x.createdAt)throw new Error();
    return{conversationId,createdAt:x.createdAt,id:x.id,before};}catch{throw new Error("INVALID_PAGE_CURSOR")}}
export async function getConversation(client:TenantQueryClient,id:string):Promise<ConversationDetail>{if(!UUID.test(id))throw new Error("INVALID_CONVERSATION_ID");
  const result=await client.query(`SELECT conversation_id AS "conversationId",unit_id AS "unitId",channel_connection_id AS "channelConnectionId",status,
    automation_status AS "automationStatus",assigned_user_id AS "assignedUserId",version,updated_at AS "updatedAt",state_changed_at AS "stateChangedAt",
    closed_at AS "closedAt",display_name AS "displayName",
    (CASE WHEN requeue_target.handoff_id IS NOT NULL THEN array_append(
      CASE WHEN resolve_target.handoff_id IS NULL THEN
      CASE WHEN send_target.expected_conversation_version IS NULL THEN allowed_actions ELSE array_append(allowed_actions,'SEND_TEXT') END
      ELSE array_append(CASE WHEN send_target.expected_conversation_version IS NULL THEN allowed_actions ELSE array_append(allowed_actions,'SEND_TEXT') END,'RESOLVE_HANDOFF') END,
      'REQUEUE_HANDOFF') ELSE CASE WHEN resolve_target.handoff_id IS NULL THEN
      CASE WHEN send_target.expected_conversation_version IS NULL THEN allowed_actions ELSE array_append(allowed_actions,'SEND_TEXT') END
      ELSE array_append(CASE WHEN send_target.expected_conversation_version IS NULL THEN allowed_actions ELSE array_append(allowed_actions,'SEND_TEXT') END,'RESOLVE_HANDOFF') END END
      || CASE WHEN transfer_target.handoff_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY['TRANSFER_HANDOFF']::text[] END
      || CASE WHEN takeover_target.handoff_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY['TAKEOVER_HANDOFF']::text[] END) AS "allowedActions",
    CASE WHEN claim_target.handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',claim_target.handoff_id,'expectedVersion',claim_target.expected_version) END AS "claimTarget",
    CASE WHEN send_target.expected_conversation_version IS NULL THEN NULL ELSE jsonb_build_object('expectedConversationVersion',send_target.expected_conversation_version) END AS "sendTextTarget",
    CASE WHEN resolve_target.handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',resolve_target.handoff_id,'expectedVersion',resolve_target.expected_version) END AS "resolveTarget",
    CASE WHEN requeue_target.handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',requeue_target.handoff_id,'expectedVersion',requeue_target.expected_version) END AS "requeueTarget",
    CASE WHEN transfer_target.handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',transfer_target.handoff_id,'expectedVersion',transfer_target.expected_version) END AS "transferTarget",
    CASE WHEN takeover_target.handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',takeover_target.handoff_id,'expectedVersion',takeover_target.expected_version) END AS "takeoverTarget"
    FROM get_inbox_conversation($1) detail LEFT JOIN LATERAL get_inbox_conversation_claim_target($1) claim_target ON true
    LEFT JOIN LATERAL get_inbox_conversation_send_target($1) send_target ON true
    LEFT JOIN LATERAL get_inbox_conversation_resolve_target($1) resolve_target ON true
    LEFT JOIN LATERAL get_inbox_conversation_requeue_target($1) requeue_target ON true
    LEFT JOIN LATERAL get_inbox_conversation_transfer_target($1) transfer_target ON true
    LEFT JOIN LATERAL get_inbox_conversation_takeover_target($1) takeover_target ON true`,[id]) as{rows:ConversationDetail[]};const row=result.rows[0];if(!row)throw new Error("INBOX_CONVERSATION_NOT_FOUND");return row;}
export async function listConversationMessages(client:TenantQueryClient,input:{conversationId:string;limit?:number;cursor?:string;before?:string}){
  if(!UUID.test(input.conversationId))throw new Error("INVALID_CONVERSATION_ID");const limit=input.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("INVALID_PAGE_LIMIT");
  let before:string|null=null;if(input.before!==undefined){const instant=new Date(input.before);if(!Number.isFinite(instant.getTime()))throw new Error("INVALID_MESSAGE_BEFORE");before=instant.toISOString();}
  const anchor=cursor(input.cursor,input.conversationId,before);const result=await client.query(`SELECT id,direction,actor,body,kind,trust,delivery_status AS "deliveryStatus",cancel_queued AS "cancelQueued",created_at AS "createdAt"
    FROM list_inbox_conversation_messages_v4($1,$2,$3,$4,$5)`,
    [input.conversationId,limit,anchor?.createdAt??null,anchor?.id??null,before]) as{rows:ConversationMessage[]};const rows=result.rows.slice(0,limit),last=rows.at(-1);
  return{items:rows.map(row=>({...row,allowedActions:row.cancelQueued?["CANCEL_QUEUED"]:[]})),...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:2,conversationId:input.conversationId,before,
    createdAt:new Date(last.createdAt).toISOString(),id:last.id})).toString("base64url")}:{})};}
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f]/;
export function normalizeHumanTextBody(value:string):string{if(typeof value!=="string"||CONTROL.test(value))throw new Error("INVALID_MESSAGE_BODY");
  const normalized=value.replace(/^[ \t\n]+|[ \t\n]+$/gu,"");if(Array.from(normalized).length<1||Array.from(normalized).length>4096)throw new Error("INVALID_MESSAGE_BODY");return normalized;}
export async function sendHumanTextMessage(client:TenantQueryClient,input:{conversationId:string;expectedConversationVersion:number;body:string;idempotencyKey:string}){
  if(!UUID.test(input.conversationId))throw new Error("INVALID_CONVERSATION_ID");if(!Number.isInteger(input.expectedConversationVersion)||input.expectedConversationVersion<1)throw new Error("INVALID_EXPECTED_VERSION");
  const key=input.idempotencyKey.trim();if(key.length<8||key.length>200)throw new Error("INVALID_IDEMPOTENCY_KEY");const body=normalizeHumanTextBody(input.body);
  const result=await client.query(`SELECT message_id AS "messageId",conversation_version AS "conversationVersion",delivery_status AS "deliveryStatus",replayed
    FROM send_human_text_message($1,$2,$3,$4)`,[input.conversationId,input.expectedConversationVersion,body,key]) as{rows:{messageId:string;conversationVersion:number;deliveryStatus:"QUEUED";replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("MESSAGE_SEND_FAILED");return row;}
export async function cancelHumanTextMessage(client:TenantQueryClient,input:{conversationId:string;messageId:string;expectedConversationVersion:number;idempotencyKey:string}){
  if(!UUID.test(input.conversationId)||!UUID.test(input.messageId))throw new Error("INVALID_MESSAGE_ID");
  if(!Number.isInteger(input.expectedConversationVersion)||input.expectedConversationVersion<1)throw new Error("INVALID_EXPECTED_VERSION");
  const key=input.idempotencyKey.trim();if(key.length<8||key.length>200)throw new Error("INVALID_IDEMPOTENCY_KEY");
  const result=await client.query(`SELECT message_id AS "messageId",conversation_version AS "conversationVersion",delivery_status AS "deliveryStatus",replayed
    FROM cancel_human_text_message($1,$2,$3,$4)`,[input.conversationId,input.messageId,input.expectedConversationVersion,key]) as{rows:{messageId:string;conversationVersion:number;deliveryStatus:"CANCELLED";replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("MESSAGE_CANCEL_FAILED");return row;}
