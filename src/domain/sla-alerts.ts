import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export type SlaAlertStatus="MISSING_SLA"|"DUE_SOON"|"OVERDUE";
export type HandoffPriority="LOW"|"NORMAL"|"HIGH"|"URGENT";
export interface SlaAlertItem{handoffId:string;unitId:string;priority:HandoffPriority;slaStatus:SlaAlertStatus;
  slaDueAt:Date|null;queuedAt:Date;ageSeconds:number;availableCapacity:number;acknowledgedAt:Date|null;
  acknowledgementVersion:number|null}
type Cursor={v:1;unitId:string;slaStatus:SlaAlertStatus|null;priority:HandoffPriority|null;asOf:string;
  alertRank:number;priorityRank:number;slaDueAt:string|null;queuedAt:string;id:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses:readonly string[]=["MISSING_SLA","DUE_SOON","OVERDUE"],priorities:readonly string[]=["LOW","NORMAL","HIGH","URGENT"];
const rankStatus=(status:SlaAlertStatus)=>status==="OVERDUE"?1:status==="MISSING_SLA"?2:3;
const rankPriority=(priority:HandoffPriority)=>priority==="URGENT"?1:priority==="HIGH"?2:priority==="NORMAL"?3:4;
const encode=(value:Cursor)=>Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value:string):Cursor{try{const parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8")) as Cursor;
  if(parsed.v!==1||!UUID.test(parsed.unitId)||!UUID.test(parsed.id)||!statuses.includes(String(parsed.slaStatus))&&parsed.slaStatus!==null
    ||!priorities.includes(String(parsed.priority))&&parsed.priority!==null||!Number.isInteger(parsed.alertRank)||!Number.isInteger(parsed.priorityRank)
    ||!Number.isFinite(Date.parse(parsed.asOf))||!Number.isFinite(Date.parse(parsed.queuedAt))
    ||(parsed.slaDueAt!==null&&!Number.isFinite(Date.parse(parsed.slaDueAt))))throw new Error();return parsed;}catch{throw new Error("INVALID_PAGE_CURSOR");}}
export async function listSlaAlerts(client:TenantQueryClient,input:{unitId:string;pageSize?:number;slaStatus?:SlaAlertStatus;
  priority?:HandoffPriority;asOf?:Date;cursor?:string}){
  const pageSize=input.pageSize??25;if(!UUID.test(input.unitId)||!Number.isInteger(pageSize)||pageSize<1||pageSize>100
    ||(input.asOf!==undefined&&!Number.isFinite(input.asOf.getTime()))||(input.slaStatus&&!statuses.includes(input.slaStatus))
    ||(input.priority&&!priorities.includes(input.priority)))throw new Error("INVALID_SLA_ALERT_LIST_REQUEST");
  const cursor=input.cursor?decode(input.cursor):null,asOf=cursor?.asOf??(input.asOf??new Date()).toISOString();
  if(cursor&&(cursor.unitId!==input.unitId.toLowerCase()||cursor.slaStatus!==(input.slaStatus??null)
    ||cursor.priority!==(input.priority??null)))throw new Error("INVALID_PAGE_CURSOR");
  const result=await client.query(`SELECT handoff_id AS "handoffId",unit_id AS "unitId",priority,sla_status AS "slaStatus",
    sla_due_at AS "slaDueAt",queued_at AS "queuedAt",age_seconds AS "ageSeconds",available_capacity AS "availableCapacity",
    acknowledged_at AS "acknowledgedAt",acknowledgement_version AS "acknowledgementVersion"
    FROM list_inbox_sla_alerts($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.unitId,pageSize+1,input.slaStatus??null,
    input.priority??null,asOf,cursor?.alertRank??null,cursor?.priorityRank??null,cursor?.slaDueAt??null,
    cursor?.queuedAt??null,cursor?.id??null]) as {rows:SlaAlertItem[]};
  const hasMore=result.rows.length>pageSize,items=result.rows.slice(0,pageSize),last=items.at(-1);
  return{items,nextCursor:hasMore&&last?encode({v:1,unitId:input.unitId.toLowerCase(),slaStatus:input.slaStatus??null,
    priority:input.priority??null,asOf,alertRank:rankStatus(last.slaStatus),priorityRank:rankPriority(last.priority),
    slaDueAt:last.slaDueAt?.toISOString()??null,queuedAt:last.queuedAt.toISOString(),id:last.handoffId}):null,asOf};
}
export function slaAlertAcknowledgementFingerprint(input:{handoffId:string;expectedVersion:number}){
  return createHash("sha256").update(`{"expectedVersion":${input.expectedVersion},"handoffId":"${input.handoffId.toLowerCase()}"}`).digest("hex");}
export async function acknowledgeSlaAlert(client:TenantQueryClient,input:{handoffId:string;expectedVersion:number;idempotencyKey:string}){
  const key=input.idempotencyKey.trim();if(!UUID.test(input.handoffId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1
    ||key.length<8||key.length>200)throw new Error("INVALID_SLA_ALERT_ACKNOWLEDGEMENT_REQUEST");
  const result=await client.query(`SELECT handoff_id AS "handoffId",unit_id AS "unitId",acknowledged_at AS "acknowledgedAt",
    acknowledged_by_user_id AS "acknowledgedByUserId",version,replayed FROM acknowledge_inbox_sla_alert($1,$2,$3,$4)`,
  [input.handoffId,input.expectedVersion,key,slaAlertAcknowledgementFingerprint(input)]) as {rows:Array<{handoffId:string;unitId:string;
    acknowledgedAt:Date;acknowledgedByUserId:string;version:number;replayed:boolean}>};return result.rows[0]!;}
