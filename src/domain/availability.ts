import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export type AvailabilityStatus="OFFLINE"|"AVAILABLE"|"PAUSED";
export type AvailabilityPauseReason="BREAK"|"TRAINING"|"MEETING"|"OTHER_OPERATIONAL";
export interface ActorUnitAvailability{unitId:string;userId:string;status:AvailabilityStatus;maxActive:number;pauseReason:AvailabilityPauseReason|null;pausedUntil:Date|null;activeCount:number;version:number;updatedAt:Date;replayed?:boolean}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function availabilityFingerprint(input:{unitId:string;status:AvailabilityStatus;maxActive:number;pauseReason:AvailabilityPauseReason|null;pausedUntil:Date|null;expectedVersion:number}){
  return createHash("sha256").update(JSON.stringify({expectedVersion:input.expectedVersion,maxActive:input.maxActive,pauseReason:input.pauseReason,
    pausedUntil:input.pausedUntil?.toISOString()??null,status:input.status,unitId:input.unitId.toLowerCase()})).digest("hex");
}
export async function getActorUnitAvailability(client:TenantQueryClient,unitId:string){if(!UUID.test(unitId))throw new Error("INVALID_AVAILABILITY_REQUEST");
  const result=await client.query(`SELECT unit_id AS "unitId",user_id AS "userId",status,max_active AS "maxActive",pause_reason AS "pauseReason",
    paused_until AS "pausedUntil",active_count::integer AS "activeCount",version,updated_at AS "updatedAt" FROM get_actor_unit_availability($1)`,[unitId]) as{rows:ActorUnitAvailability[]};
  return result.rows[0]??null;}
export async function setActorUnitAvailability(client:TenantQueryClient,input:{unitId:string;status:AvailabilityStatus;maxActive:number;pauseReason:AvailabilityPauseReason|null;pausedUntil:Date|null;expectedVersion:number;idempotencyKey:string}){
  const key=input.idempotencyKey.trim(),statuses:readonly string[]=["OFFLINE","AVAILABLE","PAUSED"],reasons:readonly string[]=["BREAK","TRAINING","MEETING","OTHER_OPERATIONAL"];
  if(!UUID.test(input.unitId)||!statuses.includes(input.status)||!Number.isInteger(input.maxActive)||input.maxActive<1||input.maxActive>100
    ||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1||key.length<8||key.length>200
    ||(input.status==="PAUSED"&&(!input.pauseReason||!reasons.includes(input.pauseReason)))
    ||(input.status!=="PAUSED"&&(input.pauseReason!==null||input.pausedUntil!==null))
    ||(input.pausedUntil!==null&&(!Number.isFinite(input.pausedUntil.getTime())||input.pausedUntil.getTime()<=Date.now())))throw new Error("INVALID_AVAILABILITY_REQUEST");
  const fingerprint=availabilityFingerprint(input);const result=await client.query(`SELECT unit_id AS "unitId",user_id AS "userId",status,max_active AS "maxActive",
    pause_reason AS "pauseReason",paused_until AS "pausedUntil",active_count::integer AS "activeCount",version,updated_at AS "updatedAt",replayed
    FROM set_actor_unit_availability($1,$2,$3,$4,$5,$6,$7,$8)`,[input.unitId,input.status,input.maxActive,input.pauseReason,input.pausedUntil?.toISOString()??null,input.expectedVersion,key,fingerprint]) as{rows:ActorUnitAvailability[]};return result.rows[0]!;}
