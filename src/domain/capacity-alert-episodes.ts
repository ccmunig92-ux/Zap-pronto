import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export type CapacityAlertEpisodeStatus="OPEN"|"ACKNOWLEDGED"|"ESCALATED"|"RESOLVED";
export interface CapacityAlertEpisode{episodeId:string;unitId:string;policyVersion:number;status:CapacityAlertEpisodeStatus;
  openedAt:Date;lastEvaluatedAt:Date;cooldownUntil:Date;escalationLevel:number;acknowledgedAt:Date|null;
  acknowledgedByUserId:string|null;acknowledgementReason:string|null;escalatedAt:Date|null;closedAt:Date|null;
  version:number;recipientCount:number}
export interface ListCapacityAlertEpisodesInput{unitId:string;status?:CapacityAlertEpisodeStatus;pageSize?:number}
export interface AcknowledgeCapacityAlertEpisodeInput{episodeId:string;expectedVersion:number;reason:string;idempotencyKey:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses:readonly string[]=["OPEN","ACKNOWLEDGED","ESCALATED","RESOLVED"];
function normalizedUuid(value:string,code:string){const normalized=value.trim().toLowerCase();if(!UUID.test(normalized))throw new Error(code);return normalized}
export async function listCapacityAlertEpisodes(client:TenantQueryClient,input:ListCapacityAlertEpisodesInput):Promise<{items:CapacityAlertEpisode[]}> {
  const unitId=normalizedUuid(input.unitId,"INVALID_CAPACITY_ALERT_EPISODE_LIST_REQUEST"),pageSize=input.pageSize??25;
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||(input.status!==undefined&&!statuses.includes(input.status)))throw new Error("INVALID_CAPACITY_ALERT_EPISODE_LIST_REQUEST");
  const result=await client.query(`SELECT episode_id AS "episodeId",unit_id AS "unitId",policy_version AS "policyVersion",status,
    opened_at AS "openedAt",last_evaluated_at AS "lastEvaluatedAt",cooldown_until AS "cooldownUntil",escalation_level AS "escalationLevel",
    acknowledged_at AS "acknowledgedAt",acknowledged_by_user_id AS "acknowledgedByUserId",acknowledgement_reason AS "acknowledgementReason",
    escalated_at AS "escalatedAt",closed_at AS "closedAt",version,recipient_count AS "recipientCount"
    FROM list_unit_capacity_alert_episodes($1,$2,$3)`,[unitId,input.status??null,pageSize]) as{rows:CapacityAlertEpisode[]};
  return{items:result.rows};
}
export async function resolveCapacityAlertEpisodeUnit(client:TenantQueryClient,episodeId:string):Promise<string>{
  const id=normalizedUuid(episodeId,"CAPACITY_ALERT_EPISODE_NOT_FOUND");
  const result=await client.query(`SELECT unit_id AS "unitId" FROM resolve_unit_capacity_alert_episode($1)`,[id]) as{rows:Array<{unitId:string}>};
  const value=result.rows[0]?.unitId;if(!value)throw new Error("CAPACITY_ALERT_EPISODE_NOT_FOUND");return value;
}
export function capacityAlertEpisodeAcknowledgementFingerprint(input:{episodeId:string;expectedVersion:number;reason:string}){
  const episodeId=normalizedUuid(input.episodeId,"INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT");
  if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error("INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT");
  const reason=input.reason.trim();if(reason.length<3||reason.length>500)throw new Error("INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT");
  return createHash("sha256").update(`{"expectedVersion":${input.expectedVersion},"episodeId":"${episodeId}","reason":"${reason.replaceAll('"','\\"')}"}`).digest("hex");
}
export async function acknowledgeCapacityAlertEpisode(client:TenantQueryClient,input:AcknowledgeCapacityAlertEpisodeInput){
  const episodeId=normalizedUuid(input.episodeId,"INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT"),key=input.idempotencyKey.trim(),reason=input.reason.trim();
  if(key.length<8||key.length>200)throw new Error("INVALID_CAPACITY_ALERT_EPISODE_ACKNOWLEDGEMENT");
  const result=await client.query(`SELECT episode_id AS "episodeId",status,acknowledged_at AS "acknowledgedAt",
    acknowledged_by_user_id AS "acknowledgedByUserId",version,replayed
    FROM acknowledge_capacity_alert_episode($1,$2,$3,$4,$5)`,[episodeId,input.expectedVersion,reason,key,
      capacityAlertEpisodeAcknowledgementFingerprint({episodeId,expectedVersion:input.expectedVersion,reason})]) as{rows:Array<{episodeId:string;status:CapacityAlertEpisodeStatus;acknowledgedAt:Date;acknowledgedByUserId:string;version:number;replayed:boolean}>};
  return result.rows[0]!;
}
